/**
 * Layer 2b — what each screen SAYS, harvested from the code that renders it.
 *
 * The manifest describes what a site can DO: screens and actions. That is not
 * the same as what a site says. An agent that knows every screen and not a
 * word of their copy can only route by the name of a section, which is how a
 * visitor asking for a specific thing lands on an approximate shelf while the
 * page that names their thing sits one click away.
 *
 * So, for every route the manifest already PROVED, this reads the visible copy
 * of the file that renders it (and of the local components that file renders),
 * and returns one content unit per screen. Three rules keep it honest:
 *
 * - only proved routes. A unit's url is a manifest route's url, never a path
 *   worked out from a filename, so a destination built from this cannot 404;
 * - only copy. JSX text, headings and visible labels; identifiers, imports,
 *   class names, urls and config strings are not things anybody reads;
 * - deterministic. Same source in, same units out, so re-analysing a site that
 *   did not change is not a rewrite of what the agent knows about it.
 *
 * Platform-specific harvests (a Shopify store publishes its content through an
 * API and does not need any of this) live server-side; this is the floor that
 * every other codebase gets.
 */
'use strict';

const path = require('path');

const ts = loadTypeScript();

function loadTypeScript() {
  try {
    return require('typescript');
  } catch {
    return require(path.join(__dirname, '../../../node_modules/typescript'));
  }
}

/** Copy is prose. One word with no space in it is a label at best. */
const MIN_PHRASE = 2;

/** A unit is a page, not a book: enough for any real screen, never a dump. */
const MAX_BODY = 20000;

/** How deep a screen's own components are followed. Deep enough for a page
 *  built out of sections, shallow enough not to swallow a design system. */
const MAX_DEPTH = 2;

const MARKUP_EXTENSIONS = new Set(['.liquid', '.html', '.htm', '.vue', '.svelte', '.md', '.mdx']);

function isReadablePhrase(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  // A url, a path, a css class list, an identifier or a token is written for a
  // machine. None of them is something a visitor reads and asks about.
  if (/^[a-z0-9_.-]+$/i.test(value) && !value.includes(' ')) return '';
  if (/^(https?:|\/|#|\.|@|data:|\{)/.test(value)) return '';
  if (!/[a-záéíóúñàèìòùäöüç]/i.test(value)) return '';
  if (value.split(' ').length < MIN_PHRASE && value.length < 12) return '';
  return value;
}

/** The visible text of markup, with block structure kept as line breaks. */
function markupText(source) {
  const withoutScripts = String(source || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/\{\%[\s\S]*?\%\}/g, ' ')
    .replace(/\{\{[\s\S]*?\}\}/g, ' ');
  const lines = withoutScripts
    .replace(/<\/(p|div|li|h[1-6]|section|tr|td|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .split('\n');
  return lines.map((line) => isReadablePhrase(line)).filter(Boolean);
}

/** The visible text of a component file, read from its real AST. */
function componentText(source, rel) {
  const file = ts.createSourceFile(rel, String(source || ''), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = [];
  const push = (value) => {
    const phrase = isReadablePhrase(value);
    if (phrase) lines.push(phrase);
  };

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      push(node.text);
    } else if (ts.isJsxAttribute(node)) {
      // A label, a title or a placeholder is copy; a className or an href is
      // not, and the attribute's own name is what tells them apart.
      const name = node.name && node.name.getText ? node.name.getText() : '';
      if (/^(title|label|placeholder|alt|aria-label|heading|subtitle|description)$/i.test(name)) {
        const value = node.initializer;
        if (value && ts.isStringLiteralLike(value)) push(value.text);
      }
    } else if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteralLike(node.expression)) {
      push(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

/** The local files a file renders, resolved against what was collected. */
function localImports(source, rel, byRel) {
  const file = ts.createSourceFile(rel, String(source || ''), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  ts.forEachChild(file, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    const spec = node.moduleSpecifier;
    if (!spec || !ts.isStringLiteralLike(spec)) return;
    const target = spec.text;
    if (!target.startsWith('.')) return; // a package is not this site's copy
    const resolved = resolveRel(path.posix.join(path.posix.dirname(rel), target), byRel);
    if (resolved) found.push(resolved);
  });
  return found;
}

function resolveRel(base, byRel) {
  const candidates = [
    base,
    ...['.tsx', '.ts', '.jsx', '.js', '.vue', '.svelte'].flatMap((ext) => [
      `${base}${ext}`,
      `${base}/index${ext}`,
    ]),
  ];
  return candidates.find((c) => byRel.has(c)) || '';
}

/** The file that renders a route: what the analysis proved, or the file whose
 *  own path is the route's path — in that order, never a guess beyond it. */
function fileForRoute(route, evidence, files, byRel) {
  const proved = ((evidence.routes || {})[route.intent] || {}).file;
  if (proved && byRel.has(proved)) return proved;
  const url = String(route.route || route.path || '').replace(/^\/+|\/+$/g, '');
  if (!url) {
    const index = files.find((f) => /(^|\/)(index|home|app)\.(t|j)sx?$/.test(f.rel));
    return index ? index.rel : '';
  }
  const last = url.split('/').pop();
  const match = files.find((f) => {
    const name = path.posix.basename(f.rel).replace(/\.[^.]+$/, '');
    return name === last || name === 'index' && path.posix.dirname(f.rel).endsWith(`/${last}`);
  });
  return match ? match.rel : '';
}

function readFile(entry, byRel, depth, seen) {
  if (!entry || seen.has(entry.rel) || depth > MAX_DEPTH) return [];
  seen.add(entry.rel);
  const ext = path.posix.extname(entry.rel).toLowerCase();
  if (MARKUP_EXTENSIONS.has(ext)) return markupText(entry.content);
  const lines = componentText(entry.content, entry.rel);
  for (const rel of localImports(entry.content, entry.rel, byRel)) {
    lines.push(...readFile(byRel.get(rel), byRel, depth + 1, seen));
  }
  return lines;
}

/**
 * One content unit per proved route, for the routes that actually say something.
 *
 * @param {object} input
 * @param {{rel: string, content: string}[]} input.files  what the collector read
 * @param {object} input.manifest                          the verified manifest
 * @param {object} [input.evidence]                        {routes: {intent: {file}}}
 * @returns {object[]} units in the shape the backend stores
 */
function harvestContentUnits({ files = [], manifest = {}, evidence = {} } = {}) {
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const units = [];
  for (const route of manifest.routes || []) {
    const intent = String(route.intent || '').trim();
    const url = String(route.route || route.path || '').trim();
    if (!intent || !url) continue;
    const rel = fileForRoute(route, evidence, files, byRel);
    if (!rel) continue;
    const lines = readFile(byRel.get(rel), byRel, 0, new Set());
    // Same phrase twice on a screen is one thing said once.
    const body = [...new Set(lines)].join('\n').slice(0, MAX_BODY);
    if (!body) continue;
    units.push({
      unitId: `route:${intent}`,
      kind: 'screen',
      handle: intent,
      url,
      routeIntent: intent,
      title: String(route.description || route.title || intent),
      body,
      facts: {},
      parents: [],
    });
  }
  return units;
}

module.exports = { harvestContentUnits };
