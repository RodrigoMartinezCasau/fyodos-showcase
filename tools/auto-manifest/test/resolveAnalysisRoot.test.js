/**
 * Monorepo platform + analysis-root resolution.
 *
 * Regression guard for the EVO case: a mixed monorepo whose ROOT package.json
 * has only the Fiodos mobile SDK (@fiodos/react-native) and that nests BOTH a
 * web app (frontend/, Next.js) and the real Expo app two levels deep
 * (mobile/mobile/). The CLI used to default to 'web' and analyze + wire the
 * Next.js sibling, failing the build. It must now (1) infer 'mobile' from the
 * installed SDK and (2) scope to the real runnable app, not a same-named wrapper.
 *
 * Usage: node test/resolveAnalysisRoot.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveAnalysisRoot, hasMobileDeps, hasWebDeps } = require('../src/resolveAnalysisRoot');

function write(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

function mkEvoMonorepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-monorepo-'));
  // Root: only the Fiodos mobile SDK, no framework dep of its own.
  write(path.join(root, 'package.json'), {
    name: 'evo-app',
    dependencies: { '@fiodos/core': '^0.1.7', '@fiodos/react-native': '^0.1.3' },
  });
  // Web sibling (Next.js) — must NOT be chosen for a mobile target.
  write(path.join(root, 'frontend', 'package.json'), {
    name: 'physics-copilot-frontend',
    dependencies: { next: '14.2.0', react: '19.1.0' },
    scripts: { build: 'next build' },
  });
  write(path.join(root, 'frontend', 'next.config.js'), 'module.exports = {};');
  // Thin wrapper: same name as the real app, has RN deps but is NOT runnable.
  write(path.join(root, 'mobile', 'package.json'), {
    name: 'evoconn-mobile-src',
    dependencies: { 'expo-router': '~6.0.0', 'react-native': '0.81.5' },
  });
  fs.mkdirSync(path.join(root, 'mobile', 'app'), { recursive: true });
  // The REAL Expo app, two levels deep.
  write(path.join(root, 'mobile', 'mobile', 'package.json'), {
    name: 'mobile',
    main: 'expo-router/entry',
    dependencies: { expo: '~54.0.0', 'expo-router': '~6.0.0', 'react-native': '0.81.5' },
    scripts: { start: 'expo start', ios: 'expo run:ios' },
  });
  write(path.join(root, 'mobile', 'mobile', 'app.json'), { expo: { name: 'mobile' } });
  fs.mkdirSync(path.join(root, 'mobile', 'mobile', 'app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'mobile', 'mobile', 'ios'), { recursive: true });
  fs.mkdirSync(path.join(root, 'mobile', 'mobile', 'android'), { recursive: true });
  return root;
}

const root = mkEvoMonorepo();

// 1. Mobile target → scopes to the REAL runnable app, never the thin wrapper.
const mob = resolveAnalysisRoot(root, 'mobile');
assert.strictEqual(
  path.relative(root, mob.root),
  path.join('mobile', 'mobile'),
  'mobile target must scope to the real Expo app (mobile/mobile), not the wrapper',
);
assert.ok(mob.scoped, 'mobile scope should be marked scoped');
console.log('PASS mobile target scopes to the real nested Expo app');

// 2. Web target → still finds the Next.js sibling (no regression).
const web = resolveAnalysisRoot(root, 'web');
assert.strictEqual(path.relative(root, web.root), 'frontend', 'web target must scope to frontend/');
console.log('PASS web target still scopes to the Next.js frontend');

// 3. Dep helpers behave.
assert.ok(hasMobileDeps({ 'react-native': '0.81.5' }));
assert.ok(hasWebDeps({ next: '14' }));
assert.ok(!hasWebDeps({ expo: '54' }));
console.log('PASS dep helpers classify mobile/web frameworks');

fs.rmSync(root, { recursive: true, force: true });
console.log('ALL resolveAnalysisRoot tests passed');
