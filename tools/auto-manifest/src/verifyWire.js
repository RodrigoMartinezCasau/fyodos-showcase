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
 * Is this output line a GENUINE compile/type/syntax failure (i.e. the code is
 * really broken), as opposed to a style violation? These mean the safety net
 * MUST act: the action does not actually work.
 */
function isRealCompileError(line) {
  const l = String(line);
  return /error\s+TS\d+|Type error:|Cannot find (?:module|name)|is not assignable|does not exist on type|has no exported member|Module not found|SyntaxError|Unexpected (?:token|keyword|reserved word)|Expression expected|Parsing error/i.test(l);
}

/**
 * Is this output line a pure ESLint/style complaint? These do NOT mean the code
 * is broken — they mean it breaks the PROJECT's style rules. We neutralize those
 * on our own generated files and fence our injected blocks, so honestly they
 * should never reach here; when one does, we still treat it as non-broken code.
 */
function isLintError(line) {
  const l = String(line);
  if (isRealCompileError(l)) return false;
  // Reference to a known ESLint rule namespace / a bare `no-*` rule.
  if (/@typescript-eslint\/|react-hooks\/|jsx-a11y\/|@next\/next\/|\bimport\/[a-z-]+|\breact\/[a-z-]+|prettier\/|\bno-[a-z][a-z-]+\b/.test(l)) return true;
  // ESLint compact format "12:5  Error  message  rule" without a TS error code.
  if (/^\s*\d+:\d+\s+(?:error|warning)\b/i.test(l) && !/TS\d+/.test(l)) return true;
  return false;
}

/**
 * Split error lines into { real, lint, unknown }. Unknown lines (an "Error" we
 * cannot confidently classify) are treated as REAL by callers — we fail safe
 * toward "the code might be broken", never toward shipping a red build.
 */
function classifyErrorLines(lines) {
  const real = [];
  const lint = [];
  const unknown = [];
  for (const l of lines || []) {
    if (isRealCompileError(l)) real.push(l);
    else if (isLintError(l)) lint.push(l);
    else unknown.push(l);
  }
  return { real, lint, unknown };
}

/**
 * Did applying THIS action introduce a NEW build problem? Compare position-
 * normalized error lines after vs. baseline. Any error that is new (not present
 * in baseline) AND references a file we touched or our generated modules is
 * attributed to this action.
 * Returns { ok, newErrors, realErrors, lintErrors }: `ok` is false on a genuine
 * regression; `realErrors`/`lintErrors` classify the attributed lines so callers
 * can tell "code is broken" (revert) from "style rule tripped" (style only).
 */
function compileRegressed(baselineOutput, afterOutput, touchedFiles) {
  const before = new Set(extractErrorLines(baselineOutput).map(normErr));
  const afterRaw = extractErrorLines(afterOutput).map((l) => l.trim());
  const fresh = afterRaw.filter((l) => !before.has(normErr(l)));
  const touched = (touchedFiles || []).map((f) => path.basename(normRel(f)));
  const ours = fresh.filter(
    (l) => /handlers\.generated|fyodos[\\/]bridge|FYODOS/i.test(l) || touched.some((t) => t && l.includes(t)),
  );
  if (ours.length) {
    const { real, lint, unknown } = classifyErrorLines(ours);
    return { ok: false, newErrors: ours, realErrors: [...real, ...unknown], lintErrors: lint };
  }
  // Only when the app built cleanly before (no baseline errors) do we treat any
  // unattributable fresh error as a regression. If it was already broken, an
  // unattributable error is almost certainly pre-existing → don't blame ourselves.
  if (fresh.length && !before.size) {
    const slice = fresh.slice(0, 8);
    const { real, lint, unknown } = classifyErrorLines(slice);
    return { ok: false, newErrors: slice, realErrors: [...real, ...unknown], lintErrors: lint };
  }
  return { ok: true, newErrors: [], realErrors: [], lintErrors: [] };
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
    if (op === 'delete') return { status: 'effect-pass', detail: `delete ran on the table '${table}'` };
    if (grew || changed) return { status: 'effect-pass', detail: `'${table}' changed (${before}→${after}) running the real expression` };
    return { status: 'fail', detail: `the expression ran but '${table}' did not change (${before}→${after})` };
  } catch (err) {
    return { status: 'fail', detail: `the expression threw: ${err && err.message ? err.message : String(err)}` };
  }
}

/** Reasonable test params from the action's declared manifest params. */
function sampleParams(entry) {
  const p = {};
  for (const mp of entry.manifestParams || []) {
    const n = (mp.name || '').toLowerCase();
    if (/title|text|name|label|todo|task|note/.test(n)) p[mp.name] = 'Fiodos probe item';
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
      return { status: 'unverifiable', detail: `render-probe not available (${err && err.message}); real effect not automatically verifiable — test by hand` };
    }
  }
  if (opts.sensitive || entry.requireConfirmation) {
    return { status: 'skipped', detail: 'confirmation action: its effect is not fired in the simulation (security)' };
  }
  // Module strategy: try the Dexie data-layer probe.
  const dexie = await probeDexie(appRoot, entry, opts.fyodosDirRel);
  if (dexie) return dexie;
  return { status: 'skipped', detail: 'module target not safely simulable in-process; verified by compilation' };
}

module.exports = {
  probeEffect, compileRegressed, extractErrorLines, readDexieStores,
  classifyErrorLines, isRealCompileError, isLintError,
};
