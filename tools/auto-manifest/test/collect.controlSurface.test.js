'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectFiles } = require('../src/collect');

// Regression (17/07/2026, dashboard audit round 2): control-surface components
// (TotpSettingsPanel, ProjectSwitcher, AuditLogPanel, TeamInvitationsPanel)
// ranked as generic UI (last tier) and were the first files the input budget
// cut — the analyzer then missed whole capability families (2FA, project
// switching, team management). They must rank with central state (tier 1),
// ahead of generic components.

test('a large central-state provider is GUARANTEED in, even when screens fill the budget', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-collect-state-'));
  try {
    const mk = (rel, bytes) => {
      const full = path.join(appRoot, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'x'.repeat(bytes));
    };
    // A big provider (like AppProvider ~82KB) + many big screens that would win
    // a naive tiered fill and squeeze the provider out (the audited bug).
    mk('src/context/AppProvider.tsx', 82000);
    for (let i = 0; i < 12; i++) mk(`src/components/sections/Section${i}.tsx`, 40000);

    const { included, omitted } = collectFiles(appRoot, {
      maxInputTokens: Math.round(300000 / 3.0), // ~300k chars: NOT enough for all
      platform: 'web',
    });
    const rels = new Set(included.map((f) => f.rel.replace(/\\/g, '/')));
    assert.ok(rels.has('src/context/AppProvider.tsx'), 'central-state provider must always be included');
    assert.ok(omitted.length > 0, 'budget pressure was real (some screens omitted)');
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test('config/type files that enumerate settings fields are guaranteed in', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-collect-cfg-'));
  try {
    const mk = (rel, bytes) => {
      const full = path.join(appRoot, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'x'.repeat(bytes));
    };
    mk('src/lib/clientStore.ts', 30000);      // persisted store + config types
    mk('src/data/uiThemeDefaults.ts', 8000);  // theme field enumerations
    for (let i = 0; i < 12; i++) mk(`src/components/sections/Section${i}.tsx`, 40000);
    const { included } = collectFiles(appRoot, {
      maxInputTokens: Math.round(300000 / 3.0),
      platform: 'web',
    });
    const rels = new Set(included.map((f) => f.rel.replace(/\\/g, '/')));
    assert.ok(rels.has('src/lib/clientStore.ts'), 'persisted store/config must be included');
    assert.ok(rels.has('src/data/uiThemeDefaults.ts'), 'theme-field definitions must be included');
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test('a pathological monster provider does NOT consume the whole budget', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-collect-monster-'));
  try {
    const mk = (rel, bytes) => {
      const full = path.join(appRoot, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'x'.repeat(bytes));
    };
    const budgetChars = 300000;
    mk('src/store/MegaStore.ts', Math.round(budgetChars * 0.9)); // >40% per-file cap
    mk('src/pages/Home.tsx', 20000);
    const { included } = collectFiles(appRoot, {
      maxInputTokens: Math.round(budgetChars / 3.0),
      platform: 'web',
    });
    const rels = new Set(included.map((f) => f.rel.replace(/\\/g, '/')));
    // The monster exceeds the per-file cap → it is NOT force-included, so the
    // screen still makes it in (no starvation).
    assert.ok(rels.has('src/pages/Home.tsx'), 'screen not starved by a monster provider');
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test('control-surface components survive budget pressure ahead of generic UI', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-collect-'));
  try {
    const big = 'export const x = 1;\n'.repeat(400); // ~8000 chars each
    const mk = (rel) => {
      const full = path.join(appRoot, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, big);
    };
    // One screen (tier 0), control surfaces (should be tier 1), and a pile of
    // alphabetically-earlier generic components that would win a naive fill.
    mk('src/pages/Home.tsx');
    mk('src/components/dashboard/AuditLogPanel.tsx');
    mk('src/components/projects/ProjectSwitcher.tsx');
    mk('src/components/misc/TotpSettingsPanel.tsx');
    mk('src/components/misc/TeamInvitationsPanel.tsx');
    for (const name of ['Aaa', 'Abb', 'Acc', 'Add', 'Aee', 'Aff', 'Agg', 'Ahh']) {
      mk(`src/components/ui/${name}.tsx`);
    }

    // Budget fits ~6 files of this size: screen + the 4 control surfaces must
    // all make the cut; generic UI takes whatever room is left.
    const { included, omitted } = collectFiles(appRoot, {
      maxInputTokens: Math.round((8400 * 6) / 3.0),
      platform: 'web',
    });
    const rels = new Set(included.map((f) => f.rel.replace(/\\/g, '/')));
    assert.ok(rels.has('src/pages/Home.tsx'), 'screen included');
    for (const surface of [
      'src/components/dashboard/AuditLogPanel.tsx',
      'src/components/projects/ProjectSwitcher.tsx',
      'src/components/misc/TotpSettingsPanel.tsx',
      'src/components/misc/TeamInvitationsPanel.tsx',
    ]) {
      assert.ok(rels.has(surface), `control surface included: ${surface}`);
    }
    assert.ok(omitted.length > 0, 'budget pressure was real (something was omitted)');
    for (const o of omitted) {
      assert.match(o.rel, /components\/ui\//, `only generic UI omitted, not ${o.rel}`);
    }
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});
