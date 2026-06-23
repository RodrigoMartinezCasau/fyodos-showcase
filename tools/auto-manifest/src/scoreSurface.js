/**
 * Surface scoring — "does this route/action belong to the product surface the
 * developer wants the orb to expose?", separate from "does it exist in code?"
 * (that is the verifier's job, untouched here).
 *
 * The existence verifier guarantees every route/action is backed by real code.
 * But disorganized projects ship code that is NOT the live product surface:
 * dead screens, work-in-progress, or a whole secondary app mirrored inside the
 * web frontend (e.g. a marketing landing that also contains the full app under
 * route groups). The orb should not offer those by default.
 *
 * PRINCIPLE (decided product policy): we cannot read the developer's INTENT
 * from code alone (dead code and a brand-new feature look identical). So we
 * make a CONSERVATIVE automatic guess and pair it with cheap confirmation:
 *   - high confidence  → published ACTIVE (default-on).
 *   - low  confidence  → published DISABLED-by-default (still present, the dev
 *                        re-enables it in the dashboard with one click).
 * We never DROP anything (no new hallucination risk) and we FAIL TOWARDS
 * INCLUDING: anything uncertain stays ACTIVE. The only thing we turn off by
 * default is what is CLEARLY not the product:
 *   - a route whose screen is UNREACHABLE by navigation from the deployed
 *     public entry (orphan), AND
 *   - that shows NO sign of sitting behind authentication (so we never empty a
 *     login-gated SaaS — the auth guard), AND
 *   - only when the navigation graph is trustworthy enough to believe an orphan
 *     really is an orphan (else we disable nothing).
 *
 * SIGNAL: navigation reachability from the deployed entry, computed over the
 * project's import/navigation graph. Web-first (Next app/pages router, plus a
 * generic SPA route-host fallback). For platforms where reachability cannot be
 * computed confidently we return NO disables (fail towards including).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { extractFromFile } = require('./ast');
const { closure } = require('./graph');

const EXTS = ['.tsx', '.ts', '.jsx', '.js'];

/** Normalize an internal route string for matching (drop query/hash/trailing). */
function normUrl(p) {
  if (!p) return null;
  let s = String(p).split('?')[0].split('#')[0].trim();
  if (!s.startsWith('/')) return null;
  if (s.length > 1) s = s.replace(/\/+$/, '');
  // Collapse Next dynamic [param] / :param into a wildcard token for matching.
  s = s.replace(/\[[^/\]]+\]/g, ':p').replace(/:[^/]+/g, ':p');
  return s || '/';
}

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Build an import graph over the ALREADY-COLLECTED files (not a fresh FS walk),
 * so it sees the exact code the analysis saw and the correct app root. Reuses
 * the extended AST extractor (navTargets / authSignals / routeHost).
 *
 * @returns {{ extracted: Map<string,object>, edges: Map<string,Set<string>>, absOf: Map<string,string> }}
 *   extracted/edges are keyed by ABSOLUTE path; absOf maps rel → abs.
 */
function buildGraphFromFiles(included, analysisRoot) {
  const absOf = new Map();
  const absSet = new Set();
  for (const f of included) {
    const abs = path.resolve(analysisRoot, f.rel);
    absOf.set(toPosix(f.rel), abs);
    absSet.add(abs);
  }

  const extracted = new Map();
  for (const f of included) {
    const abs = path.resolve(analysisRoot, f.rel);
    if (!EXTS.includes(path.extname(abs))) continue;
    let ex;
    try {
      ex = extractFromFile(abs, analysisRoot);
    } catch {
      ex = { file: f.rel, imports: [], navTargets: [], authSignals: [], routeHost: false };
    }
    extracted.set(abs, ex);
  }

  const resolveImport = (fromAbs, spec) => {
    let base = null;
    if (spec.startsWith('.')) base = path.resolve(path.dirname(fromAbs), spec);
    else if (spec.startsWith('@/')) base = path.join(analysisRoot, spec.slice(2));
    else if (spec.startsWith('~/')) base = path.join(analysisRoot, spec.slice(2));
    else return null; // bare package — out of scope
    for (const ext of ['', ...EXTS]) {
      if (absSet.has(base + ext)) return base + ext;
    }
    for (const ext of EXTS) {
      const idx = path.join(base, 'index' + ext);
      if (absSet.has(idx)) return idx;
    }
    return null;
  };

  const edges = new Map();
  for (const [abs, ex] of extracted) {
    const deps = new Set();
    for (const imp of ex.imports || []) {
      const r = resolveImport(abs, imp.from);
      if (r) deps.add(r);
    }
    edges.set(abs, deps);
  }

  return { extracted, edges, absOf, absSet };
}

/**
 * Map a deployed URL path → screen file (absolute), from the collected files.
 * Handles Next App Router (app/.../page.*) and Pages Router (pages/...). Other
 * frameworks rely on manifest evidence + the SPA route-host fallback instead.
 */
function buildWebRouteMap(included, analysisRoot) {
  const map = new Map(); // normUrl -> absFile
  const add = (url, abs) => {
    const u = normUrl(url);
    if (u && !map.has(u)) map.set(u, abs);
  };

  for (const f of included) {
    const rel = toPosix(f.rel);
    const abs = path.resolve(analysisRoot, f.rel);

    // App Router: (src/)app/<segments>/page.ext  (also route.ts is NOT a screen)
    let m = rel.match(/^(?:src\/)?app\/(.*\/)?page\.(?:tsx|ts|jsx|js)$/);
    if (m) {
      const segs = (m[1] || '')
        .split('/')
        .filter(Boolean)
        .filter((s) => !(s.startsWith('(') && s.endsWith(')'))) // route groups
        .filter((s) => !s.startsWith('@')); // parallel-route slots
      add('/' + segs.join('/'), abs);
      continue;
    }

    // Pages Router: (src/)pages/<path>.ext  (skip _app/_document/api)
    m = rel.match(/^(?:src\/)?pages\/(.*)\.(?:tsx|ts|jsx|js)$/);
    if (m) {
      const p = m[1];
      if (/^_(app|document|error)$/.test(p) || p.startsWith('api/')) continue;
      const segs = p
        .split('/')
        .filter((s) => !(s.startsWith('(') && s.endsWith(')')));
      let url = '/' + segs.join('/');
      url = url.replace(/\/index$/, '') || '/';
      add(url, abs);
      continue;
    }
  }

  return map;
}

/** Next App Router layout chain for a screen file: every ancestor layout.* up
 *  to analysisRoot. From a screen the user CAN navigate via these (e.g. a
 *  sidebar living in the segment layout). */
function layoutChain(absFile, analysisRoot, absSet) {
  const chain = [];
  let dir = path.dirname(absFile);
  const root = path.resolve(analysisRoot);
  for (let i = 0; i < 24; i++) {
    for (const ext of EXTS) {
      const cand = path.join(dir, 'layout' + ext);
      if (absSet.has(cand)) chain.push(cand);
    }
    if (dir === root || !dir.startsWith(root)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain;
}

/** Detect the deployed public entry SCREEN file(s) from the filesystem. */
function findEntryFiles(routeMap, extracted) {
  const entries = new Set();
  const home = routeMap.get('/');
  if (home) entries.add(home);
  return entries;
}

/** Union of navTargets found across a set of files' import closures (+ each
 *  file's own targets). */
function collectTargets(files, edges, extracted) {
  const targets = [];
  for (const f of files) {
    for (const dep of closure(f, edges)) {
      const ex = extracted.get(dep);
      if (ex && ex.navTargets) targets.push(...ex.navTargets);
    }
  }
  return targets;
}

function anyAuthSignal(files, edges, extracted) {
  for (const f of files) {
    for (const dep of closure(f, edges)) {
      const ex = extracted.get(dep);
      if (ex && ex.authSignals && ex.authSignals.length) return true;
    }
  }
  return false;
}

/** A root middleware that redirects unauthenticated users gates the WHOLE app;
 *  treat it as a global auth gate (never disable anything → SaaS guard). */
function hasGlobalAuthGate(included, analysisRoot, extracted) {
  for (const f of included) {
    const rel = toPosix(f.rel);
    if (!/^(?:src\/)?middleware\.(?:ts|js)$/.test(rel)) continue;
    const abs = path.resolve(analysisRoot, f.rel);
    const ex = extracted.get(abs);
    if (ex && ex.authSignals && ex.authSignals.length) return true;
    // Fallback: scan raw content for a login redirect (middleware is small).
    if (/\/(login|signin|sign-in)\b/i.test(f.content) && /redirect|NextResponse/.test(f.content)) {
      return true;
    }
  }
  return false;
}

/** Actionable (non-internal-route) link kinds → candidates for LINK actions. */
const ACTION_LINK_KINDS = new Set(['external', 'store', 'anchor', 'mailto', 'tel']);

/**
 * Compute the navigation reachability surface ONCE, from the collected files —
 * independent of any manifest. Used (a) BEFORE the AI call to focus the prompt
 * on the real product surface, and (b) AFTER it by scoreSurface() to score
 * intents. Lifting it earlier is what turns reachability from a post-filter into
 * a signal that GUIDES detection.
 *
 * @returns {{
 *   applied: boolean, reason: string,
 *   extracted: Map, edges: Map, absSet: Set, routeMap: Map,
 *   entryFiles: Set<string>, reached: Set<string>, reachableClosure: Set<string>,
 *   globalAuthGate: boolean, trustworthy: boolean, resolvableTargets: number,
 *   productLinks: Array<{target:string,kind:string,label:?string,file:string}>,
 *   relOf: (abs:string)=>string,
 * }}
 */
function computeSurface({ included = [], analysisRoot, platform = 'web' }) {
  const { extracted, edges, absSet } = buildGraphFromFiles(included, analysisRoot);
  const routeMap = buildWebRouteMap(included, analysisRoot);
  const relOf = (abs) => toPosix(path.relative(analysisRoot, abs));

  // Web-first. Other platforms: reachability is not computed confidently yet.
  if (platform !== 'web') {
    return {
      applied: false, reason: 'not-web', extracted, edges, absSet, routeMap,
      entryFiles: new Set(), reached: new Set(), reachableClosure: new Set(),
      globalAuthGate: false, trustworthy: false, resolvableTargets: 0,
      productLinks: [], relOf,
    };
  }

  const globalAuthGate = hasGlobalAuthGate(included, analysisRoot, extracted);
  const entryFiles = findEntryFiles(routeMap, extracted);

  const routeHostFiles = [];
  for (const [abs, ex] of extracted) if (ex.routeHost) routeHostFiles.push(abs);

  const allTargets = new Set();
  for (const ex of extracted.values()) {
    for (const t of ex.navTargets || []) {
      const f = routeMap.get(normUrl(t));
      if (f) allTargets.add(normUrl(t));
    }
  }
  const trustworthy = allTargets.size >= 2;
  const applied = entryFiles.size > 0 && trustworthy && !globalAuthGate;

  const reached = new Set(entryFiles);
  const queue = [...entryFiles];
  const seedTargets = (files) => {
    for (const t of collectTargets(files, edges, extracted)) {
      const f = routeMap.get(normUrl(t));
      if (f && !reached.has(f)) {
        reached.add(f);
        queue.push(f);
      }
    }
  };
  seedTargets(routeHostFiles);
  while (queue.length) {
    const f = queue.shift();
    seedTargets([f, ...layoutChain(f, analysisRoot, absSet)]);
  }

  const reachableClosure = new Set();
  for (const f of reached) {
    for (const dep of closure(f, edges)) reachableClosure.add(dep);
    for (const lay of layoutChain(f, analysisRoot, absSet)) {
      for (const dep of closure(lay, edges)) reachableClosure.add(dep);
    }
  }

  // Link/navigation signals living on the reachable product surface (the files
  // the user actually sees + their shells/closures). Deduped by target. These
  // seed the analyzer so download/contact/social/anchor actions are detected.
  // When reachability is not trustworthy, fall back to ALL files' links (better
  // to surface candidates than to hide them — fail towards including).
  const linkScope = applied ? reachableClosure : new Set(extracted.keys());
  const productLinks = [];
  const seenLink = new Set();
  for (const abs of linkScope) {
    const ex = extracted.get(abs);
    if (!ex || !ex.linkEls) continue;
    for (const l of ex.linkEls) {
      if (!ACTION_LINK_KINDS.has(l.kind)) continue;
      const key = l.kind + '|' + l.target;
      if (seenLink.has(key)) continue;
      seenLink.add(key);
      productLinks.push({ target: l.target, kind: l.kind, label: l.label, file: relOf(abs) });
    }
  }

  return {
    applied,
    reason: applied
      ? 'scored'
      : globalAuthGate ? 'global-auth-gate'
        : entryFiles.size === 0 ? 'no-entry'
          : !trustworthy ? 'sparse-graph' : 'unknown',
    extracted, edges, absSet, routeMap,
    entryFiles, reached, reachableClosure,
    globalAuthGate, trustworthy, resolvableTargets: allTargets.size,
    productLinks, relOf,
  };
}

/**
 * Score every route/action of a manifest by product-surface confidence and
 * compute the conservative default-disabled sets.
 *
 * @param {object}   p
 * @param {object}   p.manifest
 * @param {object}   p.evidence   { routes: {intent:{file}}, actions: {intent:{file}} }
 * @param {Array}    p.included   collected files [{rel, content}]
 * @param {string}   p.analysisRoot
 * @param {string}   p.platform
 * @param {object}   [p.surface]  precomputed computeSurface() result (avoids recompute)
 * @returns {{
 *   routes: Object<string,{confidence:string,reason:string}>,
 *   actions: Object<string,{confidence:string,reason:string}>,
 *   disabledRouteIntents: string[],
 *   disabledActionIntents: string[],
 *   stats: object,
 * }}
 */
function scoreSurface({ manifest, evidence = {}, included = [], analysisRoot, platform = 'web', surface = null }) {
  const empty = {
    routes: {},
    actions: {},
    disabledRouteIntents: [],
    disabledActionIntents: [],
    stats: { applied: false, reason: 'not-web' },
  };

  // Web-first. Other platforms: reachability is not computed confidently yet,
  // so we return no disables (fail towards including). Honest limitation.
  if (platform !== 'web') return empty;
  if (!manifest || !Array.isArray(manifest.routes)) return empty;

  const surf = surface || computeSurface({ included, analysisRoot, platform });
  const { extracted, edges, absSet, routeMap, entryFiles, reached, reachableClosure, globalAuthGate, trustworthy } = surf;
  const canScore = surf.applied;
  const allTargetsSize = surf.resolvableTargets;

  const evAbs = (rel) => {
    if (!rel) return null;
    const abs = path.resolve(analysisRoot, rel);
    return absSet.has(abs) ? abs : null;
  };
  const routeEv = evidence.routes || {};
  const actionEv = evidence.actions || {};

  const routes = {};
  const disabledRouteIntents = [];
  const entryUrls = new Set([...entryFiles].map(() => '/'));

  for (const r of manifest.routes) {
    const intent = r.intent;
    if (!intent) continue;
    if (r.route === 'BACK') {
      routes[intent] = { confidence: 'high', reason: 'reachable' };
      continue;
    }
    // Prefer the analyzer's evidence file; fall back to mapping the route URL to
    // a screen file (web route maps), since route evidence is optional in web
    // mode while action evidence is mandatory.
    const ef = evAbs((routeEv[intent] || {}).file) || routeMap.get(normUrl(r.route)) || null;
    const isEntry = (ef && entryFiles.has(ef)) || entryUrls.has(normUrl(r.route));
    const reachable = ef && reached.has(ef);

    if (reachable || isEntry) {
      routes[intent] = { confidence: 'high', reason: 'reachable' };
    } else if (!canScore || !ef) {
      routes[intent] = { confidence: 'high', reason: 'unknown' };
    } else if (anyAuthSignal([ef, ...layoutChain(ef, analysisRoot, absSet)], edges, extracted)) {
      routes[intent] = { confidence: 'high', reason: 'behind-auth' };
    } else {
      routes[intent] = { confidence: 'low', reason: 'orphan' };
      disabledRouteIntents.push(intent);
    }
  }

  const actions = {};
  const disabledActionIntents = [];
  for (const a of manifest.actions || []) {
    const intent = a.intent;
    if (!intent) continue;
    const ef = evAbs((actionEv[intent] || {}).file);
    const onSurface = ef && reachableClosure.has(ef);

    if (onSurface) {
      actions[intent] = { confidence: 'high', reason: 'reachable' };
    } else if (!canScore || !ef) {
      actions[intent] = { confidence: 'high', reason: 'unknown' };
    } else if (anyAuthSignal([ef, ...layoutChain(ef, analysisRoot, absSet)], edges, extracted)) {
      actions[intent] = { confidence: 'high', reason: 'behind-auth' };
    } else {
      actions[intent] = { confidence: 'low', reason: 'orphan' };
      disabledActionIntents.push(intent);
    }
  }

  return {
    routes,
    actions,
    disabledRouteIntents,
    disabledActionIntents,
    stats: {
      applied: canScore,
      reason: canScore
        ? 'scored'
        : globalAuthGate
          ? 'global-auth-gate'
          : entryFiles.size === 0
            ? 'no-entry'
            : !trustworthy
              ? 'sparse-graph'
              : 'unknown',
      entryCount: entryFiles.size,
      reachableScreens: reached.size,
      resolvableTargets: allTargetsSize,
      trustworthy,
      globalAuthGate,
      routesDisabled: disabledRouteIntents.length,
      actionsDisabled: disabledActionIntents.length,
    },
  };
}

module.exports = { scoreSurface, computeSurface, normUrl, buildWebRouteMap, buildGraphFromFiles };
