/**
 * Output verifier — the mechanical layer in its NEW role.
 *
 * The AI reads the code and proposes; this module confirms. It can only drop
 * an individual unproven claim — it can never blind the analysis (the old
 * candidate-gatekeeper failure mode).
 *
 * Checks per action:
 *   1. evidence file exists among the files sent to the model
 *   2. the handler (and evidence symbol) appears as a real identifier in that
 *      file — word-boundary match, so 'addToCart' can't pass via 'addToCartX'
 * Checks per route:
 *   3. the route href maps to a statically-scanned expo-router screen
 *      (or BACK, the SDK convention)
 *
 * Anything that fails is REMOVED from the manifest and recorded in
 * provenance as dropped. A hallucinated action that ships is worse than a
 * missed one.
 */
'use strict';

/** Extract candidate identifiers from an evidence symbol string.
 *  e.g. "useAuthStore (signOut action)" → ['useAuthStore', 'signOut'] */
function identifiersIn(text) {
  return String(text || '').match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || [];
}

function fileHasIdentifier(content, identifier) {
  if (!identifier) return false;
  const re = new RegExp(`(^|[^A-Za-z0-9_$])${identifier}([^A-Za-z0-9_$]|$)`);
  return re.test(content);
}

/** Normalize an expo-router href for comparison: strip (groups), trailing /index. */
function normalizeHref(href) {
  return ('/' + String(href || '')
    .replace(/\([^)]*\)\//g, '')
    .replace(/^\/+/, '')
    .replace(/\/index$/, ''))
    .replace(/\/+$/, '') || '/';
}

/**
 * @param manifest  manifest as the model produced it
 * @param evidence  { routes: {intent: {file, symbol}}, actions: {intent: {file, symbol, whatItDoes}} }
 * @param sentFiles array of { rel, content } that were in the prompt
 * @param staticRoutes array of { routePath, urlPath, relFile } from scanRoutes
 * @param opts.verifyRoutes  when false, AI-proposed routes are kept WITHOUT
 *        filesystem verification (web apps have no expo-router ground truth).
 *        Actions are always verified against real code regardless.
 *        Defaults to true when there is a static route ground truth.
 * @returns { manifest, provenance }
 */
function verifyManifest(manifest, evidence, sentFiles, staticRoutes, opts = {}) {
  const byRel = new Map(sentFiles.map((f) => [f.rel.replace(/\\/g, '/'), f.content]));
  const verifyRoutes = opts.verifyRoutes ?? staticRoutes.length > 0;
  const provenance = {
    engine: 'auto-manifest-v3-ai-first',
    routeVerification: verifyRoutes ? 'filesystem' : 'ai-proposed (no static ground truth)',
    routes: [],
    actions: [],
    notes: [],
  };

  const validHrefs = new Set();
  for (const r of staticRoutes) {
    validHrefs.add(normalizeHref(r.routePath));
    validHrefs.add(normalizeHref(r.urlPath));
  }

  const routes = [];
  for (const route of manifest.routes || []) {
    if (route.route === 'BACK') {
      routes.push(route);
      provenance.routes.push({ intent: route.intent, included: true, verification: 'static (SDK convention)' });
      continue;
    }
    // Web mode: no filesystem route ground truth, so we cannot statically
    // confirm routes. Keep what the AI proposed, but flag it as unverified —
    // honesty over false precision.
    if (!verifyRoutes) {
      routes.push(route);
      provenance.routes.push({
        intent: route.intent, included: true,
        verification: 'ai-proposed (route NOT statically verified — web app)',
        evidence: evidence.routes?.[route.intent] || null,
      });
      continue;
    }
    const ok = validHrefs.has(normalizeHref(route.route));
    if (!ok) {
      provenance.routes.push({
        intent: route.intent, included: false,
        reason: `route '${route.route}' not found in expo-router file scan — DROPPED`,
      });
      continue;
    }
    routes.push(route);
    provenance.routes.push({
      intent: route.intent, included: true,
      verification: 'route exists in filesystem scan',
      evidence: evidence.routes?.[route.intent] || null,
    });
  }

  const actions = [];
  for (const action of manifest.actions || []) {
    const ev = evidence.actions?.[action.intent] || {};
    const evFile = String(ev.file || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const content = byRel.get(evFile);

    if (!content) {
      provenance.actions.push({
        intent: action.intent, included: false,
        reason: `evidence file '${ev.file || '(none)'}' was not among the files sent — DROPPED`,
      });
      continue;
    }

    // The handler must be a real identifier in the evidence file. Also accept
    // any identifier from the symbol (covers "store.addItem"-style handlers).
    const candidates = [action.handler, ...identifiersIn(ev.symbol)].filter(Boolean);
    const found = candidates.find((c) => fileHasIdentifier(content, c));
    if (!found) {
      provenance.actions.push({
        intent: action.intent, included: false,
        reason: `neither handler '${action.handler}' nor symbol '${ev.symbol}' found in '${evFile}' — DROPPED`,
      });
      continue;
    }

    actions.push(action);
    provenance.actions.push({
      intent: action.intent, included: true,
      verification: `identifier '${found}' confirmed in ${evFile}`,
      evidence: ev,
    });
  }

  // Intent namespace is shared between routes and actions (core validator).
  const seen = new Set();
  const dedupedRoutes = routes.filter((r) => !seen.has(r.intent) && seen.add(r.intent));
  const dedupedActions = actions.filter((a) => {
    if (seen.has(a.intent)) {
      provenance.notes.push(`duplicate intent '${a.intent}' — kept first occurrence, action dropped`);
      return false;
    }
    seen.add(a.intent);
    return true;
  });

  // Schema coercion the model sometimes needs (same as the old engine).
  for (const action of dedupedActions) {
    for (const spec of Object.values(action.parameters || {})) {
      if (spec.type === 'integer' || spec.type === 'float') spec.type = 'number';
      else if (!['string', 'number', 'boolean'].includes(spec.type)) spec.type = 'string';
      if (typeof spec.required !== 'boolean') spec.required = false;
      if (typeof spec.description !== 'string' || !spec.description) spec.description = action.label || action.intent;
    }
    if (action.requireConfirmation && !action.confirmationMessageTemplate) {
      action.confirmationMessageTemplate = `Confirm: ${action.label || action.intent}?`;
      provenance.notes.push(`action '${action.intent}': confirmation template filled mechanically`);
    }
  }

  return {
    manifest: { ...manifest, routes: dedupedRoutes, actions: dedupedActions },
    provenance,
  };
}

module.exports = { verifyManifest, normalizeHref };
