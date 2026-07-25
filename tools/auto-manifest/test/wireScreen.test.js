/**
 * Unit tests for the automatic SCREEN-TRUTH wiring (state-driven screens with
 * no URL change): plan verification, codegen (staleness guard), component
 * bridge edits, and mount connection (React + entry bootstrap).
 * Usage: node test/wireScreen.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  wireScreen,
  prepareScreenPlan,
  buildScreenModule,
  planScreenComponentEdit,
  applyScreenComponentEdit,
  stripScreenBlocks,
} = require('../src/wireScreen');
const {
  addScreenToMountSource,
  addScreenToBootstrapSource,
  buildEntryBootstrapBlock,
  assessMount,
  applyMount,
} = require('../src/wireWebMount');
const { detectFramework, detectTarget, connectOrbScreen } = require('../src/wireWeb');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-screen-'));
}

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// ── Fixtures ────────────────────────────────────────────────────────────────────

function scaffoldStateScreenApp() {
  const root = tmpDir();
  write(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vite: '1', react: '19' } }));
  write(path.join(root, 'tsconfig.json'), '{}');
  // A dashboard shell whose "screens" are pure client state — the exact shape
  // that makes a URL-only orb blind (our own dashboard's DashboardShell).
  write(
    path.join(root, 'src/DashboardShell.tsx'),
    `import { useState } from 'react';\n\nexport function DashboardShell() {\n  const [section, setSection] = useState('asistente');\n  const nav = ['asistente', 'agente', 'estadisticas'];\n  return (\n    <div>\n      {nav.map((s) => (\n        <button key={s} onClick={() => setSection(s)}>{s}</button>\n      ))}\n      {section === 'asistente' && <div>Asistente</div>}\n      {section === 'agente' && <div>Agente</div>}\n    </div>\n  );\n}\n`,
  );
  return root;
}

const stateScreenBlock = {
  kind: 'state',
  bridge: {
    file: 'src/DashboardShell.tsx',
    scope: 'statement',
    anchor: "const nav = ['asistente', 'agente', 'estadisticas'];",
    screenInvoke: 'section',
    imports: [],
  },
  requiredSymbols: [{ name: 'section', file: 'src/DashboardShell.tsx' }],
  reason: 'sections are a useState switcher; the URL never changes',
};

// ── Plan verification ──────────────────────────────────────────────────────────

function testUrlScreensAreSkipped() {
  const root = scaffoldStateScreenApp();
  const res = prepareScreenPlan({
    appRoot: root,
    screen: { kind: 'url', reason: 'react-router changes the pathname' },
    fyodosDirRel: 'src/fyodos',
  });
  assert.ok(res.none, 'url screens → none (pathname already tells the truth)');
  const noBlock = prepareScreenPlan({ appRoot: root, screen: null, fyodosDirRel: 'src/fyodos' });
  assert.ok(noBlock.none, 'no screen block → none (fail-open to today)');
  console.log('PASS URL-driven apps are honestly skipped (no edit at all)');
}

function testStatePlanVerifies() {
  const root = scaffoldStateScreenApp();
  const res = prepareScreenPlan({ appRoot: root, screen: stateScreenBlock, fyodosDirRel: 'src/fyodos' });
  assert.ok(res.plan, `plan expected, got: ${res.reason}`);
  assert.strictEqual(res.plan.bridge.screenInvoke, 'section');
  console.log('PASS state plan verifies against real code');
}

function testHallucinatedStateRejected() {
  const root = scaffoldStateScreenApp();
  const bad = {
    ...stateScreenBlock,
    bridge: { ...stateScreenBlock.bridge, screenInvoke: 'ghostSection' },
    requiredSymbols: [],
  };
  const res = prepareScreenPlan({ appRoot: root, screen: bad, fyodosDirRel: 'src/fyodos' });
  assert.ok(!res.plan, 'hallucinated state identifier must fail closed');
  assert.ok(/ghostSection/.test(res.reason), `reason names the culprit: ${res.reason}`);
  console.log('PASS hallucinated screen state fails closed (review, never wired blind)');
}

function testAmbiguousAnchorIsRescued() {
  const root = scaffoldStateScreenApp();
  const bad = { ...stateScreenBlock, bridge: { ...stateScreenBlock.bridge, anchor: 'no such line' } };
  const res = prepareScreenPlan({ appRoot: root, screen: bad, fyodosDirRel: 'src/fyodos' });
  assert.ok(res.plan, `anchor derived mechanically, got: ${res.reason}`);
  assert.ok(
    res.plan.bridge.anchor.includes('section'),
    `derived anchor is the state declaration: ${res.plan.bridge.anchor}`,
  );
  console.log('PASS a bad AI anchor is rescued from the state declaration');
}

// ── Codegen (staleness guard) ───────────────────────────────────────────────────

function testCodegenStalenessGuard() {
  const src = buildScreenModule({ ts: true, esm: true });
  assert.ok(src.includes('export function fyodosGetCurrentScreen(): string | null'), 'screen export');
  assert.ok(src.includes('export function fyodosGetCurrentRoute(): string | null'), 'route export');
  assert.ok(src.includes('getFiodosBridge()["__fyodos_screen"]'), 'reads the bridge getter');
  assert.ok(src.includes('if (at != null && here != null && at !== here) return null;'), 'stale report from another page is ignored');
  assert.ok(src.includes("if (typeof fn !== 'function') return null;"), 'not registered yet → null (pathname fallback)');
  console.log('PASS codegen ignores stale reports and falls back to the pathname');
}

// ── Bridge component edit ──────────────────────────────────────────────────────

function testScreenEditAppliedAndIdempotent() {
  const root = scaffoldStateScreenApp();
  const { plan } = prepareScreenPlan({ appRoot: root, screen: stateScreenBlock, fyodosDirRel: 'src/fyodos' });
  const edit = planScreenComponentEdit(root, plan);
  applyScreenComponentEdit(root, edit);
  const file = path.join(root, 'src/DashboardShell.tsx');
  const out = fs.readFileSync(file, 'utf8');
  assert.ok(out.includes('FYODOS:SCREEN:START'), 'screen markers present');
  assert.ok(out.includes('value: (section)'), 'live section reported');
  assert.ok(out.includes('window.location.pathname'), 'pathname captured for the staleness guard');
  // Registered BEFORE the JSX return so `section` is in scope; re-runs each render.
  assert.ok(out.indexOf('registerFiodosBridge') < out.indexOf('return ('), 'registered before the return');

  applyScreenComponentEdit(root, edit);
  const out2 = fs.readFileSync(file, 'utf8');
  assert.strictEqual((out2.match(/__fyodos_screen/g) || []).length, 1, 'no duplicates on re-run');
  const stripped = stripScreenBlocks(out2);
  assert.ok(!stripped.includes('fyodos'), 'stripScreenBlocks reverts everything we inserted');
  console.log('PASS screen edit is applied, in scope, idempotent and reversible');
}

function testScreenNeverSharesOtherMarkers() {
  const root = scaffoldStateScreenApp();
  const file = path.join(root, 'src/DashboardShell.tsx');
  const withOtherBlocks = fs
    .readFileSync(file, 'utf8')
    .replace(
      "const nav = ['asistente', 'agente', 'estadisticas'];",
      `const nav = ['asistente', 'agente', 'estadisticas'];\n  // FYODOS:SESSION:START (generated by Fiodos — safe to remove)\n  registerFiodosBridge({ "__fyodos_is_authenticated": () => (true) });\n  // FYODOS:SESSION:END`,
    );
  fs.writeFileSync(file, withOtherBlocks);

  const { plan } = prepareScreenPlan({ appRoot: root, screen: stateScreenBlock, fyodosDirRel: 'src/fyodos' });
  const edit = planScreenComponentEdit(root, plan);
  applyScreenComponentEdit(root, edit);
  const out = fs.readFileSync(file, 'utf8');
  assert.ok(out.includes('__fyodos_is_authenticated'), 'the session block SURVIVES the screen edit');
  assert.ok(out.includes('__fyodos_screen'), 'the screen block is added');
  console.log('PASS screen edits never destroy session/handler blocks (separate markers)');
}

function testScreenAfterBridgeDoesNotRedeclareImport() {
  // Regression: install on apps where handlers + screen-truth wire the SAME
  // component (owner-admin App.tsx) used to emit two
  // `import { registerFiodosBridge }` and nest SCREEN inside BRIDGE → Vite
  // "Identifier has already been declared".
  const root = scaffoldStateScreenApp();
  const file = path.join(root, 'src/DashboardShell.tsx');
  const withBridge = [
    "import { useState } from 'react';",
    '// FYODOS:BRIDGE:START (generated by Fiodos — safe to remove)',
    '/* eslint-disable */',
    "import { registerFiodosBridge } from './fyodos/bridge';",
    '/* eslint-enable */',
    '// FYODOS:BRIDGE:END',
    '',
    'export function DashboardShell() {',
    "  const [section, setSection] = useState('asistente');",
    "  const nav = ['asistente', 'agente', 'estadisticas'];",
    '  return (',
    '    <div>{section}</div>',
    '  );',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(file, withBridge);

  const { plan } = prepareScreenPlan({ appRoot: root, screen: stateScreenBlock, fyodosDirRel: 'src/fyodos' });
  const edit = planScreenComponentEdit(root, plan);
  assert.ok(!edit.importBlock, 'screen must not emit a second registerFiodosBridge import');
  applyScreenComponentEdit(root, edit);
  const out = fs.readFileSync(file, 'utf8');
  const importCount = (out.match(/import\s*\{\s*registerFiodosBridge\s*\}/g) || []).length;
  assert.strictEqual(importCount, 1, `exactly one bridge import, got ${importCount}`);
  assert.ok(out.includes('__fyodos_screen'), 'screen registration still applied');
  assert.ok(
    !/FYODOS:BRIDGE:START[\s\S]*FYODOS:SCREEN:START[\s\S]*FYODOS:BRIDGE:END/.test(out),
    'SCREEN must not nest inside BRIDGE',
  );
  // Must still parse (the original compile break).
  const esbuild = require('esbuild');
  esbuild.transformSync(out, { loader: 'tsx' });
  console.log('PASS screen after bridge: one import, no nesting, file still parses');
}

// ── End-to-end wireScreen + mount connection ───────────────────────────────────

function scaffoldMountedViteApp() {
  const root = scaffoldStateScreenApp();
  const main = path.join(root, 'src/main.tsx');
  write(
    main,
    `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
  );
  const fw = detectFramework(root);
  const plan = assessMount(detectTarget(root, fw), fw, root);
  applyMount(plan);
  return { root, main };
}

async function testWireScreenEndToEnd() {
  const { root, main } = scaffoldMountedViteApp();
  const res = await wireScreen(root, {
    screen: stateScreenBlock,
    assumeYes: true,
    quiet: true,
    appName: 'Demo',
  });
  assert.ok(res.status === 'applied' || res.status === 'applied-untested', `applied, got ${res.status} ${res.reason || ''}`);
  assert.ok(fs.existsSync(res.screenFile), 'screen.generated written');
  assert.ok(fs.existsSync(res.docPath), 'FYODOS_SCREEN.md written');

  const connected = connectOrbScreen(root, { screenFileAbs: res.screenFile });
  assert.strictEqual(connected.status, 'connected', `mount connected, got ${connected.status}`);
  const out = fs.readFileSync(main, 'utf8');
  assert.ok(/getCurrentRoute=\{fyodosGetCurrentRoute\}/.test(out), 'getCurrentRoute prop added');
  assert.ok(
    /import \{ fyodosGetCurrentRoute \} from '\.\/fyodos\/screen\.generated'/.test(out),
    'screen import added',
  );

  const again = connectOrbScreen(root, { screenFileAbs: res.screenFile });
  assert.strictEqual(again.status, 'already', 'second connect is a no-op');
  console.log('PASS end-to-end: screen truth generated, documented and connected to the mount');
}

function testMountNeverOverridesDevWiring() {
  const source = `import { FiodosAgent } from '@fiodos/react';\n<FiodosAgent\n  apiKey={KEY}\n  getCurrentRoute={() => myRoute}\n/>\n`;
  const res = addScreenToMountSource(source, './fyodos/screen.generated');
  assert.strictEqual(res.changed, false);
  assert.strictEqual(res.reason, 'dev-wired', 'a developer-wired getCurrentRoute is never overridden');
  console.log('PASS a developer-wired getCurrentRoute is respected');
}

// ── Entry bootstrap (Vue / Svelte) ──────────────────────────────────────────────

function testBootstrapScreenPreservesEarlierPasses() {
  const block = buildEntryBootstrapBlock({
    registryImportPath: './fyodos/handlers.generated',
    sessionImportPath: './fyodos/session.generated',
  });
  const source = `import { createApp } from 'vue';\n\n${block}\n\ncreateApp({}).mount('#app');\n`;
  const res = addScreenToBootstrapSource(source, './fyodos/screen.generated');
  assert.ok(res.changed, 'bootstrap rewritten');
  assert.ok(/getCurrentRoute: fyodosGetCurrentRoute/.test(res.source), 'screen option added');
  assert.ok(/registries: fyodosGeneratedRegistries/.test(res.source), 'REGISTRIES SURVIVE the screen pass');
  assert.ok(/isAuthenticated: fyodosIsAuthenticated/.test(res.source), 'SESSION SURVIVES the screen pass');
  const second = addScreenToBootstrapSource(res.source, './fyodos/screen.generated');
  assert.strictEqual(second.changed, false, 'idempotent');
  console.log('PASS entry-bootstrap screen pass preserves registries/session and is idempotent');
}

// ── Run ─────────────────────────────────────────────────────────────────────────

async function main() {
  testUrlScreensAreSkipped();
  testStatePlanVerifies();
  testHallucinatedStateRejected();
  testAmbiguousAnchorIsRescued();
  testCodegenStalenessGuard();
  testScreenEditAppliedAndIdempotent();
  testScreenNeverSharesOtherMarkers();
  testScreenAfterBridgeDoesNotRedeclareImport();
  await testWireScreenEndToEnd();
  testMountNeverOverridesDevWiring();
  testBootstrapScreenPreservesEarlierPasses();
  console.log('\nAll wireScreen tests passed.');
}

main().catch((e) => {
  console.error('FAIL', e && e.stack ? e.stack : e);
  process.exit(1);
});
