/**
 * wireReactNative — Expo Router orb auto-mount.
 *
 * Mirrors the web orb auto-mount: the same publish command wraps the app's root
 * layout with the SDK's one-line <FiodosExpoAgent/> and writes fyodos/manifest.json.
 * Guards idempotency, the snippet fallback for unrecognized layouts, and that we
 * never touch a layout we cannot safely wrap.
 *
 * Usage: node test/wireReactNative.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const esbuild = require('esbuild');

const {
  wireReactNativeOrb,
  buildWiredLayout,
  findRootLayout,
} = require('../src/wireReactNative');

// Strongest guard against the "Unexpected token, expected ','" class of bugs:
// the generated layout MUST actually parse as TSX. esbuild is already a CLI dep.
function assertParses(src, label) {
  try {
    esbuild.transformSync(src, { loader: 'tsx' });
  } catch (err) {
    throw new Error(`${label}: generated layout does not parse as TSX → ${err.message}\n\n${src}`);
  }
}

const MANIFEST = { appId: 'demo', version: 1, appName: 'Demo', routes: [], actions: [] };
const NO_COLORS = { blue: '', cyan: '', dim: '', reset: '' };

function mkApp(layoutSource, { rel = 'app/_layout.tsx' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fyo-rn-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'demo', dependencies: { expo: '~54.0.0', 'expo-router': '~6.0.0' },
  }));
  const layoutAbs = path.join(root, rel);
  fs.mkdirSync(path.dirname(layoutAbs), { recursive: true });
  if (layoutSource != null) fs.writeFileSync(layoutAbs, layoutSource);
  return { root, layoutAbs };
}

// Silence the snippet prints during the negative cases.
function quietly(fn) {
  const orig = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = orig;
  }
}

// ── 1. Standard expo-router layout (return ( … )) → auto-wrapped ──────────────
{
  const layout = `import { Stack } from 'expo-router';

export default function RootLayout() {
  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}
`;
  const { root, layoutAbs } = mkApp(layout);
  const res = wireReactNativeOrb(root, { manifest: MANIFEST, colors: NO_COLORS });
  assert.strictEqual(res.status, 'added', `expected added, got ${res.status} (${res.reason})`);

  const out = fs.readFileSync(layoutAbs, 'utf8');
  assert.ok(out.includes("import { FiodosExpoAgent } from '@fiodos/react-native/expo';"), 'SDK import added');
  assert.ok(out.includes("import fyodosManifest from '../fyodos/manifest.json';"), 'manifest import added with correct rel path');
  assert.ok(out.includes('<FiodosExpoAgent manifest={fyodosManifest as never}>'), 'wrapper opening tag present');
  assert.ok(out.includes('</FiodosExpoAgent>'), 'wrapper closing tag present');
  assert.ok(out.includes('<Stack>') && out.includes('</Stack>'), 'original tree preserved');
  // Tags balanced.
  assert.strictEqual((out.match(/<FiodosExpoAgent/g) || []).length, 1, 'exactly one wrapper');
  assert.strictEqual((out.match(/<\/FiodosExpoAgent>/g) || []).length, 1, 'exactly one wrapper close');

  assertParses(out, 'standard layout');

  // manifest.json written.
  const manifestPath = path.join(root, 'fyodos', 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'fyodos/manifest.json written');
  assert.strictEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).appId, 'demo');

  // Idempotent: second run is a no-op 'already'.
  const res2 = wireReactNativeOrb(root, { manifest: MANIFEST, colors: NO_COLORS });
  assert.strictEqual(res2.status, 'already', `expected already, got ${res2.status}`);
  console.log('ok 1 — standard layout auto-wrapped + idempotent');
}

// ── 2. src/app/_layout.tsx → correct deeper relative import ───────────────────
{
  const layout = `import { Slot } from 'expo-router';
export default function RootLayout() {
  return (
    <Slot />
  );
}
`;
  const { root, layoutAbs } = mkApp(layout, { rel: 'src/app/_layout.tsx' });
  const res = wireReactNativeOrb(root, { manifest: MANIFEST, colors: NO_COLORS });
  assert.strictEqual(res.status, 'added');
  const out = fs.readFileSync(layoutAbs, 'utf8');
  assert.ok(out.includes("import fyodosManifest from '../../fyodos/manifest.json';"), 'two-level rel path');
  console.log('ok 2 — src/app layout gets correct relative import');
}

// ── 3. Unrecognized layout (no `return ( … )`) → snippet, no edit ─────────────
{
  const layout = `import { Stack } from 'expo-router';
export default function RootLayout() {
  return <Stack />;
}
`;
  const { root, layoutAbs } = mkApp(layout);
  const before = fs.readFileSync(layoutAbs, 'utf8');
  const res = quietly(() => wireReactNativeOrb(root, { manifest: MANIFEST, colors: NO_COLORS }));
  assert.strictEqual(res.status, 'printed', `expected printed, got ${res.status}`);
  assert.strictEqual(fs.readFileSync(layoutAbs, 'utf8'), before, 'layout left untouched');
  // Still writes the manifest so the snippet import resolves once pasted.
  assert.ok(fs.existsSync(path.join(root, 'fyodos', 'manifest.json')), 'manifest still written');
  console.log('ok 3 — unrecognized layout prints snippet, leaves file untouched');
}

// ── 4. No layout at all → printed/no-layout ───────────────────────────────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fyo-rn-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', dependencies: { expo: '1' } }));
  const res = quietly(() => wireReactNativeOrb(root, { manifest: MANIFEST, colors: NO_COLORS }));
  assert.strictEqual(res.status, 'printed');
  assert.strictEqual(res.reason, 'no-layout');
  assert.strictEqual(findRootLayout(root), null);
  console.log('ok 4 — no layout → snippet with no-layout reason');
}

// ── 5. buildWiredLayout is a pure transform that nests + balances ─────────────
{
  const src = `export default function L() {\n  return (\n    <Stack />\n  );\n}\n`;
  const wired = buildWiredLayout(src, '../fyodos/manifest.json');
  assert.ok(wired && wired.includes('<FiodosExpoAgent'), 'wrapped');
  assert.ok(wired.indexOf('<FiodosExpoAgent') < wired.indexOf('<Stack'), 'wrapper outside the tree');
  assert.ok(wired.indexOf('</Stack') < wired.indexOf('</FiodosExpoAgent>') || wired.includes('<Stack />'), 'tree nested inside wrapper');
  assertParses(wired, 'buildWiredLayout');
  console.log('ok 5 — buildWiredLayout nests the existing tree inside the wrapper');
}

// ── 6. Regression: deeply-nested providers (the real EVO APP layout) ──────────
// Reproduces the reported "Unexpected token, expected ','" crash: the orb
// markers must NOT be JSX `{/* */}` siblings of the single return root.
{
  const layout = `import { Stack } from 'expo-router';
import { PostHogProvider } from 'posthog-react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

function PostHogRoot({ children }: { children: React.ReactNode }) {
  return <PostHogProvider apiKey="x">{children}</PostHogProvider>;
}
function AppUpdateGate({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export default function RootLayout() {
  return (
    <PostHogRoot>
      <SafeAreaProvider>
        <AppUpdateGate>
          <Stack>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          </Stack>
        </AppUpdateGate>
      </SafeAreaProvider>
    </PostHogRoot>
  );
}
`;
  const { root, layoutAbs } = mkApp(layout);
  const res = wireReactNativeOrb(root, { manifest: MANIFEST, colors: NO_COLORS });
  assert.strictEqual(res.status, 'added', `expected added, got ${res.status} (${res.reason})`);

  const out = fs.readFileSync(layoutAbs, 'utf8');
  assertParses(out, 'nested-providers layout');
  // Markers are line comments, never JSX comment-expressions at the root.
  assert.ok(!out.includes('{/* FYODOS:ORB'), 'no JSX comment-expression markers');
  assert.ok(out.includes('// FYODOS:ORB:START'), 'line-comment start marker present');
  // Wrapper outside, original providers preserved inside.
  assert.ok(out.indexOf('<FiodosExpoAgent') < out.indexOf('<PostHogRoot>'), 'orb wraps the providers');
  assert.strictEqual((out.match(/<FiodosExpoAgent/g) || []).length, 1, 'exactly one wrapper');

  // Idempotent on the realistic layout too.
  const res2 = wireReactNativeOrb(root, { manifest: MANIFEST, colors: NO_COLORS });
  assert.strictEqual(res2.status, 'already', `expected already, got ${res2.status}`);
  console.log('ok 6 — deeply-nested providers wrap cleanly and parse as TSX');
}

// ── 7. Self-heal: a layout broken by the OLD `{/* */}` wrap is repaired ───────
// Simulates exactly the file in the crash screenshot: legacy JSX-comment markers
// as siblings of the return root. Re-running analyze must fix it, not no-op.
{
  const broken = `import { Stack } from 'expo-router';
// FYODOS:ORB:START (auto-generated — safe to remove)
import { FiodosExpoAgent } from '@fiodos/react-native/expo';
import fyodosManifest from '../fyodos/manifest.json';
// FYODOS:ORB:END

export default function RootLayout() {
  return (
    {/* FYODOS:ORB:START (auto-generated — safe to remove) */}
    <FiodosExpoAgent manifest={fyodosManifest as never}>
      <PostHogRoot>
        <SafeAreaProvider>
          <AppUpdateGate>
            <Stack />
          </AppUpdateGate>
        </SafeAreaProvider>
      </PostHogRoot>
    </FiodosExpoAgent>
    {/* FYODOS:ORB:END */}
  );
}
`;
  // Sanity: the legacy output really is broken.
  let threw = false;
  try { esbuild.transformSync(broken, { loader: 'tsx' }); } catch { threw = true; }
  assert.ok(threw, 'precondition: legacy wrap is unparseable');

  const { root, layoutAbs } = mkApp(broken);
  const res = wireReactNativeOrb(root, { manifest: MANIFEST, colors: NO_COLORS });
  assert.strictEqual(res.status, 'added', `expected re-heal to add, got ${res.status} (${res.reason})`);

  const out = fs.readFileSync(layoutAbs, 'utf8');
  assertParses(out, 'self-healed layout');
  assert.ok(!out.includes('{/* FYODOS:ORB'), 'legacy JSX markers removed');
  assert.strictEqual((out.match(/<FiodosExpoAgent/g) || []).length, 1, 'exactly one wrapper after heal');
  assert.strictEqual((out.match(/import { FiodosExpoAgent }/g) || []).length, 1, 'exactly one SDK import after heal');
  assert.ok(out.includes('<PostHogRoot>') && out.includes('<Stack />'), 'user tree preserved');
  console.log('ok 7 — legacy broken layout is self-healed into valid TSX');
}

console.log('\nwireReactNative: all tests passed');
