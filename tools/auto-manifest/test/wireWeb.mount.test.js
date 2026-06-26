/**
 * Unit tests for orb auto-mount injectors (all web ecosystems).
 * Usage: node test/wireWeb.mount.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assessMount,
  applyMount,
  verifyMounted,
  backupFiles,
  revertFiles,
} = require('../src/wireWebMount');
const { detectFramework, detectTarget } = require('../src/wireWeb');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-orb-'));
}

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function testViteReactMain() {
  const root = tmpDir();
  write(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vite: '1', react: '19' } }));
  const main = path.join(root, 'src/main.tsx');
  write(
    main,
    `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
  );
  const fw = detectFramework(root);
  const target = detectTarget(root, fw);
  const plan = assessMount(target, fw, root);
  assert.strictEqual(plan.ok, true, 'vite main assess');
  assert.strictEqual(plan.strategy, 'vite-main');
  const backups = backupFiles(plan.files);
  applyMount(plan);
  assert.ok(verifyMounted(plan), 'vite main verify');
  const out = fs.readFileSync(main, 'utf8');
  assert.ok(out.includes('FiodosAgent'), 'has FiodosAgent');
  assert.ok(out.includes('FYODOS:ORB:START'), 'has markers');
  revertFiles(backups);
  assert.ok(!/FiodosAgent/.test(fs.readFileSync(main, 'utf8')), 'reverted');
  console.log('PASS vite/react main.tsx');
}

function testVueSfc() {
  const root = tmpDir();
  write(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '3', vite: '1' } }));
  const app = path.join(root, 'src/App.vue');
  write(
    app,
    `<script setup lang="ts">\nimport Hello from './Hello.vue'\n</script>\n<template>\n  <Hello />\n</template>\n`,
  );
  const fw = detectFramework(root);
  const target = detectTarget(root, fw);
  const plan = assessMount(target, fw, root);
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.strategy, 'vue-sfc');
  applyMount(plan);
  assert.ok(verifyMounted(plan));
  const out = fs.readFileSync(app, 'utf8');
  assert.ok(out.includes('@fiodos/vue'));
  assert.ok(out.includes('FYODOS:ORB:START'));
  console.log('PASS vue App.vue');
}

function testSvelteKitHooksBootstrap() {
  // SvelteKit now mounts via an entry-file bootstrap in src/hooks.client.ts
  // (created if missing) instead of editing +layout.svelte markup. This also
  // lets registries auto-connect (the +layout strategy could not).
  const root = tmpDir();
  write(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@sveltejs/kit': '2', svelte: '5' } }));
  const layout = path.join(root, 'src/routes/+layout.svelte');
  const layoutSrc = `<script lang="ts">\n  let { children } = $props();\n</script>\n<main>{@render children()}</main>\n`;
  write(layout, layoutSrc);
  const fw = detectFramework(root);
  const target = detectTarget(root, fw);
  const plan = assessMount(target, fw, root);
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.strategy, 'entry-bootstrap');
  assert.strictEqual(plan.createIfMissing, true, 'hooks.client.ts should be created');
  assert.ok(/hooks\.client\.ts$/.test(plan.target.file), 'targets hooks.client.ts');
  applyMount(plan);
  assert.ok(verifyMounted(plan));
  const hooks = fs.readFileSync(path.join(root, 'src/hooks.client.ts'), 'utf8');
  assert.ok(hooks.includes('createFiodosAgent'), 'bootstrap in hooks');
  assert.strictEqual(fs.readFileSync(layout, 'utf8'), layoutSrc, '+layout.svelte untouched');
  console.log('PASS sveltekit src/hooks.client.ts bootstrap');
}

function testAngularComponent() {
  const root = tmpDir();
  write(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@angular/core': '20' } }));
  write(path.join(root, 'angular.json'), '{}');
  const ts = path.join(root, 'src/app/app.component.ts');
  const html = path.join(root, 'src/app/app.component.html');
  write(path.join(root, 'src/environments/environment.ts'), `export const environment = { fyodosApiKey: 'k', fyodosApiUrl: 'u' };\n`);
  write(
    ts,
    `import { Component } from '@angular/core';\n@Component({ selector: 'app-root', imports: [], templateUrl: './app.component.html' })\nexport class AppComponent {}\n`,
  );
  write(html, `<h1>App</h1>\n`);
  const fw = detectFramework(root);
  const target = detectTarget(root, fw);
  const plan = assessMount(target, fw, root);
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.strategy, 'angular-component');
  applyMount(plan);
  assert.ok(verifyMounted(plan));
  assert.ok(/fyodos-agent/.test(fs.readFileSync(html, 'utf8')));
  assert.ok(/FiodosAgentComponent/.test(fs.readFileSync(ts, 'utf8')));
  console.log('PASS angular app.component');
}

function testFallbackNoTemplate() {
  const root = tmpDir();
  write(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '3' } }));
  write(path.join(root, 'src/App.vue'), `<script setup>\nconst x = 1\n</script>\n`);
  const fw = detectFramework(root);
  const target = detectTarget(root, fw);
  const plan = assessMount(target, fw, root);
  assert.strictEqual(plan.ok, false);
  assert.ok(plan.reason.includes('template'));
  console.log('PASS vue fallback when no template');
}

testViteReactMain();
testVueSfc();
testSvelteKitHooksBootstrap();
testAngularComponent();
testFallbackNoTemplate();
console.log('ALL wireWeb.mount tests passed');
