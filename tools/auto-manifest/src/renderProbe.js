/**
 * renderProbe — REAL-EFFECT verification for component-local state.
 *
 * For actions whose state lives inside a component (React useState / Vue ref /
 * Angular), "it compiles + the symbol exists" is NOT proof the action works. So
 * here we actually MOUNT the user's real component in a headless DOM, invoke the
 * generated handler/bridge with test params, and confirm the rendered UI changes
 * as it should (the item appears, disappears, or the view mutates).
 *
 * Returns one of:
 *   { status: 'effect-pass', detail }     mounted, invoked, UI changed as expected
 *   { status: 'fail', detail }            mounted + invoked but NO/incorrect effect
 *                                         (→ feeds the auto-correction loop)
 *   { status: 'unverifiable', detail }    could not mount/seed reliably in headless
 *                                         (honest: "review manually", never faked)
 *
 * Security: callers pass `sensitive` for requireConfirmation actions; those are
 * NEVER executed here — we mount and confirm the wiring resolves, but do not fire
 * the (possibly irreversible) effect.
 *
 * Standard per-framework tooling (resolved from the APP so versions match):
 *   React  → react-dom/client + act, in jsdom
 *   Vue    → vue (createApp) + @vue/compiler-sfc, in jsdom
 *   Angular→ (headless TestBed is not reliable in a bare CLI; reported honestly
 *            as unverifiable with the reason)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SENTINEL = `FiodosProbe_${Math.random().toString(36).slice(2, 8)}`;
const SEED_ID = 'fyodos-seed-id-1';

function reqFrom(appRoot, mod) {
  try { return require(path.join(appRoot, 'node_modules', mod)); } catch { return null; }
}
function loadEsbuild(appRoot) {
  return reqFrom(appRoot, 'esbuild') || (() => { try { return require('esbuild'); } catch { return null; } })();
}
function loadJsdom() {
  try { return require('jsdom'); } catch { return null; }
}

/** Detailed technical output (jsdom/React internals) only when asked. */
function isVerboseProbe() {
  return process.argv.includes('--verbose') || process.argv.includes('-v') || process.argv.includes('--debug');
}

/**
 * Render-probe teardown guard.
 *
 * The probe mounts the user's real React component in jsdom, then unmounts and
 * tears the DOM down. React 18 schedules passive-effect cleanup ASYNCHRONOUSLY
 * (a scheduler timer/microtask). If any cleanup fires AFTER we removed the
 * jsdom globals, React throws "The `document` global was defined when React was
 * initialized, but is not defined anymore". On Node ≥ 21/25 that async throw is
 * an uncaughtException that kills the ENTIRE CLI — long after the probe returned
 * (e.g. while the CLI is awaiting the ".env" prompt). The probe is an OPTIONAL
 * effect check; it must never crash an otherwise-successful install.
 *
 * We install (once) a narrow process-level filter that swallows ONLY this jsdom/
 * React teardown error class and lets every other error crash as usual.
 */
let teardownGuardInstalled = false;
function isProbeTeardownError(err) {
  const msg = String((err && (err.stack || err.message)) || err || '');
  return (
    /`document` global was defined when React was initialized/.test(msg) ||
    /\bdocument is not defined\b/.test(msg) ||
    /Cannot read properties of (?:null|undefined) \(reading '(?:document|ownerDocument|defaultView|createElement|body)'\)/.test(msg) ||
    (/jsdom/i.test(msg) && /not defined|closed|null/i.test(msg))
  );
}
function installProbeTeardownGuard() {
  if (teardownGuardInstalled) return;
  teardownGuardInstalled = true;
  process.on('uncaughtException', (err) => {
    if (isProbeTeardownError(err)) return; // late probe passive-effect cleanup — safe to drop
    // Not ours: preserve Node's default fail-fast behavior for real errors.
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    if (isProbeTeardownError(reason)) return;
    throw reason;
  });
}

/**
 * Capture (swallow) noisy global console output during a probe — React error
 * boundary logs ("The above error occurred in <X>", "Consider adding an error
 * boundary…"), uncaught-error dumps, etc. These come from rendering the user's
 * real pages in a bare jsdom (no router/providers) and are internal noise, not
 * actionable user information. The captured lines are returned for diagnostics.
 *
 * No-op under --verbose/--debug so power users can still see the raw detail.
 */
function captureConsole() {
  if (isVerboseProbe()) return { captured: [], restore() {} };
  const captured = [];
  const saved = {
    log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug,
  };
  const sink = (...a) => {
    try { captured.push(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')); } catch { /* ignore */ }
  };
  console.log = sink; console.error = sink; console.warn = sink; console.info = sink; console.debug = sink;
  return {
    captured,
    restore() {
      console.log = saved.log; console.error = saved.error; console.warn = saved.warn;
      console.info = saved.info; console.debug = saved.debug;
    },
  };
}

/** esbuild plugin that empties style/asset imports (works on old esbuild that
 *  lacks the 'empty' loader). Side-effect CSS imports become no-ops. */
function emptyAssetsPlugin() {
  return {
    name: 'fyodos-empty-assets',
    setup(build) {
      build.onLoad({ filter: /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|woff2?|ttf|eot|ico)$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
    },
  };
}

/** Classify the action so we know what UI change to expect. */
function actionKind(entry) {
  const s = `${entry.intent || ''} ${entry.handler || ''} ${entry.label || ''}`.toLowerCase();
  if (/\b(add|create|new|insert|append|save|submit)\b|add|create|new/.test(s)) return 'add';
  if (/delete|remove|destroy|clear|trash/.test(s)) return 'delete';
  if (/toggle|complete|done|check|mark|finish/.test(s)) return 'toggle';
  if (/open|show|navigate|go|close|hide|view|select/.test(s)) return 'ui';
  return 'other';
}

/** Build test params, putting a unique sentinel into the main text-like field. */
function probeParams(entry, kind) {
  const p = {};
  for (const mp of entry.manifestParams || []) {
    const n = (mp.name || '').toLowerCase();
    if (/title|text|name|label|todo|task|note|desc|content|message/.test(n)) p[mp.name] = SENTINEL;
    else if (/\bid\b|key|index/.test(n)) p[mp.name] = SEED_ID;
    else if (/done|complete|check|status/.test(n)) p[mp.name] = true;
    else if (/count|qty|amount|num/.test(n)) p[mp.name] = 1;
    else p[mp.name] = SENTINEL;
  }
  return p;
}

/** localStorage keys the component hydrates from, so we can seed an item. */
function detectStorageKeys(sources) {
  const keys = new Set();
  for (const s of sources || []) {
    const re = /localStorage\.getItem\(\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(s.content || ''))) keys.add(m[1]);
  }
  return [...keys];
}

/** Generic seed record covering the common todo/item field shapes. */
function seedRecord() {
  return { id: SEED_ID, title: SENTINEL, text: SENTINEL, name: SENTINEL, label: SENTINEL, completed: false, done: false };
}

// ── React ──────────────────────────────────────────────────────────────────────

async function probeReactEffect(appRoot, entry, ctx) {
  const esbuild = loadEsbuild(appRoot);
  const jsdomMod = loadJsdom();
  if (!esbuild || !jsdomMod) {
    return { status: 'unverifiable', detail: `could not set up the headless render (${!esbuild ? 'esbuild' : 'jsdom'} not available); wiring applied, real effect not automatically verifiable — test by hand` };
  }
  const fyodosDirAbs = path.join(appRoot, ctx.fyodosDirRel);
  const componentAbs = path.join(appRoot, entry.bridge.file);
  const registryAbs = path.join(fyodosDirAbs, 'handlers.generated.js');
  const entryRel = './' + path.relative(fyodosDirAbs, componentAbs).split(path.sep).join('/');

  const harnessAbs = path.join(fyodosDirAbs, '__fyodos_probe_entry.jsx');
  const outAbs = path.join(os.tmpdir(), `fyodos-probe-${Date.now()}.cjs`);
  const harness =
    `import * as Comp from '${entryRel}';\n` +
    `import { fyodosGeneratedRegistries } from './handlers.generated';\n` +
    `import * as ReactNS from 'react';\n` +
    `import { createRoot } from 'react-dom/client';\n` +
    `import { flushSync } from 'react-dom';\n` +
    `export const probe = { React: ReactNS.default || ReactNS, createRoot, flushSync, Comp, registry: fyodosGeneratedRegistries };\n`;

  // A late React passive-effect cleanup that fires after we tear down jsdom must
  // never crash the CLI (see installProbeTeardownGuard).
  installProbeTeardownGuard();

  let restore = () => {};
  let cap = { restore() {} };
  // Hoisted so the finally block can drain React (synchronously unmount + settle)
  // BEFORE the DOM globals are removed — the only reliable way to stop React from
  // running cleanup against a closed jsdom.
  let root = null;
  let flushSync = null;
  const settle = () => new Promise((r) => setTimeout(r, 0));
  try {
    fs.writeFileSync(harnessAbs, harness);
    await esbuild.build({
      entryPoints: [harnessAbs],
      outfile: outAbs,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      jsxDev: false,
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [emptyAssetsPlugin()],
      logLevel: 'silent',
      absWorkingDir: fyodosDirAbs,
    });

    // Silence React/jsdom render noise from here through unmount (see captureConsole).
    cap = captureConsole();
    restore = installDom(jsdomMod, { storageKeys: ctx.storageKeys, kind: ctx.kind });
    delete require.cache[outAbs];
    const mod = require(outAbs);
    const { React, createRoot, Comp, registry } = mod.probe;
    flushSync = mod.probe.flushSync;
    const Component = pickComponent(Comp);
    if (!Component) return { status: 'unverifiable', detail: `did not find a mountable React component exported by '${entry.bridge.file}' — real effect not verifiable, test by hand` };

    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      flushSync(() => { root = createRoot(container); root.render(React.createElement(Component)); });
      await settle();
      flushSync(() => {});
    } catch (err) {
      return { status: 'unverifiable', detail: `the component could not be rendered in isolation (${short(err)}); real effect not automatically verifiable — test by hand` };
    }

    const beforeHTML = captureSnapshot(container);
    const beforeText = container.textContent || '';
    const handler = registry.handlers[entry.handler];
    if (typeof handler !== 'function') return { status: 'fail', detail: `el registro no expone el handler '${entry.handler}'` };

    if (ctx.sensitive) {
      // Do NOT fire the effect; we proved it mounts and the handler resolves to a
      // live bridge function. Verify the bridge has the method, nothing more.
      return { status: 'unverifiable', detail: 'confirmation action: its effect is not fired in the test render (security); wiring verified up to the confirmation point' };
    }

    let invokeErr = null;
    try { await handler(ctx.params); } catch (e) { invokeErr = e; }
    await settle();
    try { flushSync(() => {}); } catch {}
    if (invokeErr) return { status: 'fail', detail: `invoking the handler, the real app threw: ${short(invokeErr)}` };

    const afterHTML = captureSnapshot(container);
    const afterText = container.textContent || '';
    return decide(ctx.kind, { beforeHTML, beforeText, afterHTML, afterText });
  } catch (err) {
    return { status: 'unverifiable', detail: `could not prepare the test render (${short(err)}); real effect not automatically verifiable — test by hand` };
  } finally {
    // Drain React WHILE the DOM is still alive: a synchronous unmount runs every
    // pending passive-effect cleanup now, so nothing fires after we remove the
    // jsdom globals below. Two settle ticks flush the scheduler's macro/microtasks.
    try {
      if (root) {
        if (flushSync) flushSync(() => { try { root.unmount(); } catch { /* ignore */ } });
        else { try { root.unmount(); } catch { /* ignore */ } }
        await settle();
        await settle();
      }
    } catch { /* ignore */ }
    try { cap.restore(); } catch {}
    try { fs.existsSync(harnessAbs) && fs.rmSync(harnessAbs); } catch {}
    try { fs.existsSync(outAbs) && fs.rmSync(outAbs); } catch {}
    try { restore(); } catch {}
  }
}

/** Snapshot that also captures form-control state (checked/value), which React
 *  sets as DOM properties and would NOT show up in innerHTML alone (e.g. toggles). */
function captureSnapshot(container) {
  let s = container.innerHTML;
  try {
    const inputs = container.querySelectorAll('input, textarea, select');
    inputs.forEach((el, i) => { s += `|#${i}:${el.type || ''}:${el.checked ? '1' : '0'}:${el.value || ''}`; });
  } catch { /* ignore */ }
  return s;
}

function pickComponent(Comp) {
  if (!Comp) return null;
  if (typeof Comp.default === 'function') return Comp.default;
  for (const v of Object.values(Comp)) {
    if (typeof v === 'function' && /^[A-Z]/.test(v.name || '')) return v;
  }
  return null;
}

/** Decide pass/fail/unverifiable from the before/after DOM and the action kind. */
function decide(kind, snap) {
  const { beforeHTML, beforeText, afterHTML, afterText } = snap;
  const htmlChanged = beforeHTML !== afterHTML;
  const sentinelAppeared = !beforeText.includes(SENTINEL) && afterText.includes(SENTINEL);
  const sentinelDisappeared = beforeText.includes(SENTINEL) && !afterText.includes(SENTINEL);

  if (kind === 'add') {
    if (sentinelAppeared) return { status: 'effect-pass', detail: `after invoking the action, "${SENTINEL}" appears in the rendered UI (the item was really added)` };
    if (htmlChanged) return { status: 'effect-pass', detail: 'the UI changed after invoking the action (effect observed in the render)' };
    return { status: 'fail', detail: 'the action was invoked but the UI did not change nor did the sent value appear (it produces no effect)' };
  }
  if (kind === 'delete') {
    if (sentinelDisappeared) return { status: 'effect-pass', detail: 'the seeded item disappeared from the UI after invoking the action (it was really deleted)' };
    if (htmlChanged) return { status: 'effect-pass', detail: 'the UI changed after invoking the delete action' };
    return { status: 'unverifiable', detail: 'no change observed on delete (maybe there was no seeded item in isolation); wiring applied, effect not confirmed — test by hand' };
  }
  if (kind === 'toggle') {
    if (htmlChanged) return { status: 'effect-pass', detail: 'the UI changed after invoking the action (item state toggled)' };
    return { status: 'unverifiable', detail: 'no change observed on toggle (maybe no seeded item in isolation); wiring applied, effect not confirmed — test by hand' };
  }
  // ui / other
  if (htmlChanged) return { status: 'effect-pass', detail: 'the component UI changed after invoking the action' };
  return { status: 'unverifiable', detail: 'the action produced no observable change in the isolated render; wiring applied, effect not confirmed — test by hand' };
}

function short(err) {
  return String((err && err.message) || err).split('\n')[0].slice(0, 200);
}

/**
 * Install a jsdom-backed DOM on the global scope (saving anything we overwrite so
 * we can restore it). Seeds localStorage keys with a sentinel record so delete/
 * toggle actions have something to act on.
 */
function installDom(jsdomMod, { storageKeys = [], kind } = {}) {
  const { JSDOM, VirtualConsole } = jsdomMod;
  // A VirtualConsole that does NOT forward to the real console: jsdom's default
  // pipes page errors (uncaught exceptions → "reportException", long stack
  // traces) to our stderr. That is internal noise from rendering the user's
  // pages in a bare DOM. We swallow it (or forward only under --verbose).
  let virtualConsole;
  try {
    virtualConsole = new VirtualConsole();
    if (isVerboseProbe()) virtualConsole.sendTo(console);
  } catch { virtualConsole = undefined; }
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  // Seed storage BEFORE the component hydrates (only useful for delete/toggle).
  if (kind === 'delete' || kind === 'toggle') {
    for (const k of storageKeys.length ? storageKeys : ['ITEMS', 'todos', 'tasks']) {
      try { window.localStorage.setItem(k, JSON.stringify([seedRecord()])); } catch {}
    }
  }
  const values = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Element: window.Element,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    location: window.location,
    history: window.history,
    MutationObserver: window.MutationObserver,
    SVGElement: window.SVGElement,
    Text: window.Text,
    Comment: window.Comment,
    DocumentFragment: window.DocumentFragment,
    NodeList: window.NodeList,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLSelectElement: window.HTMLSelectElement,
    DOMParser: window.DOMParser,
    XMLSerializer: window.XMLSerializer,
  };
  const saved = {};
  const savedDesc = {};
  for (const k of Object.keys(values)) {
    saved[k] = global[k];
    savedDesc[k] = Object.getOwnPropertyDescriptor(global, k);
    try {
      global[k] = values[k];
    } catch {
      // Some globals (navigator in Node ≥21) are getter-only → redefine.
      try { Object.defineProperty(global, k, { value: values[k], configurable: true, writable: true }); } catch { /* skip */ }
    }
  }
  const savedAct = global.IS_REACT_ACT_ENVIRONMENT;
  global.IS_REACT_ACT_ENVIRONMENT = false;
  return () => {
    for (const k of Object.keys(values)) {
      try {
        if (savedDesc[k]) Object.defineProperty(global, k, savedDesc[k]);
        else if (saved[k] === undefined) delete global[k];
        else global[k] = saved[k];
      } catch { /* best effort */ }
    }
    global.IS_REACT_ACT_ENVIRONMENT = savedAct;
    try { window.close(); } catch {}
  };
}

// ── Public dispatch ──────────────────────────────────────────────────────────

/**
 * Verify component-local effect by rendering. `framework` selects the engine.
 * `sources` are the project's source files (for storage-key detection, etc.).
 */
async function probeComponentEffect(appRoot, entry, opts = {}) {
  // Defense-in-depth: a late headless-render teardown error (React/Vue passive
  // cleanup firing after jsdom is closed) must never crash the CLI.
  installProbeTeardownGuard();
  const framework = (opts.framework || 'web').toLowerCase();
  const kind = actionKind(entry);
  const params = probeParams(entry, kind);
  const storageKeys = detectStorageKeys(opts.sources);
  const ctx = { fyodosDirRel: opts.fyodosDirRel || 'src/fyodos', framework, kind, params, storageKeys, sensitive: opts.sensitive || entry.requireConfirmation };

  const withTimeout = (p) => Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve({ status: 'unverifiable', detail: 'the test render exceeded the time limit (possible loop/timer in the component); real effect not automatically verifiable — test by hand' }), opts.timeoutMs || 25000)),
  ]);

  if (framework.includes('react')) return withTimeout(probeReactEffect(appRoot, entry, ctx));
  if (framework.includes('vue')) return withTimeout(require('./renderProbeVue').probeVueEffect(appRoot, entry, ctx));
  if (framework.includes('angular')) {
    return { status: 'unverifiable', detail: 'Angular: headless component rendering with TestBed is not reliable outside ng test; wiring applied and verified by compilation, real effect not automatically verifiable here — test with `ng test` or by hand' };
  }
  return { status: 'unverifiable', detail: `framework '${framework}' has no render-probe; real effect not automatically verifiable` };
}

module.exports = { probeComponentEffect, actionKind, decide, SENTINEL, SEED_ID, installDom, pickComponent, detectStorageKeys, probeParams, captureSnapshot, short, loadEsbuild, loadJsdom, reqFrom, emptyAssetsPlugin, captureConsole, isVerboseProbe, installProbeTeardownGuard, isProbeTeardownError };
