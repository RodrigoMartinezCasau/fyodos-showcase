/**
 * resolveAnalysisRoot — pick the folder the CLI should actually analyze.
 *
 * Monorepos often contain BOTH a web app (Next/Vite) and a mobile app
 * (Expo/RN) under one git root. Running `analyze .` from the repo root makes
 * the AI read mobile screens too, so the web orb gets actions that do not
 * exist on the website. When we can identify a single sub-app for the target
 * platform, we scope collection/wiring to THAT folder only.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_SCAN = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'android', 'ios',
  '.expo', 'web-build', '.venv', 'vendor', 'target', '.gradle', '.dart_tool',
]);

/** Conventional subfolder names — checked first (higher confidence). */
const WEB_ROOT_NAMES = ['frontend', 'web', 'www', 'client', 'apps/web', 'packages/web'];
const MOBILE_ROOT_NAMES = ['mobile', 'app', 'apps/mobile', 'apps/app', 'packages/mobile', 'native'];

function readDeps(pkgPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  } catch {
    return null;
  }
}

function hasWebDeps(deps) {
  if (!deps) return false;
  return Boolean(
    deps.next || deps.vite || deps['@vitejs/plugin-react'] || deps['react-scripts'] ||
    deps['@angular/core'] || deps['@angular-devkit/build-angular'] ||
    deps['@sveltejs/kit'] || deps.svelte || deps.vue || deps['@vue/cli-service'],
  );
}

function hasMobileDeps(deps) {
  if (!deps) return false;
  return Boolean(deps.expo || deps['expo-router'] || deps['react-native']);
}

function platformDepsMatch(deps, platform) {
  if (!deps) return false;
  if (platform === 'web') return hasWebDeps(deps) && !hasMobileDeps(deps);
  if (platform === 'mobile') return hasMobileDeps(deps) && !hasWebDeps(deps);
  return false;
}

/**
 * How "complete" / runnable a candidate app folder looks. A monorepo can nest a
 * thin source wrapper (e.g. mobile/) around the REAL runnable app (mobile/mobile/
 * with app.json, the expo dep, native ios/android dirs). Conventional-name
 * matching alone would pick the wrapper; this score lets the real app win.
 */
function appCompleteness(dir, platform) {
  let score = 0;
  const has = (rel) => fs.existsSync(path.join(dir, rel));
  if (has('app') || has('src') || has('pages')) score += 2;
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    /* ignore */
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = pkg.scripts || {};
  if (pkg.main) score += 2;
  if (platform === 'mobile') {
    if (has('app.json') || has('app.config.js') || has('app.config.ts')) score += 4;
    if (deps.expo) score += 4;
    if (has('ios') || has('android')) score += 2;
    if (scripts.start || scripts.ios || scripts.android) score += 1;
  } else if (platform === 'web') {
    if (
      has('next.config.js') || has('next.config.ts') || has('next.config.mjs') ||
      has('vite.config.js') || has('vite.config.ts') || has('index.html') ||
      has('angular.json') || has('svelte.config.js')
    ) {
      score += 4;
    }
    if (scripts.build || scripts.dev) score += 1;
  }
  return score;
}

function tryCandidate(appRoot, rel, platform, nameScore) {
  const dir = path.join(appRoot, rel);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const deps = readDeps(path.join(dir, 'package.json'));
  if (!platformDepsMatch(deps, platform)) return null;
  return { root: dir, rel, nameScore, complete: appCompleteness(dir, platform), reason: rel };
}

/**
 * @returns {{ root: string, scoped: boolean, reason: string }}
 */
function resolveAnalysisRoot(appRoot, platform) {
  const abs = path.resolve(appRoot);
  const rootDeps = readDeps(path.join(abs, 'package.json'));

  // Root IS the target app (single-package repo).
  if (platformDepsMatch(rootDeps, platform)) {
    return { root: abs, scoped: false, reason: 'root package.json' };
  }

  const candidates = [];

  const preferred = platform === 'web' ? WEB_ROOT_NAMES : MOBILE_ROOT_NAMES;
  for (const name of preferred) {
    const hit = tryCandidate(abs, name, platform, 20);
    if (hit) candidates.push(hit);
  }

  // One level of immediate subdirs (frontend/, mobile/, apps/*, packages/*).
  let entries = [];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return { root: abs, scoped: false, reason: 'unreadable root' };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_SCAN.has(entry.name)) continue;
    const hit = tryCandidate(abs, entry.name, platform, 10);
    if (hit) candidates.push(hit);

    // apps/web, packages/web, etc.
    const nestedRoot = path.join(abs, entry.name);
    let nested = [];
    try {
      nested = fs.readdirSync(nestedRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sub of nested) {
      if (!sub.isDirectory() || SKIP_SCAN.has(sub.name)) continue;
      const rel = path.join(entry.name, sub.name);
      const deep = tryCandidate(abs, rel, platform, 8);
      if (deep) candidates.push(deep);
    }
  }

  if (!candidates.length) {
    return { root: abs, scoped: false, reason: 'no sub-app detected' };
  }

  // Prefer the most complete/runnable app first (so a real nested app beats a
  // thin same-named wrapper), then the conventional-name confidence, then the
  // shorter path (closer to root).
  candidates.sort(
    (a, b) =>
      b.complete - a.complete ||
      b.nameScore - a.nameScore ||
      a.rel.length - b.rel.length,
  );
  const best = candidates[0];
  return {
    root: best.root,
    scoped: best.root !== abs,
    reason: best.reason,
  };
}

module.exports = { resolveAnalysisRoot, hasWebDeps, hasMobileDeps };
