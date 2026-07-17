'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifyManifest } = require('../src/verify');

// Regression (17/07/2026, dashboard re-analysis): the model correctly named
// real handlers in src/lib/api/*.ts (it saw their IMPORTS in the settings
// screen), but those api files were omitted from the prompt for size and
// verification dropped the actions ("was not among the files sent"). Real
// account actions (redeem promo code, password reset, error report) silently
// vanished. Evidence must be verifiable against the repo ON DISK — the
// hallucination-proofing (file exists + symbol literally present) is intact.

function baseManifest(actions) {
  return {
    appId: 'app',
    appName: 'App',
    version: '1',
    routes: [],
    actions,
    policies: { requireConfirmationForDestructive: true, allowedWithoutAuth: [], contextRetentionTurns: 5 },
  };
}

function action(intent, handler) {
  return {
    intent,
    label: intent,
    category: 'account',
    handler,
    requireConfirmation: false,
    parameters: {},
    examples: [intent],
  };
}

test('evidence in a file omitted from the prompt verifies against the repo on disk', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-disk-ev-'));
  try {
    fs.mkdirSync(path.join(appRoot, 'src/lib/api'), { recursive: true });
    fs.writeFileSync(
      path.join(appRoot, 'src/lib/api/developer.ts'),
      'export async function redeemPromoRemote(token: string, code: string) { return { ok: true }; }\n',
    );
    const manifest = baseManifest([action('redeem_promo_code', 'redeemPromoRemote')]);
    const evidence = {
      routes: {},
      actions: { redeem_promo_code: { file: 'src/lib/api/developer.ts', symbol: 'redeemPromoRemote' } },
    };
    // The api file was NOT among the files sent to the AI.
    const sentFiles = [{ rel: 'src/components/Settings.tsx', content: 'import { redeemPromoRemote } from "@/lib/api/developer";' }];

    const { manifest: out, provenance } = verifyManifest(
      manifest, evidence, sentFiles, [], { verifyRoutes: false, appRoot },
    );
    assert.equal(out.actions.length, 1);
    assert.equal(out.actions[0].intent, 'redeem_promo_code');
    const entry = provenance.actions.find((a) => a.intent === 'redeem_promo_code');
    assert.equal(entry.included, true);
    assert.match(entry.verification, /disk/);
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test('evidence naming a file that does not exist anywhere is still dropped', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-disk-ev-'));
  try {
    const manifest = baseManifest([action('ghost_action', 'ghostHandler')]);
    const evidence = {
      routes: {},
      actions: { ghost_action: { file: 'src/lib/api/nope.ts', symbol: 'ghostHandler' } },
    };
    const { manifest: out, provenance } = verifyManifest(
      manifest, evidence, [], [], { verifyRoutes: false, appRoot },
    );
    assert.equal(out.actions.length, 0);
    const entry = provenance.actions.find((a) => a.intent === 'ghost_action');
    assert.equal(entry.included, false);
    assert.match(entry.reason, /does not exist in the project/);
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test('a symbol missing from the on-disk evidence file is still dropped', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-disk-ev-'));
  try {
    fs.mkdirSync(path.join(appRoot, 'src/lib'), { recursive: true });
    fs.writeFileSync(path.join(appRoot, 'src/lib/real.ts'), 'export const somethingElse = 1;\n');
    const manifest = baseManifest([action('phantom', 'phantomHandler')]);
    const evidence = {
      routes: {},
      actions: { phantom: { file: 'src/lib/real.ts', symbol: 'phantomHandler' } },
    };
    const { manifest: out } = verifyManifest(
      manifest, evidence, [], [], { verifyRoutes: false, appRoot },
    );
    assert.equal(out.actions.length, 0);
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test('evidence outside the app root is never read (path traversal)', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-disk-ev-'));
  try {
    const outside = path.join(appRoot, '..', `outside-${path.basename(appRoot)}.ts`);
    fs.writeFileSync(outside, 'export function leakedHandler() {}\n');
    const manifest = baseManifest([action('leak', 'leakedHandler')]);
    const evidence = {
      routes: {},
      actions: { leak: { file: `../${path.basename(outside)}`, symbol: 'leakedHandler' } },
    };
    const { manifest: out } = verifyManifest(
      manifest, evidence, [], [], { verifyRoutes: false, appRoot },
    );
    assert.equal(out.actions.length, 0);
    fs.rmSync(outside, { force: true });
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});
