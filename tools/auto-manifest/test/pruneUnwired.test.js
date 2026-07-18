'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pruneUnwiredActions } = require('../src/index.js');

// Founder rule: NO manual wiring ever reaches a human. An action the installer
// could not wire automatically must be DROPPED from the manifest (not left as
// "wire it by hand"), so the developer sees it is missing and re-runs analysis.

function manifest() {
  return {
    routes: [
      { intent: 'home', route: '/', actionIntents: ['do_wired', 'do_manual'] },
    ],
    actions: [
      { intent: 'do_wired', handler: 'wiredФn', kind: 'function', parameters: {} },
      { intent: 'do_manual', handler: 'manualFn', kind: 'function', parameters: {} },
      { intent: 'open_link', kind: 'link', navTarget: '#x' },
    ],
  };
}

// A handlerResult whose plan marks do_wired auto and do_manual review.
function handlerResult(status) {
  return {
    status,
    autoCount: 1,
    manualCount: 1,
    plan: {
      auto: [{ intent: 'do_wired' }],
      review: [{ intent: 'do_manual', reason: 'ambiguous anchor' }],
    },
    verification: [],
  };
}

test('drops the manual action, keeps wired + link, scrubs route refs', () => {
  const m = manifest();
  const prov = { actions: [
    { intent: 'do_wired', included: true },
    { intent: 'do_manual', included: true },
    { intent: 'open_link', included: true },
  ] };
  const dropped = pruneUnwiredActions(m, prov, handlerResult('applied'));
  assert.deepEqual(dropped, ['do_manual']);
  const intents = m.actions.map((a) => a.intent).sort();
  assert.deepEqual(intents, ['do_wired', 'open_link']);
  // route.actionIntents no longer references the dropped action
  assert.deepEqual(m.routes[0].actionIntents, ['do_wired']);
  // provenance records the exclusion
  const p = prov.actions.find((x) => x.intent === 'do_manual');
  assert.equal(p.included, false);
  assert.match(p.reason, /EXCLUDED/);
});

test('does nothing on a wholesale revert (no trustworthy per-action verdict)', () => {
  const m = manifest();
  const before = m.actions.length;
  const dropped = pruneUnwiredActions(m, { actions: [] }, handlerResult('reverted'));
  assert.deepEqual(dropped, []);
  assert.equal(m.actions.length, before);
});

test('does nothing when everything wired', () => {
  const m = manifest();
  const r = handlerResult('applied');
  r.plan.auto = [{ intent: 'do_wired' }, { intent: 'do_manual' }];
  r.plan.review = [];
  r.manualCount = 0; r.autoCount = 2;
  const dropped = pruneUnwiredActions(m, { actions: [] }, r);
  assert.deepEqual(dropped, []);
  assert.equal(m.actions.length, 3);
});
