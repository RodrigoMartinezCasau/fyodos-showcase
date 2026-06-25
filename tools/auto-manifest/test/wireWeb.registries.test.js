/**
 * Unit tests for the second-pass "connect registries" step that makes the
 * mounted orb EXECUTE actions (registries={fyodosGeneratedRegistries}) with no
 * manual edit. Usage: node test/wireWeb.registries.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assessMount,
  applyMount,
  addRegistriesToMountSource,
  registryRelImport,
} = require('../src/wireWebMount');
const { detectFramework, detectTarget, connectOrbRegistries } = require('../src/wireWeb');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-reg-'));
}

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// Mount the orb in a fresh vite/react app and drop a generated registry next to
// it, mimicking exactly what the installer produces before the second pass.
function scaffoldMountedViteApp() {
  const root = tmpDir();
  write(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vite: '1', react: '19' } }));
  const main = path.join(root, 'src/main.tsx');
  write(
    main,
    `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
  );
  const fw = detectFramework(root);
  const plan = assessMount(detectTarget(root, fw), fw, root);
  applyMount(plan);
  const registry = path.join(root, 'src/fyodos/handlers.generated.ts');
  write(registry, `export const fyodosGeneratedRegistries = { handlers: {}, idempotencyCheckers: {} };\n`);
  return { root, main, registry };
}

function testConnectsRegistries() {
  const { root, main, registry } = scaffoldMountedViteApp();
  const res = connectOrbRegistries(root, { registryFileAbs: registry });
  assert.strictEqual(res.status, 'connected', 'should connect');
  const out = fs.readFileSync(main, 'utf8');
  assert.ok(/registries=\{fyodosGeneratedRegistries\}/.test(out), 'registries prop added');
  assert.ok(
    /import \{ fyodosGeneratedRegistries \} from '\.\/fyodos\/handlers\.generated'/.test(out),
    'registry import added with correct relative path',
  );
  // The prop lands inside the reversible ORB block.
  const block = out.slice(out.indexOf('FYODOS:ORB:START'), out.indexOf('FYODOS:ORB:END'));
  assert.ok(/registries=\{fyodosGeneratedRegistries\}/.test(block), 'prop inside FYODOS:ORB block');
  console.log('PASS connects registries into the mounted orb');
}

function testIdempotent() {
  const { root, main, registry } = scaffoldMountedViteApp();
  connectOrbRegistries(root, { registryFileAbs: registry });
  const first = fs.readFileSync(main, 'utf8');
  const second = connectOrbRegistries(root, { registryFileAbs: registry });
  assert.strictEqual(second.status, 'already', 'second run is a no-op');
  assert.strictEqual(fs.readFileSync(main, 'utf8'), first, 'file unchanged on re-run');
  const propCount = (first.match(/registries=\{fyodosGeneratedRegistries\}/g) || []).length;
  const importCount = (first.match(/import \{ fyodosGeneratedRegistries \}/g) || []).length;
  assert.strictEqual(propCount, 1, 'exactly one registries prop');
  assert.strictEqual(importCount, 1, 'exactly one registry import');
  console.log('PASS idempotent across re-runs (no duplicates)');
}

function testNavOnlyUntouched() {
  // A nav-only app: orb mounted, but the caller never calls connect (no
  // auto-wired handlers). Simulate "no registry file" → connect is a safe no-op
  // and the mounted orb keeps working (navigation only).
  const { root, main } = scaffoldMountedViteApp();
  const before = fs.readFileSync(main, 'utf8');
  const res = connectOrbRegistries(root, { registryFileAbs: path.join(root, 'src/fyodos/handlers.generated.ts.nope') });
  assert.strictEqual(res.status, 'no-registry', 'no registry → no-op');
  assert.strictEqual(fs.readFileSync(main, 'utf8'), before, 'nav-only file untouched');
  assert.ok(!/registries=/.test(fs.readFileSync(main, 'utf8')), 'no registries prop for nav-only');
  console.log('PASS nav-only app left untouched (no registries forced)');
}

function testNonReactSkipped() {
  // Vue mount: registries={...} is a React-only prop, so the step must skip
  // cleanly (the doc still instructs how to pass handlers for that SDK).
  const root = tmpDir();
  write(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '3', vite: '1' } }));
  const app = path.join(root, 'src/App.vue');
  write(app, `<script setup lang="ts">\n</script>\n<template>\n  <div />\n</template>\n`);
  const fw = detectFramework(root);
  applyMount(assessMount(detectTarget(root, fw), fw, root));
  const registry = path.join(root, 'src/fyodos/handlers.generated.ts');
  write(registry, `export const fyodosGeneratedRegistries = { handlers: {}, idempotencyCheckers: {} };\n`);
  const res = connectOrbRegistries(root, { registryFileAbs: registry });
  assert.strictEqual(res.status, 'unsupported-framework', 'vue is not auto-connected');
  console.log('PASS non-React (vue) skipped cleanly');
}

function testReactReturnStrategy() {
  // App.tsx with a JSX return (react-return strategy), no createRoot.
  const root = tmpDir();
  write(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vite: '1', react: '19' } }));
  const appFile = path.join(root, 'src/App.tsx');
  write(
    appFile,
    `export default function App() {\n  return (\n    <div className="app">\n      <h1>Hi</h1>\n    </div>\n  );\n}\n`,
  );
  const fw = detectFramework(root);
  applyMount(assessMount(detectTarget(root, fw), fw, root));
  const registry = path.join(root, 'src/fyodos/handlers.generated.ts');
  write(registry, `export const fyodosGeneratedRegistries = { handlers: {}, idempotencyCheckers: {} };\n`);
  const res = connectOrbRegistries(root, { registryFileAbs: registry });
  assert.strictEqual(res.status, 'connected', 'react-return connects');
  const out = fs.readFileSync(appFile, 'utf8');
  assert.ok(/registries=\{fyodosGeneratedRegistries\}/.test(out), 'prop added in App.tsx');
  console.log('PASS react-return strategy connects');
}

function testRelImport() {
  const reg = '/proj/src/fyodos/handlers.generated.ts';
  assert.strictEqual(registryRelImport('/proj/src/main.tsx', reg), './fyodos/handlers.generated');
  assert.strictEqual(registryRelImport('/proj/src/app/layout.tsx', reg), '../fyodos/handlers.generated');
  console.log('PASS relative import path computation');
}

function testAddIsPureWhenAlreadyPresent() {
  const src = `import { FiodosAgent } from '@fiodos/react';\n<FiodosAgent\n  apiKey={k}\n  registries={fyodosGeneratedRegistries}\n/>\n`;
  const res = addRegistriesToMountSource(src, 'fyodosGeneratedRegistries', './fyodos/handlers.generated');
  assert.strictEqual(res.changed, false);
  assert.strictEqual(res.reason, 'already');
  console.log('PASS no-op when registries already present');
}

testConnectsRegistries();
testIdempotent();
testNavOnlyUntouched();
testNonReactSkipped();
testReactReturnStrategy();
testRelImport();
testAddIsPureWhenAlreadyPresent();
console.log('ALL wireWeb.registries tests passed');
