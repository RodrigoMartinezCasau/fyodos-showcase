/**
 * Layer 1b — per-file AST extraction using the real TypeScript compiler
 * (no regexes). For each source file we extract:
 *
 *  - handlers: function declarations / consts named handle* | on*
 *  - navCalls: router.push / router.replace / router.navigate / router.back
 *    with their literal or object destinations
 *  - alerts: Alert.alert(title, message, buttons) + whether any button is
 *    style:'destructive' and the texts involved
 *  - storeActions: Zustand create()(…) — function-valued properties of the
 *    store object (the store's action surface)
 *  - buttons: JSX elements with a title/label prop and an onPress handler
 *  - textInputs: JSX TextInput-ish elements (signals form/typed input)
 *  - imports: module specifiers + named/default bindings
 *  - linkingCalls: Linking.openURL targets (tel:, maps, web)
 *
 * Everything returned here has provenance "static".
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Load the TypeScript compiler (real parser, real AST). `typescript` is a
// declared dependency of this package, so when the CLI is installed from npm
// (or run via `npx`) it resolves from the CLI's own node_modules. The monorepo
// path is only a dev-time fallback for the hoisted workspace install.
const ts = loadTypeScript();

function loadTypeScript() {
  try {
    // Installed/npx case: resolves from @fiodos/cli's node_modules.
    return require('typescript');
  } catch {
    // Monorepo dev fallback: TypeScript is hoisted to the repo root.
    try {
      return require(path.join(__dirname, '../../../node_modules/typescript'));
    } catch (e) {
      throw new Error(
        'Fiodos CLI could not load its TypeScript dependency. This usually means ' +
        'a corrupted install — try `npm cache clean --force` and re-run, or reinstall ' +
        `@fiodos/cli. Original error: ${e.message}`,
      );
    }
  }
}

function parseFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    // `/exercise-detail?id=${x}` → '/exercise-detail?id=${…}'
    let out = node.head.text;
    for (const span of node.templateSpans) out += '${…}' + span.literal.text;
    return out;
  }
  return null;
}

function nameOfFunctionLike(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const init = node.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return node.name.text;
    // useCallback(fn, deps)
    if (init && ts.isCallExpression(init) && init.arguments.length > 0) {
      const a0 = init.arguments[0];
      if (ts.isArrowFunction(a0) || ts.isFunctionExpression(a0)) return node.name.text;
    }
  }
  return null;
}

const HANDLER_RE = /^(handle|on)[A-Z]/;

function extractFromFile(filePath, appRoot) {
  const sf = parseFile(filePath);
  const rel = path.relative(appRoot, filePath);

  const out = {
    file: rel,
    handlers: [],
    navCalls: [],
    alerts: [],
    storeActions: [],
    storeStateKeys: [],
    storeName: null,
    buttons: [],
    textInputs: [],
    imports: [],
    linkingCalls: [],
    defaultExportName: null,
    // Internal navigation destinations referenced in this file (route strings):
    // <Link href|to>, <a href>, router.push/replace, navigate(), redirect().
    // Used by the surface-scoring layer to build the navigation reachability
    // graph (which screens are reachable from the deployed entry). External
    // links (http, mailto, tel, #anchors) are excluded.
    navTargets: [],
    // True when this file DEFINES the app's route table (react-router <Route>,
    // createBrowserRouter, Angular RouterModule.forRoot/provideRouter, Vue
    // createRouter). Such a file's links act as GLOBAL navigation (available
    // from any screen), unlike a per-section sidebar.
    routeHost: false,
    // Interactive LINK elements found in this file: <a href>, <Link href|to>,
    // window.open(...), Linking.openURL(...). Each is {target, kind, label}.
    // kind ∈ internal | external | store | anchor | mailto | tel. These feed the
    // analyzer so web "link/navigation actions" (download, contact, social,
    // jump-to-section, change-language-by-link) are detected with the href as
    // concrete, hallucination-proof evidence — not just state-mutating handlers.
    linkEls: [],
    // Soft signals that this file sits behind authentication (used ONLY to keep
    // an orphaned cluster ACTIVE — never to disable). Identifiers/paths that
    // commonly indicate an auth gate.
    authSignals: [],
  };

  // Collect an internal route string if it looks like an in-app path.
  function pushNavTarget(value) {
    if (!value || typeof value !== 'string') return;
    const v = value.trim();
    if (!v) return;
    // Only same-app paths. Drop external/protocol/anchor/empty targets.
    if (!v.startsWith('/')) return;
    if (v.startsWith('//')) return; // protocol-relative external
    out.navTargets.push(v);
  }

  // Classify a link/navigation target for the analyzer hint + link actions.
  function classifyLink(value) {
    if (!value || typeof value !== 'string') return null;
    const v = value.trim();
    if (!v || v === '#') return null;
    if (/^mailto:/i.test(v)) return { target: v, kind: 'mailto' };
    if (/^tel:/i.test(v)) return { target: v, kind: 'tel' };
    if (v.startsWith('#')) return { target: v, kind: 'anchor' };
    if (/^https?:\/\//i.test(v) || v.startsWith('//')) {
      const store = /(apps\.apple\.com|itunes\.apple\.com|play\.google\.com|testflight)/i.test(v);
      return { target: v, kind: store ? 'store' : 'external' };
    }
    if (v.startsWith('/')) return { target: v, kind: 'internal' };
    // Template/expression placeholders (e.g. `#${id}`) or unknown — skip as a
    // concrete link (no verifiable literal href).
    return null;
  }

  function pushLink(value, label) {
    const c = classifyLink(value);
    if (!c) return;
    out.linkEls.push({ target: c.target, kind: c.kind, label: label || null, file: rel });
  }

  // GATING constructs only (a redirect/block when unauthenticated) — NOT mere
  // session reading (useUser/useSession): reading the user does not gate access,
  // and counting it would wrongly protect public-but-orphaned pages from being
  // disabled. Used solely to KEEP an orphaned cluster active (SaaS guard).
  const AUTH_HINT_RE =
    /(requireAuth|withAuth|ProtectedRoute|RequireAuth|AuthGuard|authGuard|ensureAuth|canActivate|redirectToLogin|RedirectToSignIn|SignedOut)/;
  const AUTH_PATH_RE = /\/(login|signin|sign-in|sign_in)\b/i;

  function jsxAttr(attrs, names) {
    for (const attr of attrs.properties) {
      if (ts.isJsxAttribute(attr) && names.includes(attr.name.getText())) {
        if (attr.initializer && ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
        if (attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
          const lit = literalText(attr.initializer.expression);
          if (lit) return lit;
          return attr.initializer.expression.getText().slice(0, 80);
        }
      }
    }
    return null;
  }

  function jsxAttrHandlerName(attrs, names) {
    for (const attr of attrs.properties) {
      if (ts.isJsxAttribute(attr) && names.includes(attr.name.getText())) {
        const init = attr.initializer;
        if (init && ts.isJsxExpression(init) && init.expression) {
          const e = init.expression;
          if (ts.isIdentifier(e)) return e.text;
          if (ts.isArrowFunction(e) && ts.isCallExpression(e.body)) {
            return e.body.expression.getText();
          }
          return e.getText().slice(0, 60);
        }
      }
    }
    return null;
  }

  function visit(node) {
    // imports
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = [];
      const clause = node.importClause;
      if (clause) {
        if (clause.name) names.push(clause.name.text);
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) names.push(el.name.text);
        }
      }
      out.imports.push({ from: node.moduleSpecifier.text, names });
      for (const n of names) {
        if (AUTH_HINT_RE.test(n)) out.authSignals.push(n);
      }
      if (AUTH_PATH_RE.test(node.moduleSpecifier.text)) out.authSignals.push(node.moduleSpecifier.text);
    }

    // default export name (screen component)
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
      out.defaultExportName = node.expression.text;
    }
    if (ts.isFunctionDeclaration(node) && node.name &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      out.defaultExportName = node.name.text;
    }

    // handler functions
    const fnName = nameOfFunctionLike(node);
    if (fnName && HANDLER_RE.test(fnName)) {
      out.handlers.push({ name: fnName, file: rel });
    }

    // call expressions: router.*, Alert.alert, Linking.openURL, zustand create
    if (ts.isCallExpression(node)) {
      const exprText = node.expression.getText();

      // router.push / replace / navigate / back  (covers `router.` and bare `push(` from useRouter destructuring is rare)
      const navMatch = exprText.match(/^(router|navigation)\.(push|replace|navigate|back|goBack)$/);
      if (navMatch) {
        const verb = navMatch[2];
        let target = null;
        const a0 = node.arguments[0];
        if (a0) {
          target = literalText(a0);
          if (!target && ts.isObjectLiteralExpression(a0)) {
            for (const p of a0.properties) {
              if (ts.isPropertyAssignment(p) && p.name.getText() === 'pathname') {
                target = literalText(p.initializer) || p.initializer.getText();
              }
            }
          }
        }
        out.navCalls.push({ verb, target, file: rel });
        if (verb !== 'back' && verb !== 'goBack') pushNavTarget(target);
      }

      // Next.js / framework redirects: redirect('/x'), permanentRedirect('/x').
      if (/^(redirect|permanentRedirect)$/.test(exprText) && node.arguments[0]) {
        pushNavTarget(literalText(node.arguments[0]));
      }
      // react-router imperative: navigate('/x') / history.push('/x').
      if (/(^|\.)navigate$/.test(exprText) && node.arguments[0]) {
        pushNavTarget(literalText(node.arguments[0]));
      }
      // Bare push('/x') from a destructured useRouter()/useNavigate() hook.
      if (exprText === 'push' && node.arguments[0]) {
        pushNavTarget(literalText(node.arguments[0]));
      }
      // Route-table definitions → this file's links are GLOBAL navigation.
      if (/^(createBrowserRouter|createHashRouter|createMemoryRouter|createRouter)$/.test(exprText)) {
        out.routeHost = true;
      }
      if (/\.(forRoot|forChild)$/.test(exprText) || /^provideRouter$/.test(exprText)) {
        out.routeHost = true;
      }

      // Auth gate by call: redirect('/login') etc. is captured above as a nav
      // target; also flag it as an auth signal when the path looks like a gate.
      if (/^(redirect|replace|push)$/.test(exprText.split('.').pop() || '') && node.arguments[0]) {
        const t = literalText(node.arguments[0]);
        if (t && AUTH_PATH_RE.test(t)) out.authSignals.push(t);
      }

      // Alert.alert(title, message?, buttons?)
      if (exprText === 'Alert.alert') {
        const title = literalText(node.arguments[0]) || '';
        const message = literalText(node.arguments[1]) || '';
        let destructive = false;
        const buttonTexts = [];
        const a2 = node.arguments[2];
        if (a2 && ts.isArrayLiteralExpression(a2)) {
          for (const el of a2.elements) {
            if (!ts.isObjectLiteralExpression(el)) continue;
            for (const p of el.properties) {
              if (!ts.isPropertyAssignment(p)) continue;
              const key = p.name.getText();
              if (key === 'style' && literalText(p.initializer) === 'destructive') destructive = true;
              if (key === 'text') {
                const t = literalText(p.initializer);
                if (t) buttonTexts.push(t);
              }
            }
          }
        }
        out.alerts.push({ title, message, destructive, buttonTexts, file: rel });
      }

      // Linking.openURL(...)
      if (/^Linking\.(openURL|canOpenURL)$/.test(exprText) && node.arguments[0]) {
        const t = literalText(node.arguments[0]) || node.arguments[0].getText().slice(0, 60);
        out.linkingCalls.push({ target: t, file: rel });
        pushLink(literalText(node.arguments[0]));
      }

      // window.open(url, ...) / window.location.assign(url) — web external nav.
      if (/^(window\.open|window\.location\.assign|window\.location\.replace|location\.assign|location\.replace)$/.test(exprText) && node.arguments[0]) {
        pushLink(literalText(node.arguments[0]));
      }

      // Zustand: create<T>()(persist((set) => ({...}))) or create((set) => ({...}))
      if (/^create(<.*>)?$/.test(exprText.split('(')[0]) && exprText.startsWith('create')) {
        const storeObj = findStoreObject(node);
        if (storeObj) {
          for (const p of storeObj.properties) {
            if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p) && !ts.isMethodDeclaration(p)) continue;
            const key = p.name?.getText();
            if (!key) continue;
            const val = ts.isPropertyAssignment(p) ? p.initializer : null;
            const isFn = ts.isMethodDeclaration(p) ||
              (val && (ts.isArrowFunction(val) || ts.isFunctionExpression(val)));
            if (isFn) out.storeActions.push({ name: key, file: rel });
            else out.storeStateKeys.push(key);
          }
        }
      }
    }

    // exported const useXxxStore = create(...)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        /use[A-Z].*Store/.test(node.name.text)) {
      out.storeName = node.name.text;
    }

    // JSX buttons + inputs
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText();
      const attrs = node.attributes;
      // Any element carrying an internal route via href/to (next/link <Link>,
      // <a href>, react-router <Link to>/<Navigate to>/<Redirect to>).
      const linkTarget = jsxAttr(attrs, ['href', 'to']);
      if (linkTarget) {
        pushNavTarget(linkTarget);
        const label = jsxAttr(attrs, ['aria-label', 'title', 'download', 'alt']);
        pushLink(linkTarget, label);
      }
      // react-router <Route> table → global navigation host.
      if (tag === 'Route') out.routeHost = true;
      if (/Button/i.test(tag) || tag === 'TouchableOpacity' || tag === 'Pressable') {
        const title = jsxAttr(attrs, ['title', 'label', 'accessibilityLabel']);
        const handler = jsxAttrHandlerName(attrs, ['onPress']);
        if (title || handler) out.buttons.push({ tag, title, handler, file: rel });
      }
      if (/TextInput|Input/.test(tag)) {
        const placeholder = jsxAttr(attrs, ['placeholder']);
        const onChange = jsxAttrHandlerName(attrs, ['onChangeText', 'onChange']);
        out.textInputs.push({ tag, placeholder, onChange, file: rel });
      }
    }

    ts.forEachChild(node, visit);
  }

  // Finds the object literal returned by the store factory ((set) => ({...}))
  // possibly wrapped in persist()/devtools().
  function findStoreObject(callNode) {
    let found = null;
    function dig(n, depth) {
      if (found || depth > 8) return;
      if (ts.isArrowFunction(n)) {
        let body = n.body;
        if (ts.isParenthesizedExpression(body)) body = body.expression;
        if (ts.isObjectLiteralExpression(body)) {
          // Heuristic: the store object has at least one function property
          const hasFn = body.properties.some(
            (p) => ts.isPropertyAssignment(p) &&
              (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)),
          );
          if (hasFn) { found = body; return; }
        }
      }
      ts.forEachChild(n, (c) => dig(c, depth + 1));
    }
    dig(callNode, 0);
    return found;
  }

  visit(sf);
  return out;
}

module.exports = { extractFromFile };
