/**
 * Layer 2 — dependency graph and state mapping.
 *
 * - Resolves imports between project files (including tsconfig-style '@/'
 *   aliases) to know which modules each screen pulls in (transitively).
 * - Maps stores (Zustand) to the screens that consume them.
 * - Builds, per screen, the consolidated action surface: own handlers +
 *   store actions reachable from it, plus the evidence (alerts, buttons,
 *   nav calls) needed downstream.
 *
 * Everything here is still provenance "static".
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { extractFromFile } = require('./ast');

const EXTS = ['.tsx', '.ts', '.jsx', '.js'];

function resolveImport(fromFile, spec, appRoot, srcRoot) {
  let base = null;
  if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith('@/')) base = path.join(srcRoot, spec.slice(2));
  else return null; // node_modules — out of scope
  for (const ext of ['', ...EXTS]) {
    const p = base + ext;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  for (const ext of EXTS) {
    const p = path.join(base, 'index' + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findSrcRoot(appRoot) {
  const src = path.join(appRoot, 'src');
  return fs.existsSync(src) ? src : appRoot;
}

/** Parses every project source file once; builds extraction map + import graph. */
function buildGraph(appRoot) {
  const srcRoot = findSrcRoot(appRoot);
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (EXTS.includes(path.extname(e.name))) files.push(full);
    }
  })(srcRoot);

  const extracted = new Map(); // absPath -> extraction
  const edges = new Map(); // absPath -> Set(absPath)

  for (const f of files) {
    let ex;
    try {
      ex = extractFromFile(f, appRoot);
    } catch (err) {
      ex = { file: path.relative(appRoot, f), parseError: String(err), handlers: [], navCalls: [], alerts: [], storeActions: [], storeStateKeys: [], buttons: [], textInputs: [], imports: [], linkingCalls: [] };
    }
    extracted.set(f, ex);
    const deps = new Set();
    for (const imp of ex.imports || []) {
      const resolved = resolveImport(f, imp.from, appRoot, srcRoot);
      if (resolved) deps.add(resolved);
    }
    edges.set(f, deps);
  }

  return { files, extracted, edges, srcRoot };
}

/** Transitive dependency closure of a file (bounded). */
function closure(file, edges, maxDepth = 4) {
  const seen = new Set([file]);
  let frontier = [file];
  for (let d = 0; d < maxDepth; d++) {
    const next = [];
    for (const f of frontier) {
      for (const dep of edges.get(f) || []) {
        if (!seen.has(dep)) {
          seen.add(dep);
          next.push(dep);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/**
 * For each screen (route file), aggregates the action surface visible from it.
 */
function mapScreens(routes, graph) {
  const { extracted, edges } = graph;

  // global store registry: file -> {storeName, actions, stateKeys}
  const stores = [];
  for (const [f, ex] of extracted) {
    if (ex.storeActions && ex.storeActions.length > 0) {
      stores.push({
        file: ex.file,
        absFile: f,
        storeName: ex.storeName || path.basename(f).replace(/\..+$/, ''),
        actions: ex.storeActions.map((a) => a.name),
        stateKeys: ex.storeStateKeys,
      });
    }
  }

  const screens = routes.map((route) => {
    const ex = extracted.get(route.filePath) || {};
    const deps = closure(route.filePath, edges);

    const usedStores = stores.filter((s) => deps.has(s.absFile));
    const depHandlers = [];
    const depAlerts = [];
    const depButtons = [];
    const depNavCalls = [];
    const depLinking = [];
    const depTextInputs = [];
    for (const d of deps) {
      if (d === route.filePath) continue;
      const dex = extracted.get(d);
      if (!dex) continue;
      depHandlers.push(...(dex.handlers || []));
      depAlerts.push(...(dex.alerts || []));
      depButtons.push(...(dex.buttons || []));
      depNavCalls.push(...(dex.navCalls || []));
      depLinking.push(...(dex.linkingCalls || []));
      depTextInputs.push(...(dex.textInputs || []));
    }

    return {
      route,
      ownHandlers: ex.handlers || [],
      ownAlerts: ex.alerts || [],
      ownButtons: ex.buttons || [],
      ownNavCalls: ex.navCalls || [],
      ownTextInputs: (ex.textInputs || []).concat(depTextInputs),
      ownLinking: ex.linkingCalls || [],
      depHandlers,
      depAlerts,
      depButtons,
      depNavCalls,
      depLinking,
      usedStores: usedStores.map((s) => ({ storeName: s.storeName, file: s.file, actions: s.actions })),
      defaultExportName: ex.defaultExportName || null,
    };
  });

  return { screens, stores };
}

module.exports = { buildGraph, mapScreens };
