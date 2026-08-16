'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectFiles } = require('../src/collect');

// Regression (16/08/2026, dashboard re-analysis audit): the file that DEFINES
// the app's URLs (dashboard/src/lib/screenRoutes.ts, 3.8KB) ranked as a generic
// lib module and lost the budget race against the section files. Without it the
// analyzer had to guess paths: it invented `/dashboard/asistente`,
// `/dashboard/ajustes`, and never emitted a route (nor a bubblePrompt) for the
// section added after the first analysis. The URL map is the cheapest, highest
// value evidence in the repo — it must be guaranteed in.

const mk = (appRoot, rel, bytes) => {
  const full = path.join(appRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'x'.repeat(bytes));
};

test('the URL map and the nav shell are GUARANTEED in, even when screens fill the budget', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-collect-nav-'));
  try {
    mk(appRoot, 'src/lib/screenRoutes.ts', 4000); // the URL truth
    mk(appRoot, 'src/pages/DashboardShell.tsx', 24000); // section → route map
    mk(appRoot, 'src/components/layout/Sidebar.tsx', 9000); // nav labels
    for (let i = 0; i < 12; i++) mk(appRoot, `src/components/sections/Section${i}.tsx`, 40000);
    // Plenty of lib modules sorted BEFORE screenRoutes.ts: in the real repo they
    // ate the tier's floor and the URL map never reached the prompt.
    for (let i = 0; i < 10; i++) mk(appRoot, `src/lib/api${i}.ts`, 12000);

    const { included, omitted } = collectFiles(appRoot, {
      maxInputTokens: Math.round(300000 / 3.0), // ~300k chars: NOT enough for all
      platform: 'web',
    });
    const rels = new Set(included.map((f) => f.rel.replace(/\\/g, '/')));
    assert.ok(rels.has('src/lib/screenRoutes.ts'), 'the URL map must always be included');
    assert.ok(rels.has('src/pages/DashboardShell.tsx'), 'the nav shell must always be included');
    assert.ok(rels.has('src/components/layout/Sidebar.tsx'), 'the nav labels must be included');
    assert.ok(omitted.length > 0, 'budget pressure was real (some sections omitted)');
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test('the URL map survives even when the screens themselves overflow their own tier', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-collect-nav-tier0-'));
  try {
    // Screens alone demand ~800k of a 300k budget and sort BEFORE the URL map,
    // so ranking is not enough: the map has to be force-included.
    for (let i = 0; i < 20; i++) mk(appRoot, `src/app/Aaa${i}Screen.tsx`, 40000);
    mk(appRoot, 'src/lib/screenRoutes.ts', 4000);
    mk(appRoot, 'src/pages/DashboardShell.tsx', 24000);

    const { included } = collectFiles(appRoot, {
      maxInputTokens: Math.round(300000 / 3.0),
      platform: 'web',
    });
    const rels = new Set(included.map((f) => f.rel.replace(/\\/g, '/')));
    assert.ok(rels.has('src/lib/screenRoutes.ts'), 'the URL map must be force-included');
    assert.ok(rels.has('src/pages/DashboardShell.tsx'), 'the nav shell must be force-included');
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test('framework route files are recognised across web and native naming', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-collect-nav2-'));
  try {
    mk(appRoot, 'src/router/index.ts', 3000); // vue-router
    mk(appRoot, 'src/app/app-routing.module.ts', 3000); // angular
    mk(appRoot, 'src/navigation/RootNavigator.tsx', 6000); // react-navigation
    mk(appRoot, 'lib/routes.dart', 3000); // flutter
    for (let i = 0; i < 12; i++) mk(appRoot, `src/components/sections/Section${i}.tsx`, 40000);

    const { included } = collectFiles(appRoot, {
      maxInputTokens: Math.round(300000 / 3.0),
      platform: 'web',
    });
    const rels = new Set(included.map((f) => f.rel.replace(/\\/g, '/')));
    for (const rel of [
      'src/router/index.ts',
      'src/app/app-routing.module.ts',
      'src/navigation/RootNavigator.tsx',
    ]) {
      assert.ok(rels.has(rel), `route definition included: ${rel}`);
    }
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test('the navigation guarantee cannot starve the screens', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-collect-nav3-'));
  try {
    const budgetChars = 300000;
    // A pathological pile of huge "nav" files: the guarantee is capped, so the
    // screen still gets in.
    for (let i = 0; i < 10; i++) mk(appRoot, `src/nav/Nav${i}Router.tsx`, 40000);
    mk(appRoot, 'src/pages/Home.tsx', 20000);

    const { included } = collectFiles(appRoot, {
      maxInputTokens: Math.round(budgetChars / 3.0),
      platform: 'web',
    });
    const rels = new Set(included.map((f) => f.rel.replace(/\\/g, '/')));
    assert.ok(rels.has('src/pages/Home.tsx'), 'screen not starved by navigation files');
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test('a monster route file falls back to normal tiering instead of eating the budget', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-collect-nav4-'));
  try {
    const budgetChars = 300000;
    mk(appRoot, 'src/lib/routes.ts', Math.round(budgetChars * 0.9));
    mk(appRoot, 'src/pages/Home.tsx', 20000);

    const { included } = collectFiles(appRoot, {
      maxInputTokens: Math.round(budgetChars / 3.0),
      platform: 'web',
    });
    const rels = new Set(included.map((f) => f.rel.replace(/\\/g, '/')));
    assert.ok(rels.has('src/pages/Home.tsx'), 'screen survives a monster route file');
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});
