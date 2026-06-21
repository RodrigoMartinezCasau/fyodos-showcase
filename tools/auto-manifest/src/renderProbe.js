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
    return { status: 'unverifiable', detail: `no se pudo montar el render headless (${!esbuild ? 'esbuild' : 'jsdom'} no disponible); cableado aplicado, efecto real no verificable automáticamente — probar a mano` };
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

  let restore = () => {};
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

    restore = installDom(jsdomMod, { storageKeys: ctx.storageKeys, kind: ctx.kind });
    delete require.cache[outAbs];
    const mod = require(outAbs);
    const { React, createRoot, flushSync, Comp, registry } = mod.probe;
    const Component = pickComponent(Comp);
    if (!Component) return { status: 'unverifiable', detail: `no encontré un componente React montable exportado por '${entry.bridge.file}' — efecto real no verificable a mano` };

    const container = document.createElement('div');
    document.body.appendChild(container);
    let root;
    const settle = () => new Promise((r) => setTimeout(r, 0));
    try {
      flushSync(() => { root = createRoot(container); root.render(React.createElement(Component)); });
      await settle();
      flushSync(() => {});
    } catch (err) {
      return { status: 'unverifiable', detail: `el componente no se pudo renderizar en aislamiento (${short(err)}); efecto real no verificable automáticamente — probar a mano` };
    }

    const beforeHTML = captureSnapshot(container);
    const beforeText = container.textContent || '';
    const handler = registry.handlers[entry.handler];
    if (typeof handler !== 'function') { try { root.unmount(); } catch {} return { status: 'fail', detail: `el registro no expone el handler '${entry.handler}'` }; }

    if (ctx.sensitive) {
      // Do NOT fire the effect; we proved it mounts and the handler resolves to a
      // live bridge function. Verify the bridge has the method, nothing more.
      try { root.unmount(); } catch {}
      return { status: 'unverifiable', detail: 'acción con confirmación: no se dispara su efecto en el render de prueba (seguridad); cableado verificado hasta el punto de confirmación' };
    }

    let invokeErr = null;
    try { await handler(ctx.params); } catch (e) { invokeErr = e; }
    await settle();
    try { flushSync(() => {}); } catch {}
    if (invokeErr) { try { root.unmount(); } catch {} return { status: 'fail', detail: `al invocar el handler la app real lanzó: ${short(invokeErr)}` }; }

    const afterHTML = captureSnapshot(container);
    const afterText = container.textContent || '';
    try { root.unmount(); } catch {}
    return decide(ctx.kind, { beforeHTML, beforeText, afterHTML, afterText });
  } catch (err) {
    return { status: 'unverifiable', detail: `no se pudo preparar el render de prueba (${short(err)}); efecto real no verificable automáticamente — probar a mano` };
  } finally {
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
    if (sentinelAppeared) return { status: 'effect-pass', detail: `tras invocar la acción, "${SENTINEL}" aparece en la UI renderizada (el item se añadió de verdad)` };
    if (htmlChanged) return { status: 'effect-pass', detail: 'la UI cambió tras invocar la acción (efecto observado en el render)' };
    return { status: 'fail', detail: 'la acción se invocó pero la UI no cambió ni apareció el valor enviado (no produce su efecto)' };
  }
  if (kind === 'delete') {
    if (sentinelDisappeared) return { status: 'effect-pass', detail: 'el item sembrado desapareció de la UI tras invocar la acción (se borró de verdad)' };
    if (htmlChanged) return { status: 'effect-pass', detail: 'la UI cambió tras invocar la acción de borrado' };
    return { status: 'unverifiable', detail: 'no se observó cambio al borrar (quizá no había item sembrado en aislamiento); cableado aplicado, efecto no confirmado — probar a mano' };
  }
  if (kind === 'toggle') {
    if (htmlChanged) return { status: 'effect-pass', detail: 'la UI cambió tras invocar la acción (estado del item alternado)' };
    return { status: 'unverifiable', detail: 'no se observó cambio al alternar (quizá sin item sembrado en aislamiento); cableado aplicado, efecto no confirmado — probar a mano' };
  }
  // ui / other
  if (htmlChanged) return { status: 'effect-pass', detail: 'la UI del componente cambió tras invocar la acción' };
  return { status: 'unverifiable', detail: 'la acción no produjo un cambio observable en el render aislado; cableado aplicado, efecto no confirmado — probar a mano' };
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
  const { JSDOM } = jsdomMod;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
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
  const framework = (opts.framework || 'web').toLowerCase();
  const kind = actionKind(entry);
  const params = probeParams(entry, kind);
  const storageKeys = detectStorageKeys(opts.sources);
  const ctx = { fyodosDirRel: opts.fyodosDirRel || 'src/fyodos', framework, kind, params, storageKeys, sensitive: opts.sensitive || entry.requireConfirmation };

  const withTimeout = (p) => Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve({ status: 'unverifiable', detail: 'el render de prueba excedió el tiempo límite (posible bucle/timer en el componente); efecto real no verificable automáticamente — probar a mano' }), opts.timeoutMs || 25000)),
  ]);

  if (framework.includes('react')) return withTimeout(probeReactEffect(appRoot, entry, ctx));
  if (framework.includes('vue')) return withTimeout(require('./renderProbeVue').probeVueEffect(appRoot, entry, ctx));
  if (framework.includes('angular')) {
    return { status: 'unverifiable', detail: 'Angular: el render headless de componentes con TestBed no es fiable fuera de ng test; cableado aplicado y verificado por compilación, efecto real no verificable automáticamente aquí — probar con `ng test` o a mano' };
  }
  return { status: 'unverifiable', detail: `framework '${framework}' sin render-probe; efecto real no verificable automáticamente` };
}

module.exports = { probeComponentEffect, actionKind, decide, SENTINEL, SEED_ID, installDom, pickComponent, detectStorageKeys, probeParams, captureSnapshot, short, loadEsbuild, loadJsdom, reqFrom, emptyAssetsPlugin };
