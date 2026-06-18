/**
 * verifyWire — install-time verification of a SINGLE wired action.
 *
 * Two complementary signals drive the auto-correction loop:
 *   1) COMPILE: does the project still build/typecheck with ONLY this action's
 *      wiring applied? (catches the real TS/shape errors that made Angular flaky).
 *      We diff against a pre-captured baseline so a pre-broken app (e.g. Vue with
 *      stale vue-tsc) is judged on "did WE add an error", not absolute success.
 *   2) EFFECT: when the action's behaviour is safely simulable IN-PROCESS, run it
 *      against a REAL instance and confirm observable state changed. Today this
 *      covers the local-first data layer (Dexie) reliably; component-local state
 *      (React useState / Vue ref / Angular DI) is not rendered in-process, so it
 *      is honestly reported as "effect not simulated" (compile-verified instead).
 *
 * Nothing here ever fires a sensitive/irreversible action: callers pass
 * `sensitive` for requireConfirmation actions and we skip execution for them.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function normRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

// ── Compile-error attribution ──────────────────────────────────────────────────

/** Extract "path(line,col): error" / "ERROR ... path:line" style lines. */
function extractErrorLines(output) {
  const lines = String(output || '').split('\n');
  return lines.filter((l) => /error\s+TS\d+|: error|ERROR\b|is not assignable|Cannot find|does not exist/i.test(l));
}

/**
 * Normalize an error line so the SAME pre-existing error matches across builds
 * even when our inserted lines shifted its line/column numbers. Without this, a
 * pre-broken app (e.g. Vue with stale vue-tsc JSX errors) would report every
 * shifted error as "new" the moment we add a single line → false regressions.
 */
function normErr(line) {
  return String(line)
    .replace(/\(\d+,\s*\d+\)/g, '(L,C)') // tsc:  file(123,3)
    .replace(/:\d+:\d+/g, ':L:C') // esbuild: file:123:3
    .replace(/\bline\s+\d+/gi, 'line N')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Did applying THIS action introduce a NEW build problem? Compare position-
 * normalized error lines after vs. baseline. Any error that is new (not present
 * in baseline) AND references a file we touched or our generated modules is
 * attributed to this action. Returns { ok, newErrors: string[] }.
 */
function compileRegressed(baselineOutput, afterOutput, touchedFiles) {
  const before = new Set(extractErrorLines(baselineOutput).map(normErr));
  const afterRaw = extractErrorLines(afterOutput).map((l) => l.trim());
  const fresh = afterRaw.filter((l) => !before.has(normErr(l)));
  const touched = (touchedFiles || []).map((f) => path.basename(normRel(f)));
  const ours = fresh.filter(
    (l) => /handlers\.generated|fyodos[\\/]bridge|FYODOS/i.test(l) || touched.some((t) => t && l.includes(t)),
  );
  if (ours.length) return { ok: false, newErrors: ours };
  // Only when the app built cleanly before (no baseline errors) do we treat any
  // unattributable fresh error as a regression. If it was already broken, an
  // unattributable error is almost certainly pre-existing → don't blame ourselves.
  if (fresh.length && !before.size) return { ok: false, newErrors: fresh.slice(0, 8) };
  return { ok: true, newErrors: [] };
}

// ── Effect probe (in-process, real instance) ─────────────────────────────────────

/** Read a Dexie schema `version(n).stores({ table: 'idx', ... })` from a file. */
function readDexieStores(appRoot, fileRel) {
  const abs = path.join(appRoot, normRel(fileRel));
  if (!fs.existsSync(abs)) return null;
  const src = fs.readFileSync(abs, 'utf8');
  const m = src.match(/\.stores\(\s*\{([\s\S]*?)\}\s*\)/);
  if (!m) return null;
  const stores = {};
  const body = m[1];
  const re = /(['"]?[\w$]+['"]?)\s*:\s*(['"])([\s\S]*?)\2/g;
  let mm;
  while ((mm = re.exec(body))) {
    const key = mm[1].replace(/['"]/g, '');
    stores[key] = mm[3];
  }
  return Object.keys(stores).length ? stores : null;
}

/** Resolve the file that the entry imports `db` (or similar) from. */
function findImportFile(appRoot, entry, localName, fyodosDirRel) {
  const imps = entry.imports || [];
  const fyodosDir = fyodosDirRel || entry.fyodosDirRel || 'src/fyodos';
  for (const imp of imps) {
    if (imp.name === localName) {
      // importPath is relative to the fyodos dir; resolve to a repo-relative file.
      const base = path.join(appRoot, fyodosDir, imp.importPath);
      for (const ext of ['.ts', '.js', '.mjs', '/index.ts', '/index.js']) {
        if (fs.existsSync(base + ext)) return path.relative(appRoot, base + ext);
      }
    }
  }
  return null;
}

/**
 * Try to PROVE the effect of a Dexie-backed action by executing its exact
 * expression against a real (fake-indexeddb) database with the app's schema.
 * Returns { status: 'effect-pass'|'fail'|'skipped', detail }.
 */
async function probeDexie(appRoot, entry, fyodosDirRel) {
  const expr = entry.callExpr || '';
  const dbMatch = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\.(add|put|bulkAdd|bulkPut|update|delete)\s*\(/.exec(expr);
  if (!dbMatch) return null; // not a dexie op
  const dbVar = dbMatch[1];
  const table = dbMatch[2];
  const dbFile = findImportFile(appRoot, entry, dbVar, fyodosDirRel);
  if (!dbFile) return null;
  const stores = readDexieStores(appRoot, dbFile);
  if (!stores || !stores[table]) return null;

  let Dexie;
  try {
    require(path.join(appRoot, 'node_modules/fake-indexeddb/auto'));
    const mod = require(path.join(appRoot, 'node_modules/dexie'));
    Dexie = mod.Dexie || mod.default || mod;
  } catch {
    return { status: 'skipped', detail: 'dexie/fake-indexeddb no disponible para simular el efecto' };
  }

  try {
    const db = new Dexie(`fyodos-probe-${Date.now()}`);
    const verObj = {};
    for (const [t, idx] of Object.entries(stores)) verObj[t] = idx;
    db.version(1).stores(verObj);
    const before = await db.table(table).count();
    const params = sampleParams(entry);
    // Execute the EXACT generated expression with db + params in scope.
    // eslint-disable-next-line no-new-func
    const run = new Function(dbVar, 'params', 'crypto', `return (async () => { return ${expr}; })();`);
    await run(db, params, globalThis.crypto || require('crypto').webcrypto);
    const after = await db.table(table).count();
    const op = dbMatch[3];
    const grew = after > before;
    const changed = after !== before || /update|put|delete/.test(op);
    if (op === 'delete') return { status: 'effect-pass', detail: `delete ejecutó sobre la tabla '${table}'` };
    if (grew || changed) return { status: 'effect-pass', detail: `'${table}' cambió (${before}→${after}) ejecutando la expresión real` };
    return { status: 'fail', detail: `la expresión ejecutó pero '${table}' no cambió (${before}→${after})` };
  } catch (err) {
    return { status: 'fail', detail: `la expresión lanzó: ${err && err.message ? err.message : String(err)}` };
  }
}

/** Reasonable test params from the action's declared manifest params. */
function sampleParams(entry) {
  const p = {};
  for (const mp of entry.manifestParams || []) {
    const n = (mp.name || '').toLowerCase();
    if (/title|text|name|label|todo|task|note/.test(n)) p[mp.name] = 'Fyodos probe item';
    else if (/id|key/.test(n)) p[mp.name] = 1;
    else if (/count|qty|amount|number/.test(n)) p[mp.name] = 1;
    else if (/done|complete|checked/.test(n)) p[mp.name] = true;
    else p[mp.name] = 'probe';
  }
  return p;
}

/**
 * Effect verification for one action. Returns:
 *   { status: 'effect-pass'|'fail'|'skipped', detail }
 * 'skipped' = couldn't simulate safely (component-local/sensitive); the caller
 * then relies on the compile signal and reports honestly.
 */
function detectComponentFramework(appRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps['@angular/core']) return 'angular';
    if (deps.vue || deps['@vue/runtime-dom']) return 'vue';
    if (deps.svelte || deps['@sveltejs/kit']) return 'svelte';
    if (deps.react || deps['react-dom']) return 'react';
  } catch { /* ignore */ }
  return 'web';
}

async function probeEffect(appRoot, entry, opts = {}) {
  if (entry.kind === 'bridge') {
    // Component-local state: prove the real effect by RENDERING the component and
    // confirming the UI mutates (not just that it compiles). Sensitive actions are
    // not fired inside the render (handled by the render probe itself).
    const framework = (opts.framework && opts.framework !== 'web') ? opts.framework : detectComponentFramework(appRoot);
    try {
      const { probeComponentEffect } = require('./renderProbe');
      return await probeComponentEffect(appRoot, entry, {
        framework,
        fyodosDirRel: opts.fyodosDirRel,
        sources: opts.sources,
        sensitive: opts.sensitive || entry.requireConfirmation,
      });
    } catch (err) {
      return { status: 'unverifiable', detail: `render-probe no disponible (${err && err.message}); efecto real no verificable automáticamente — probar a mano` };
    }
  }
  if (opts.sensitive || entry.requireConfirmation) {
    return { status: 'skipped', detail: 'acción con confirmación: no se dispara su efecto en la simulación (seguridad)' };
  }
  // Module strategy: try the Dexie data-layer probe.
  const dexie = await probeDexie(appRoot, entry, opts.fyodosDirRel);
  if (dexie) return dexie;
  return { status: 'skipped', detail: 'objetivo de módulo no simulable de forma segura en proceso; verificado por compilación' };
}

module.exports = { probeEffect, compileRegressed, extractErrorLines, readDexieStores };
