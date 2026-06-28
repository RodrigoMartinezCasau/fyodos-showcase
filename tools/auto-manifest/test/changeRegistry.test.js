'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildRunRecord, writeChangeRegistry } = require('../src/changeRegistry');
const { wireWebOrb } = require('../src/wireWeb');

function tmpApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-changes-'));
  fs.mkdirSync(path.join(dir, 'src', 'fyodos'), { recursive: true });
  return dir;
}

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function testInitialInstallRecord() {
  const appRoot = tmpApp();
  const record = buildRunRecord(appRoot, {
    appName: 'Demo Shop',
    manifest: { actions: [{ intent: 'add_to_cart' }], routes: [] },
    publishMeta: { generatedAt: '2026-06-28T12:00:00.000Z' },
    orbResult: {
      status: 'added',
      file: 'src/main.tsx',
      planSummary: {
        strategy: 'vite-main',
        files: ['src/main.tsx'],
        created: [],
        steps: ['Add import { FiodosAgent } from @fiodos/react', 'Mount <FiodosAgent /> inside createRoot().render()'],
      },
    },
    handlerResult: {
      status: 'applied',
      autoCount: 1,
      manualCount: 0,
      docPath: path.join(appRoot, 'src/fyodos/FYODOS_HANDLERS.md'),
      registryFile: path.join(appRoot, 'src/fyodos/handlers.generated.ts'),
      editedFiles: [],
      plan: { auto: [{ intent: 'add_to_cart', kind: 'module' }], manual: [] },
    },
    registryResult: { status: 'connected', file: 'src/main.tsx' },
    envResult: {
      status: 'written',
      writePlan: {
        targetRel: '.env',
        plan: { keyVar: 'VITE_FYODOS_API_KEY', urlVar: 'VITE_FYODOS_API_URL' },
      },
    },
  });

  assert.strictEqual(record.phases.orb.applied, true);
  assert.strictEqual(record.phases.handlers.applied, true);
  assert.strictEqual(record.files.modified.some((f) => f.path === 'src/main.tsx'), true);
  assert.strictEqual(record.files.created.some((f) => f.path.includes('handlers.generated')), true);
  assert.strictEqual(record.files.docs.some((f) => f.path.includes('FYODOS_HANDLERS.md')), true);

  const body = JSON.stringify(record);
  assert.ok(!body.includes('fyd_'), 'must not contain API key values');
  assert.ok(!body.includes('sk-'), 'must not contain secrets');

  const paths = writeChangeRegistry(appRoot, record);
  assert.ok(fs.existsSync(path.join(appRoot, paths.mdRel)));
  assert.ok(fs.existsSync(path.join(appRoot, paths.jsonRel)));
  assert.ok(fs.existsSync(path.join(appRoot, paths.indexRel)));

  const md = fs.readFileSync(path.join(appRoot, paths.mdRel), 'utf8');
  assert.ok(md.includes('src/main.tsx'));
  assert.ok(md.includes('vite-main'));
  assert.ok(md.includes('FYODOS_CHANGES'));
  assert.ok(!md.includes('fyd_'));
}

function testReanalysisAppendsHistory() {
  const appRoot = tmpApp();

  const first = buildRunRecord(appRoot, {
    appName: 'Demo',
    manifest: { actions: [{ intent: 'a' }], routes: [] },
    orbResult: {
      status: 'added',
      file: 'src/main.tsx',
      planSummary: { strategy: 'vite-main', files: ['src/main.tsx'], created: [], steps: [] },
    },
    handlerResult: {
      status: 'applied',
      autoCount: 1,
      manualCount: 0,
      docPath: path.join(appRoot, 'src/fyodos/FYODOS_HANDLERS.md'),
      registryFile: path.join(appRoot, 'src/fyodos/handlers.generated.ts'),
      editedFiles: [],
      plan: { auto: [{ intent: 'a' }], manual: [] },
    },
  });
  writeChangeRegistry(appRoot, first);

  const second = buildRunRecord(appRoot, {
    appName: 'Demo',
    manifest: { actions: [{ intent: 'a' }, { intent: 'b' }], routes: [] },
    orbResult: { status: 'already', file: 'src/main.tsx' },
    handlerResult: {
      status: 'applied',
      autoCount: 2,
      manualCount: 0,
      docPath: path.join(appRoot, 'src/fyodos/FYODOS_HANDLERS.md'),
      registryFile: path.join(appRoot, 'src/fyodos/handlers.generated.ts'),
      editedFiles: [],
      plan: { auto: [{ intent: 'a' }, { intent: 'b' }], manual: [] },
    },
  });
  writeChangeRegistry(appRoot, second);

  const md = fs.readFileSync(path.join(appRoot, 'src/fyodos/FYODOS_CHANGES.md'), 'utf8');
  const runs = md.split('## Run ').length - 1;
  assert.strictEqual(runs, 2, 'must append a second run section');

  assert.ok(second.delta, 'second run should compute delta');
  assert.deepStrictEqual(second.delta.actionsAdded, ['b']);
  assert.deepStrictEqual(second.delta.actionsRemoved, []);

  const index = JSON.parse(fs.readFileSync(path.join(appRoot, '.fyodos/changes/index.json'), 'utf8'));
  assert.strictEqual(index.runs.length, 2);
}

async function testOrbIntegrationWritesRegistry() {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-changes-orb-'));
  write(
    path.join(appRoot, 'package.json'),
    JSON.stringify({ dependencies: { vite: '1', react: '19', '@fiodos/react': '0.1.0' } }),
  );
  write(
    path.join(appRoot, 'src/main.tsx'),
    `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
  );

  const result = await wireWebOrb(appRoot, { assumeYes: true, runTest: false, colors: {} });
  assert.strictEqual(result.status, 'added');
  assert.ok(result.planSummary, 'orb result includes plan summary for registry');

  const record = buildRunRecord(appRoot, {
    appName: 'OrbTest',
    manifest: { actions: [], routes: [] },
    orbResult: result,
  });
  const paths = writeChangeRegistry(appRoot, record);
  const md = fs.readFileSync(path.join(appRoot, paths.mdRel), 'utf8');
  assert.ok(md.includes('src/main.tsx'));
  assert.ok(md.includes('vite-main'));
  assert.ok(fs.existsSync(path.join(appRoot, 'src/fyodos/FYODOS_ORB_MOUNT.md')));
}

async function main() {
  testInitialInstallRecord();
  testReanalysisAppendsHistory();
  await testOrbIntegrationWritesRegistry();
  console.log('changeRegistry.test.js: ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
