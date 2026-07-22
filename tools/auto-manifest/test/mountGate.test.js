/**
 * Regression tests for the bridge mount gate: context/provider hooks must not
 * register in conditionally-mounted components (Settings panel, inactive tab).
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  checkBridgeMountGate,
  usesContextProviderPattern,
  bridgeFileLooksConditionalOnly,
  findProviderShell,
} = require('../src/mountGate');
const { buildAiBridgeEntry } = require('../src/wireHandlers');

function makeFixture(extra = {}) {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-mount-gate-'));
  fs.mkdirSync(path.join(appRoot, 'src/components'), { recursive: true });
  fs.mkdirSync(path.join(appRoot, 'src/context'), { recursive: true });

  fs.writeFileSync(
    path.join(appRoot, 'src/context/AppProvider.tsx'),
    [
      "import React, { useState } from 'react';",
      '',
      'export function useApp() {',
      '  throw new Error("useApp outside provider");',
      '}',
      '',
      'export function AppProvider({ children }: { children: React.ReactNode }) {',
      '  const [workspace, setWorkspace] = useState({ voiceMode: "device" });',
      '  const patchWorkspace = (patch: Record<string, unknown>) =>',
      '    setWorkspace((prev) => ({ ...prev, ...patch }));',
      '  return (',
      '    <div data-provider>',
      '      {children}',
      '    </div>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(appRoot, 'src/components/Settings.tsx'),
    [
      "import { useApp } from '../context/AppProvider';",
      '',
      'export function Settings() {',
      '  const { patchWorkspace } = useApp();',
      '  return <button onClick={() => patchWorkspace({ voiceMode: "premium" })}>Save</button>;',
      '}',
      '',
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(appRoot, 'src/App.tsx'),
    [
      "import React, { useState } from 'react';",
      "import { AppProvider } from './context/AppProvider';",
      "import { Settings } from './components/Settings';",
      '',
      'export function App() {',
      "  const [view, setView] = useState('home');",
      '  return (',
      '    <AppProvider>',
      "      {view === 'settings' && <Settings />}",
      '    </AppProvider>',
      '  );',
      '}',
      '',
    ].join('\n'),
  );

  return { appRoot, ...extra };
}

test('usesContextProviderPattern detects hooks and provider symbols', () => {
  assert.strictEqual(
    usesContextProviderPattern({
      invoke: 'patchWorkspace({ mode: args.mode })',
      requiredSymbols: [{ name: 'useApp', file: 'src/context/AppProvider.tsx' }],
      bridgeImports: [],
    }),
    true,
  );
  assert.strictEqual(
    usesContextProviderPattern({
      invoke: 'addTodo(args.title)',
      requiredSymbols: [{ name: 'addTodo', file: 'src/store/todos.ts' }],
      bridgeImports: [],
    }),
    false,
  );
});

test('bridgeFileLooksConditionalOnly flags Settings path and parent conditional mount', () => {
  const { appRoot } = makeFixture();
  assert.strictEqual(bridgeFileLooksConditionalOnly(appRoot, 'src/components/Settings.tsx'), true);
  assert.strictEqual(bridgeFileLooksConditionalOnly(appRoot, 'src/context/AppProvider.tsx'), false);
});

test('findProviderShell resolves AppProvider from requiredSymbols', () => {
  const { appRoot } = makeFixture();
  const provider = findProviderShell(appRoot, {
    requiredSymbols: [{ name: 'useApp', file: 'src/context/AppProvider.tsx' }],
    bridgeImports: [],
    hookNames: ['useApp'],
  });
  assert.strictEqual(provider, 'src/context/AppProvider.tsx');
});

test('checkBridgeMountGate rejects Settings-only anchor when no provider is findable', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-mount-reject-'));
  fs.mkdirSync(path.join(appRoot, 'src/components'), { recursive: true });
  fs.writeFileSync(
    path.join(appRoot, 'src/components/Settings.tsx'),
    "export function Settings() {\n  const { patch } = useSettings();\n  return null;\n}\n",
  );
  fs.writeFileSync(
    path.join(appRoot, 'src/App.tsx'),
    "import { Settings } from './components/Settings';\nexport const App = () => view === 'settings' && <Settings />;\n",
  );

  const gate = checkBridgeMountGate({
    appRoot,
    bridgeFile: 'src/components/Settings.tsx',
    invoke: 'patch({ mode: args.mode })',
    requiredSymbols: [{ name: 'useSettings', file: 'src/hooks/useSettings.ts' }],
    bridgeImports: [],
  });
  assert.strictEqual(gate.action, 'reject');
  assert.match(gate.reason, /conditionally/i);
});

test('checkBridgeMountGate auto-promotes Settings anchor to AppProvider', () => {
  const { appRoot } = makeFixture();
  const gate = checkBridgeMountGate({
    appRoot,
    bridgeFile: 'src/components/Settings.tsx',
    invoke: 'patchWorkspace({ voiceMode: args.mode })',
    requiredSymbols: [{ name: 'useApp', file: 'src/context/AppProvider.tsx' }],
    bridgeImports: [{ kind: 'named', name: 'useApp', from: 'src/context/AppProvider.tsx' }],
  });
  assert.strictEqual(gate.action, 'promote');
  assert.strictEqual(gate.file, 'src/context/AppProvider.tsx');
  assert.ok(gate.anchor, 'promoted anchor must be set');
});

test('checkBridgeMountGate passes when bridge.file is already the Provider', () => {
  const { appRoot } = makeFixture();
  const gate = checkBridgeMountGate({
    appRoot,
    bridgeFile: 'src/context/AppProvider.tsx',
    invoke: 'patchWorkspace({ voiceMode: args.mode })',
    requiredSymbols: [{ name: 'patchWorkspace', file: 'src/context/AppProvider.tsx' }],
    bridgeImports: [],
  });
  assert.strictEqual(gate.action, 'pass');
});

test('buildAiBridgeEntry integrates mount gate promotion end-to-end', () => {
  const { appRoot } = makeFixture();
  const entry = buildAiBridgeEntry({
    appRoot,
    fyodosDirRel: 'src/fyodos',
    base: { intent: 'select_voice_mode', manifestParams: [{ name: 'mode', required: true }] },
    aiW: {
      strategy: 'bridge',
      bridgeReason: 'component-local context setter',
      requiredSymbols: [{ name: 'useApp', file: 'src/context/AppProvider.tsx' }],
      bridge: {
        file: 'src/components/Settings.tsx',
        anchor: 'return (',
        scope: 'statement',
        invoke: 'patchWorkspace({ voiceMode: args.mode })',
        imports: [{ kind: 'named', name: 'useApp', from: 'src/context/AppProvider.tsx' }],
      },
    },
  });
  assert.ok(entry.kind === 'bridge', entry.reason || 'expected bridge entry');
  assert.strictEqual(entry.bridge.file, 'src/context/AppProvider.tsx');
  assert.strictEqual(entry.source, 'ai-mount-gate');
});
