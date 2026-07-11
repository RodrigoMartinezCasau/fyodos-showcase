/**
 * Unit tests for the automatic SESSION wiring (auth awareness with no manual
 * step): plan verification, codegen, component bridge edits, and mount
 * connection for web (React + entry bootstrap) and React Native.
 * Usage: node test/wireSession.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  wireSession,
  prepareSessionPlan,
  buildSessionModule,
  planSessionComponentEdit,
  applySessionComponentEdit,
  stripSessionBlocks,
} = require('../src/wireSession');
const { addSessionToMountSource, addSessionToBootstrapSource, buildEntryBootstrapBlock, assessMount, applyMount } = require('../src/wireWebMount');
const { detectFramework, detectTarget, connectOrbSession } = require('../src/wireWeb');
const { connectRnSession } = require('../src/wireReactNative');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-session-'));
}

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// ── Plan verification ──────────────────────────────────────────────────────────

function scaffoldModuleApp() {
  const root = tmpDir();
  write(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vite: '1', react: '19' } }));
  write(path.join(root, 'tsconfig.json'), '{}');
  write(
    path.join(root, 'src/lib/clientStore.ts'),
    `export function loadSession() {\n  return JSON.parse(localStorage.getItem('s') || 'null');\n}\n`,
  );
  return root;
}

const moduleSessionBlock = {
  hasLogin: true,
  strategy: 'module',
  imports: [{ kind: 'named', name: 'loadSession', from: 'src/lib/clientStore.ts' }],
  isAuthenticatedCall: 'Boolean(loadSession())',
  userIdCall: 'loadSession()?.email ?? null',
  requiredSymbols: [{ name: 'loadSession', file: 'src/lib/clientStore.ts' }],
  reason: 'session persisted by clientStore',
};

function testModulePlanVerifies() {
  const root = scaffoldModuleApp();
  const res = prepareSessionPlan({ appRoot: root, session: moduleSessionBlock, fyodosDirRel: 'src/fyodos' });
  assert.ok(res.plan, `plan expected, got: ${res.reason}`);
  assert.strictEqual(res.plan.strategy, 'module');
  assert.strictEqual(res.plan.isAuthExpr, 'Boolean(loadSession())');
  console.log('PASS module plan verifies against real code');
}

function testHallucinatedSymbolRejected() {
  const root = scaffoldModuleApp();
  const bad = { ...moduleSessionBlock, isAuthenticatedCall: 'Boolean(getGhostSession())' };
  const res = prepareSessionPlan({ appRoot: root, session: bad, fyodosDirRel: 'src/fyodos' });
  assert.ok(!res.plan, 'hallucinated identifier must fail closed');
  assert.ok(/getGhostSession/.test(res.reason), `reason names the culprit: ${res.reason}`);
  console.log('PASS hallucinated identifiers fail closed (review, never wired blind)');
}

function testNoLogin() {
  const root = scaffoldModuleApp();
  const res = prepareSessionPlan({
    appRoot: root,
    session: { hasLogin: false, reason: 'marketing landing, no auth' },
    fyodosDirRel: 'src/fyodos',
  });
  assert.ok(res.none, 'hasLogin false → none');
  console.log('PASS apps without login are honestly skipped');
}

// ── Codegen (tri-state honesty contract) ───────────────────────────────────────

function testModuleCodegenTriState() {
  const root = scaffoldModuleApp();
  const { plan } = prepareSessionPlan({ appRoot: root, session: moduleSessionBlock, fyodosDirRel: 'src/fyodos' });
  const src = buildSessionModule(plan, { ts: true, esm: true });
  assert.ok(src.includes('export function fyodosIsAuthenticated(): boolean | null'), 'tri-state signature');
  assert.ok(src.includes('return Boolean(Boolean(loadSession()))') || src.includes('return Boolean(loadSession())'), 'reads the real session');
  assert.ok(src.includes('return null;'), 'unknown → null, never a fake boolean');
  assert.ok(src.includes("import { loadSession } from '../lib/clientStore'"), 'relative import to the app module');
  console.log('PASS module codegen keeps the tri-state honesty contract');
}

function testBridgeCodegenReadsBridge() {
  const src = buildSessionModule(
    { strategy: 'bridge', bridge: {} },
    { ts: true, esm: true },
  );
  assert.ok(src.includes("getFiodosBridge()[\"__fyodos_is_authenticated\"]"), 'reads the bridge method');
  assert.ok(src.includes("if (typeof fn !== 'function') return null;"), 'bridge not registered yet → null (UNKNOWN)');
  console.log('PASS bridge codegen returns null (UNKNOWN) until the component registers');
}

// ── Bridge component edit ──────────────────────────────────────────────────────

function scaffoldBridgeApp() {
  const root = tmpDir();
  write(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vite: '1', react: '19' } }));
  write(path.join(root, 'tsconfig.json'), '{}');
  write(
    path.join(root, 'src/context/AuthProvider.tsx'),
    `import { createContext, useState } from 'react';\n\nexport const AuthContext = createContext(null);\n\nexport function AuthProvider({ children }) {\n  const [session, setSession] = useState(null);\n  const value = { session, setSession };\n  return (\n    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>\n  );\n}\n`,
  );
  return root;
}

const bridgeSessionBlock = {
  hasLogin: true,
  strategy: 'bridge',
  bridge: {
    file: 'src/context/AuthProvider.tsx',
    scope: 'statement',
    anchor: 'const value = { session, setSession };',
    isAuthenticatedInvoke: 'Boolean(session)',
    userIdInvoke: 'session?.email ?? null',
    imports: [],
  },
  requiredSymbols: [{ name: 'session', file: 'src/context/AuthProvider.tsx' }],
  reason: 'session lives in AuthProvider component state',
};

function testBridgeEditAppliedAndIdempotent() {
  const root = scaffoldBridgeApp();
  const { plan } = prepareSessionPlan({ appRoot: root, session: bridgeSessionBlock, fyodosDirRel: 'src/fyodos' });
  assert.ok(plan, 'bridge plan verifies');
  const edit = planSessionComponentEdit(root, plan);
  applySessionComponentEdit(root, edit);
  const out = fs.readFileSync(path.join(root, 'src/context/AuthProvider.tsx'), 'utf8');
  assert.ok(out.includes('FYODOS:SESSION:START'), 'session markers present');
  assert.ok(out.includes('"__fyodos_is_authenticated": () => (Boolean(session))'), 'live session registered');
  assert.ok(out.includes('"__fyodos_user_id": () => (session?.email ?? null)'), 'user id registered');
  // The registration must sit BEFORE the JSX return so `session` is in scope.
  assert.ok(out.indexOf('registerFiodosBridge') < out.indexOf('return ('), 'registered before the return');

  // Idempotent: applying again does not duplicate.
  applySessionComponentEdit(root, edit);
  const out2 = fs.readFileSync(path.join(root, 'src/context/AuthProvider.tsx'), 'utf8');
  assert.strictEqual((out2.match(/__fyodos_is_authenticated/g) || []).length, 1, 'no duplicates on re-run');
  // And fully reversible.
  const stripped = stripSessionBlocks(out2);
  assert.ok(!stripped.includes('fyodos'), 'stripSessionBlocks reverts everything we inserted');
  console.log('PASS bridge edit is applied, in scope, idempotent and reversible');
}

function testBridgeNeverSharesHandlerMarkers() {
  // A session edit in a file that ALREADY has a handler FYODOS:BRIDGE block
  // must not strip it (separate marker namespaces).
  const root = scaffoldBridgeApp();
  const file = path.join(root, 'src/context/AuthProvider.tsx');
  const withHandlerBlock = fs
    .readFileSync(file, 'utf8')
    .replace(
      'const value = { session, setSession };',
      `const value = { session, setSession };\n  // FYODOS:BRIDGE:START (generated by Fiodos — safe to remove)\n  registerFiodosBridge({ "do_thing": () => (setSession(null)) });\n  // FYODOS:BRIDGE:END`,
    );
  fs.writeFileSync(file, withHandlerBlock);

  const { plan } = prepareSessionPlan({ appRoot: root, session: bridgeSessionBlock, fyodosDirRel: 'src/fyodos' });
  const edit = planSessionComponentEdit(root, plan);
  applySessionComponentEdit(root, edit);
  const out = fs.readFileSync(file, 'utf8');
  assert.ok(out.includes('"do_thing"'), 'the handler bridge block SURVIVES the session edit');
  assert.ok(out.includes('__fyodos_is_authenticated'), 'the session block is added');
  console.log('PASS session edits never destroy handler bridge blocks (separate markers)');
}

// ── Session capabilities (Eje B audience map) ──────────────────────────────────

function testModuleCapabilitiesVerifiedIndividually() {
  const root = scaffoldModuleApp();
  const session = {
    ...moduleSessionBlock,
    capabilities: [
      { name: 'has_payment_method', call: 'Boolean(loadSession()?.paymentMethods?.length)' },
      { name: 'is_admin', call: 'Boolean(getGhostRole())' }, // hallucinated → dropped alone
      { name: 'BadName!', call: 'Boolean(loadSession())' }, // invalid name → dropped
    ],
  };
  const res = prepareSessionPlan({ appRoot: root, session, fyodosDirRel: 'src/fyodos' });
  assert.ok(res.plan, `plan expected, got: ${res.reason}`);
  assert.deepStrictEqual(
    res.plan.capabilities.map((c) => c.name),
    ['has_payment_method'],
    'only the verifiable capability survives',
  );
  assert.strictEqual(res.plan.capabilityNotes.length, 2, 'each dropped capability leaves an honest note');
  assert.ok(res.plan.capabilityNotes.some((n) => /is_admin/.test(n)), 'names the hallucinated one');

  const src = buildSessionModule(res.plan, { ts: true, esm: true });
  assert.ok(src.includes('export function fyodosGetSessionCapabilities(): Record<string, boolean> | null'), 'caps export');
  assert.ok(src.includes('caps["has_payment_method"] = Boolean('), 'reads the real conditional');
  assert.ok(!src.includes('getGhostRole'), 'the dropped capability never reaches the generated code');
  assert.ok(!src.includes('caps["is_admin"]'), 'no entry is generated for the dropped flag');
  console.log('PASS module capabilities are verified individually (one bad flag never costs the rest)');
}

function testBridgeCapabilitiesRegistered() {
  const root = scaffoldBridgeApp();
  const session = {
    ...bridgeSessionBlock,
    bridge: { ...bridgeSessionBlock.bridge },
    capabilities: [{ name: 'has_profile', invoke: 'Boolean(session?.profile)' }],
  };
  const { plan } = prepareSessionPlan({ appRoot: root, session, fyodosDirRel: 'src/fyodos' });
  assert.ok(plan, 'bridge plan with capabilities verifies');
  assert.deepStrictEqual(plan.bridge.capabilities.map((c) => c.name), ['has_profile']);
  const edit = planSessionComponentEdit(root, plan);
  applySessionComponentEdit(root, edit);
  const out = fs.readFileSync(path.join(root, 'src/context/AuthProvider.tsx'), 'utf8');
  assert.ok(
    out.includes('"__fyodos_capabilities": () => ({ "has_profile": Boolean(Boolean(session?.profile)) })'),
    'live capabilities registered through the bridge',
  );
  console.log('PASS bridge capabilities are registered next to the live session');
}

// ── End-to-end wireSession (module strategy) + mount connection ────────────────

function scaffoldMountedViteApp() {
  const root = scaffoldModuleApp();
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

async function testWireSessionEndToEnd() {
  const { root, main } = scaffoldMountedViteApp();
  const res = await wireSession(root, {
    session: {
      ...moduleSessionBlock,
      capabilities: [{ name: 'has_payment_method', call: 'Boolean(loadSession()?.paymentMethods?.length)' }],
    },
    assumeYes: true,
    quiet: true,
    appName: 'Demo',
  });
  assert.ok(res.status === 'applied' || res.status === 'applied-untested', `applied, got ${res.status}`);
  assert.ok(fs.existsSync(res.sessionFile), 'session.generated written');
  assert.ok(fs.existsSync(res.docPath), 'FYODOS_SESSION.md written');

  const connected = connectOrbSession(root, { sessionFileAbs: res.sessionFile });
  assert.strictEqual(connected.status, 'connected', `mount connected, got ${connected.status}`);
  const out = fs.readFileSync(main, 'utf8');
  assert.ok(/isAuthenticated=\{fyodosIsAuthenticated\}/.test(out), 'isAuthenticated prop added');
  assert.ok(/getUserId=\{fyodosGetUserId\}/.test(out), 'getUserId prop added');
  assert.ok(
    /getSessionCapabilities=\{fyodosGetSessionCapabilities\}/.test(out),
    'capabilities prop added (the generated module exports it)',
  );
  assert.ok(
    /import \{ fyodosIsAuthenticated, fyodosGetUserId, fyodosGetSessionCapabilities \} from '\.\/fyodos\/session\.generated'/.test(
      out,
    ),
    'session import added',
  );

  // Idempotent.
  const again = connectOrbSession(root, { sessionFileAbs: res.sessionFile });
  assert.strictEqual(again.status, 'already', 'second connect is a no-op');
  console.log('PASS end-to-end: session generated, documented and connected to the mount');
}

function testMountNeverOverridesDevWiring() {
  const source = `import { FiodosAgent } from '@fiodos/react';\n<FiodosAgent\n  apiKey={KEY}\n  isAuthenticated={() => Boolean(mySession)}\n/>\n`;
  const res = addSessionToMountSource(source, './fyodos/session.generated');
  assert.strictEqual(res.changed, false);
  assert.strictEqual(res.reason, 'dev-wired', 'a developer-wired isAuthenticated is never overridden');
  console.log('PASS a developer-wired isAuthenticated is respected');
}

// ── Entry bootstrap (Vue / Svelte) ──────────────────────────────────────────────

function testBootstrapSessionPreservesRegistries() {
  const block = buildEntryBootstrapBlock({ registryImportPath: './fyodos/handlers.generated' });
  const source = `import { createApp } from 'vue';\n\n${block}\n\ncreateApp({}).mount('#app');\n`;
  const res = addSessionToBootstrapSource(source, './fyodos/session.generated');
  assert.ok(res.changed, 'bootstrap rewritten');
  assert.ok(/isAuthenticated: fyodosIsAuthenticated/.test(res.source), 'session option added');
  assert.ok(/getUserId: fyodosGetUserId/.test(res.source), 'getUserId option added');
  assert.ok(/registries: fyodosGeneratedRegistries/.test(res.source), 'REGISTRIES SURVIVE the session pass');
  const second = addSessionToBootstrapSource(res.source, './fyodos/session.generated');
  assert.strictEqual(second.changed, false, 'idempotent');
  console.log('PASS entry-bootstrap session pass preserves registries and is idempotent');
}

// ── React Native ────────────────────────────────────────────────────────────────

function testRnMountConnection() {
  const root = tmpDir();
  write(
    path.join(root, 'app/_layout.tsx'),
    `import { Stack } from 'expo-router';\n// FYODOS:ORB:START (auto-generated — safe to remove)\nimport { FiodosExpoAgent } from '@fiodos/react-native/expo';\nimport fyodosManifest from '../fyodos/manifest.json';\n// FYODOS:ORB:END\n\nexport default function Layout() {\n  return (\n    <FiodosExpoAgent manifest={fyodosManifest as never}>\n      <Stack />\n    </FiodosExpoAgent>\n  );\n}\n`,
  );
  const sessionAbs = path.join(root, 'fyodos/session.generated.ts');
  write(sessionAbs, 'export function fyodosIsAuthenticated() { return null; }\nexport function fyodosGetUserId() { return null; }\n');

  const res = connectRnSession(root, { sessionFileAbs: sessionAbs });
  assert.strictEqual(res.status, 'connected', `RN connected, got ${res.status} ${res.reason || ''}`);
  const out = fs.readFileSync(path.join(root, 'app/_layout.tsx'), 'utf8');
  assert.ok(/isAuthenticated=\{fyodosIsAuthenticated\} getUserId=\{fyodosGetUserId\}/.test(out), 'props on the RN tag');
  assert.ok(/import \{ fyodosIsAuthenticated, fyodosGetUserId \} from '\.\.\/fyodos\/session\.generated'/.test(out), 'RN import path');

  const again = connectRnSession(root, { sessionFileAbs: sessionAbs });
  assert.strictEqual(again.status, 'already', 'RN idempotent');
  console.log('PASS React Native mount gets the session automatically too');
}

// ── Run ─────────────────────────────────────────────────────────────────────────

async function main() {
  testModulePlanVerifies();
  testHallucinatedSymbolRejected();
  testNoLogin();
  testModuleCodegenTriState();
  testBridgeCodegenReadsBridge();
  testBridgeEditAppliedAndIdempotent();
  testBridgeNeverSharesHandlerMarkers();
  testModuleCapabilitiesVerifiedIndividually();
  testBridgeCapabilitiesRegistered();
  await testWireSessionEndToEnd();
  testMountNeverOverridesDevWiring();
  testBootstrapSessionPreservesRegistries();
  testRnMountConnection();
  console.log('\nAll wireSession tests passed.');
}

main().catch((e) => {
  console.error('FAIL', e && e.stack ? e.stack : e);
  process.exit(1);
});
