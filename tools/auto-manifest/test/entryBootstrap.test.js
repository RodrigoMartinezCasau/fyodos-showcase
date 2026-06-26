'use strict';

/**
 * Deterministic file-level verification of the entry-bootstrap orb wiring.
 * Builds throwaway app skeletons per framework, runs the real wireWebOrb +
 * connectOrbRegistries, and asserts: injection, idempotency, registries
 * connection, and revert (including deletion of files we created). No npm.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { wireWebOrb, connectOrbRegistries, detectTarget, detectFramework } = require('../src/wireWeb');

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} · ${name}${ok || extra == null ? '' : `\n      ${extra}`}`);
}

function mkapp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiodos-eb-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const has = (dir, rel) => fs.existsSync(path.join(dir, rel));

const REGISTRY = `import type { FiodosRegistries } from '@fiodos/core';\nexport const fyodosGeneratedRegistries: FiodosRegistries = { handlers: {}, idempotencyCheckers: {} };\n`;

async function vueCase() {
  const dir = mkapp({
    'package.json': JSON.stringify({ name: 'vue-app', dependencies: { vue: '^3.4.0' } }),
    'src/main.ts': `import { createApp } from 'vue'\nimport App from './App.vue'\nimport './assets/main.css'\ncreateApp(App).mount('#app')\n`,
    'src/App.vue': `<script setup lang="ts"></script>\n<template><div>hi</div></template>\n`,
    'src/fyodos/handlers.generated.ts': REGISTRY,
  });

  check('vue: detectFramework', detectFramework(dir) === 'vue');
  const t = detectTarget(dir);
  check('vue: target is entry main.ts', t.kind === 'vue-entry' && /main\.ts$/.test(t.file), JSON.stringify(t));

  const r = await wireWebOrb(dir, { assumeYes: true, runTest: false });
  check('vue: orb added', r.status === 'added', JSON.stringify(r));
  const main = read(dir, 'src/main.ts');
  check('vue: bootstrap injected', /createFiodosAgent as __fiodosCreateAgent/.test(main) && /mount: true/.test(main));
  check('vue: import from web-core', /from '@fiodos\/web-core'/.test(main));
  check('vue: template untouched', read(dir, 'src/App.vue') === `<script setup lang="ts"></script>\n<template><div>hi</div></template>\n`);
  check('vue: call runs before createApp().mount', main.indexOf('FYODOS:ORB:END') < main.indexOf("createApp(App).mount('#app')"));

  // Idempotency: a second pass must not duplicate.
  const r2 = await wireWebOrb(dir, { assumeYes: true, runTest: false });
  check('vue: second wire is already', r2.status === 'already', JSON.stringify(r2));
  const occurrences = (read(dir, 'src/main.ts').match(/FYODOS:ORB:START/g) || []).length;
  check('vue: exactly one orb block', occurrences === 1, `found ${occurrences}`);

  // Registries connection.
  const c = connectOrbRegistries(dir, { registryFileAbs: path.join(dir, 'src/fyodos/handlers.generated.ts') });
  check('vue: registries connected', c.status === 'connected', JSON.stringify(c));
  const main3 = read(dir, 'src/main.ts');
  check('vue: registries in call', /registries: fyodosGeneratedRegistries/.test(main3));
  check('vue: registry import added', /from '\.\/fyodos\/handlers\.generated'/.test(main3));
  check('vue: still one block after registries', (main3.match(/FYODOS:ORB:START/g) || []).length === 1);

  // Connecting again = idempotent.
  const c2 = connectOrbRegistries(dir, { registryFileAbs: path.join(dir, 'src/fyodos/handlers.generated.ts') });
  check('vue: registries already', c2.status === 'already', JSON.stringify(c2));
  check('vue: registries not duplicated', (read(dir, 'src/main.ts').match(/registries:/g) || []).length === 1);
}

async function svelteCase() {
  const dir = mkapp({
    'package.json': JSON.stringify({ name: 'svelte-app', dependencies: { svelte: '^4.2.0' }, devDependencies: { vite: '^5.0.0' } }),
    'src/main.ts': `import './app.css'\nimport App from './App.svelte'\nconst app = new App({ target: document.getElementById('app') })\nexport default app\n`,
    'src/App.svelte': `<main><h1>hi</h1></main>\n`,
  });
  check('svelte: detectFramework', detectFramework(dir) === 'svelte');
  const t = detectTarget(dir);
  check('svelte: target is entry main.ts', t.kind === 'svelte-entry', JSON.stringify(t));
  const r = await wireWebOrb(dir, { assumeYes: true, runTest: false });
  check('svelte: orb added', r.status === 'added', JSON.stringify(r));
  check('svelte: bootstrap injected', /createFiodosAgent/.test(read(dir, 'src/main.ts')));
  check('svelte: App.svelte untouched', read(dir, 'src/App.svelte') === `<main><h1>hi</h1></main>\n`);
}

async function sveltekitCase() {
  const dir = mkapp({
    'package.json': JSON.stringify({ name: 'kit-app', dependencies: { '@sveltejs/kit': '^2.0.0', svelte: '^4.2.0' } }),
    'src/routes/+layout.svelte': `<slot />\n`,
  });
  check('sveltekit: detectFramework', detectFramework(dir) === 'sveltekit');
  const t = detectTarget(dir);
  check('sveltekit: target is hooks.client.ts (to create)', t.kind === 'sveltekit-hooks' && /hooks\.client\.ts$/.test(t.file), JSON.stringify(t));
  check('sveltekit: hooks does not exist yet', !has(dir, 'src/hooks.client.ts'));
  const r = await wireWebOrb(dir, { assumeYes: true, runTest: false });
  check('sveltekit: orb added', r.status === 'added', JSON.stringify(r));
  check('sveltekit: hooks.client.ts created', has(dir, 'src/hooks.client.ts'));
  check('sveltekit: bootstrap in hooks', /createFiodosAgent/.test(read(dir, 'src/hooks.client.ts')));
  check('sveltekit: layout untouched', read(dir, 'src/routes/+layout.svelte') === `<slot />\n`);
}

async function reactRegressionCase() {
  const dir = mkapp({
    'package.json': JSON.stringify({ name: 'react-app', dependencies: { react: '^18', 'react-dom': '^18', vite: '^5' } }),
    'src/main.tsx': `import React from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App'\ncreateRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>\n)\n`,
  });
  check('react: detectFramework vite', detectFramework(dir) === 'vite');
  const t = detectTarget(dir);
  check('react: target stays JSX entry', t.kind === 'vite', JSON.stringify(t));
  const r = await wireWebOrb(dir, { assumeYes: true, runTest: false });
  check('react: orb added (JSX mount, unchanged)', r.status === 'added', JSON.stringify(r));
  check('react: FiodosAgent mounted in JSX', /<FiodosAgent/.test(read(dir, 'src/main.tsx')));
  check('react: uses @fiodos/react', /from '@fiodos\/react'/.test(read(dir, 'src/main.tsx')));
}

// A build that FAILS only while the orb block is present → forces the real
// regression-revert path (orb-build fails, baseline build passes).
const BREAKING_BUILD = `const fs=require('fs');const p=process.argv[2];let s='';try{s=fs.readFileSync(p,'utf8')}catch{};process.exit(/FYODOS:ORB:START/.test(s)?1:0)\n`;

async function vueRevertCase() {
  const original = `import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')\n`;
  const dir = mkapp({
    'package.json': JSON.stringify({ name: 'vue-app', dependencies: { vue: '^3.4.0' }, scripts: { build: 'node check.js src/main.ts' } }),
    'src/main.ts': original,
    'src/App.vue': `<script setup lang="ts"></script>\n<template><div>hi</div></template>\n`,
    'check.js': BREAKING_BUILD,
    'node_modules/.keep': '',
  });
  const r = await wireWebOrb(dir, { assumeYes: true, runTest: true });
  check('revert(vue): status reverted on regression', r.status === 'reverted', JSON.stringify(r));
  check('revert(vue): main.ts restored to original', read(dir, 'src/main.ts') === original, JSON.stringify(read(dir, 'src/main.ts')));
}

async function sveltekitRevertCase() {
  const dir = mkapp({
    'package.json': JSON.stringify({ name: 'kit-app', dependencies: { '@sveltejs/kit': '^2.0.0', svelte: '^4' }, scripts: { build: 'node check.js src/hooks.client.ts' } }),
    'src/routes/+layout.svelte': `<slot />\n`,
    'check.js': BREAKING_BUILD,
    'node_modules/.keep': '',
  });
  const r = await wireWebOrb(dir, { assumeYes: true, runTest: true });
  check('revert(kit): status reverted on regression', r.status === 'reverted', JSON.stringify(r));
  check('revert(kit): created hooks.client.ts deleted on revert', !has(dir, 'src/hooks.client.ts'));
}

(async () => {
  await vueCase();
  await svelteCase();
  await sveltekitCase();
  await reactRegressionCase();
  await vueRevertCase();
  await sveltekitRevertCase();
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
