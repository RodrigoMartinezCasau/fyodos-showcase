/**
 * The install report sent to the backend must describe the REPO, not the run.
 *
 * The incident this fixes: a re-analysis wired 64 actions, the combined build
 * failed and the wiring was reverted — correctly, leaving the previous install's
 * 30 handlers back on disk and working. But the CLI then reported every action
 * as 'manual', the backend applied its "wired or nonexistent" invariant, and the
 * live orb lost all 30 actions in production. Asking it to change the orb colour
 * did nothing: `change_orb_color` no longer existed for the agent. Nothing was
 * broken in the code — the report lied about it.
 *
 * Note the CLI already knew this verdict was untrustworthy: pruneUnwiredActions
 * refuses to prune the manifest on a revert for exactly that reason. It just
 * handed the same verdict to the backend, which did the deletion instead.
 *
 * The contract asserted here:
 *   1) after a wholesale revert, an action whose handler is STILL installed is
 *      reported wired — the previous install keeps working,
 *   2) on a FIRST install there is nothing installed, so everything is reported
 *      manual: never fail open and promise actions with no handler,
 *   3) when this run DID write the registry, the per-action verdict wins (a
 *      handler shared by a wired and a dropped intent must not read as wired),
 *   4) the disk reader matches what the registry generator really emits.
 *
 * Usage: node --test test/wiringReport.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { actionsDetailFromHandlerResult } = require('../src/index');
const { installedHandlerNames, buildRegistryModule } = require('../src/wireHandlers');

const MANIFEST = {
  actions: [
    { intent: 'change_orb_color', handler: 'change_orb_color', label: 'Colour' },
    { intent: 'publish_changes', handler: 'publish_changes', label: 'Publish' },
    { intent: 'brand_new_action', handler: 'brand_new_action', label: 'New' },
    { intent: 'go_to_pricing', kind: 'link', label: 'Pricing' },
  ],
};

function byIntent(detail) {
  return Object.fromEntries((detail || []).map((d) => [d.intent, d]));
}

test('a reverted re-install keeps reporting the previous wiring as wired', () => {
  const detail = byIntent(
    actionsDetailFromHandlerResult(MANIFEST, {
      status: 'reverted',
      plan: { auto: [], review: [], manual: [] },
      // What the revert left on disk: the previous install's handlers.
      installedHandlers: ['change_orb_color', 'publish_changes'],
    }),
  );

  assert.strictEqual(detail.change_orb_color.status, 'wired', 'it still runs, so it must not be hidden');
  assert.strictEqual(detail.publish_changes.status, 'wired');
  assert.strictEqual(
    detail.brand_new_action.status,
    'manual',
    'an action this run failed to wire has no handler and must stay hidden',
  );
  assert.strictEqual(detail.go_to_pricing.status, 'link', 'links never need wiring');
});

test('a reverted FIRST install reports everything manual — never a false promise', () => {
  const detail = byIntent(
    actionsDetailFromHandlerResult(MANIFEST, {
      status: 'reverted',
      plan: { auto: [], review: [], manual: [] },
      installedHandlers: [],
    }),
  );

  for (const intent of ['change_orb_color', 'publish_changes', 'brand_new_action']) {
    assert.strictEqual(detail[intent].status, 'manual', `${intent} has no handler anywhere`);
  }
});

test('a run with nothing wireable still reports the install that is already there', () => {
  const detail = byIntent(
    actionsDetailFromHandlerResult(MANIFEST, {
      status: 'manual-only',
      plan: { auto: [], review: [], manual: [] },
      installedHandlers: ['change_orb_color'],
    }),
  );

  assert.strictEqual(detail.change_orb_color.status, 'wired');
  assert.strictEqual(detail.publish_changes.status, 'manual');
});

test('when this run wrote the registry, the per-action verdict wins', () => {
  // `publish_changes` was dropped but shares its handler with a wired action, so
  // the handler exists on disk. The verdict must still be manual.
  const detail = byIntent(
    actionsDetailFromHandlerResult(MANIFEST, {
      status: 'applied',
      plan: {
        auto: [{ intent: 'change_orb_color', handler: 'shared' }],
        review: [{ intent: 'publish_changes', handler: 'shared', reason: 'ambiguous anchor' }],
        manual: [{ intent: 'publish_changes', handler: 'shared', reason: 'ambiguous anchor' }],
      },
      installedHandlers: ['shared'],
    }),
  );

  assert.strictEqual(detail.change_orb_color.status, 'wired');
  assert.strictEqual(detail.publish_changes.status, 'manual', 'a shared handler must not launder a drop');
});

test('nothing is reported when the wiring never ran', () => {
  assert.strictEqual(actionsDetailFromHandlerResult(MANIFEST, { status: 'declined' }), null);
  assert.strictEqual(actionsDetailFromHandlerResult(MANIFEST, { status: 'skipped' }), null);
});

test('the disk reader matches what the registry generator emits', () => {
  // Both shapes the generator produces: a plain handler and one shared by
  // several intents that dispatches on the intent.
  const plan = {
    auto: [
      { intent: 'change_orb_color', handler: 'change_orb_color', kind: 'bridge', callExpr: 'getFiodosBridge()["change_orb_color"](params)' },
      { intent: 'go_a', handler: 'scrollToSection', kind: 'bridge', callExpr: 'scrollTo("a")' },
      { intent: 'go_b', handler: 'scrollToSection', kind: 'bridge', callExpr: 'scrollTo("b")' },
    ],
    review: [],
    manual: [{ intent: 'dropped', handler: 'neverWired' }],
  };
  const source = buildRegistryModule(plan, { ts: true, esm: true });
  const found = installedHandlerNames(source);

  assert.ok(found.has('change_orb_color'), 'a plain handler must be found');
  assert.ok(found.has('scrollToSection'), 'a shared, intent-dispatching handler must be found');
  assert.ok(!found.has('neverWired'), 'a handler only mentioned as a manual note is not installed');
  assert.ok(!found.has('__fyodosRun'), 'the internal runner is not an action handler');
});

test('the disk reader is empty for a missing or unrelated file', () => {
  assert.strictEqual(installedHandlerNames('').size, 0);
  assert.strictEqual(installedHandlerNames(null).size, 0);
  assert.strictEqual(installedHandlerNames('export const nothing = 1;\n').size, 0);
});
