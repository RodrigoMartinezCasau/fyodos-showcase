'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeSweepResults } = require('../src/mergeSweep');

// The sweep reads code no earlier pass saw, and it only knows the previous
// findings as a LIST. So the merge is what protects the manifest: a duplicated
// screen, two screens on one URL or a repeated capability all end the same way —
// the orb offering the same thing twice, or navigating somewhere it shouldn't.

const base = () => ({
  proposed: {
    routes: [{ intent: 'go_home', route: '/', label: 'Home' }],
    actions: [{ intent: 'search', handler: 'onSearch', parameters: { query: {} } }],
  },
  evidence: { routes: { go_home: { file: 'App.tsx' } }, actions: { search: { file: 'App.tsx' } } },
  wiring: { search: { strategy: 'context' } },
});

test('a screen the sweep found is added with its evidence', () => {
  const ctx = base();
  const out = mergeSweepResults({
    ...ctx,
    sweep: {
      routes: [{ intent: 'go_agent', route: '/agent', label: 'Agente', bubblePrompt: '¿Te ayudo?' }],
      actions: [],
      evidence: { routes: { go_agent: { file: 'AgentSection.tsx' } } },
    },
  });
  assert.equal(out.routes, 1);
  assert.deepEqual(ctx.proposed.routes.map((r) => r.intent), ['go_home', 'go_agent']);
  assert.deepEqual(ctx.evidence.routes.go_agent, { file: 'AgentSection.tsx' });
});

test('a screen on a URL that is already covered is refused', () => {
  const ctx = base();
  const out = mergeSweepResults({
    ...ctx,
    sweep: { routes: [{ intent: 'go_landing', route: '/', label: 'Landing' }], actions: [] },
  });
  assert.equal(out.routes, 0);
  assert.deepEqual(out.skipped, ['go_landing']);
  assert.equal(ctx.proposed.routes.length, 1);
});

test('a screen with no path is refused (nothing could navigate to it)', () => {
  const ctx = base();
  const out = mergeSweepResults({
    ...ctx,
    sweep: { routes: [{ intent: 'go_nowhere', label: 'Mystery' }], actions: [] },
  });
  assert.equal(out.routes, 0);
  assert.equal(ctx.proposed.routes.length, 1);
});

test('an intent that already exists is never added twice, even reworded', () => {
  const ctx = base();
  const out = mergeSweepResults({
    ...ctx,
    sweep: {
      routes: [],
      actions: [{ intent: 'search', handler: 'somethingElse', description: 'Buscar' }],
    },
  });
  assert.equal(out.actions, 0);
  assert.equal(ctx.proposed.actions.length, 1);
});

test('the same capability under a new name is refused by its signature', () => {
  const ctx = base();
  const out = mergeSweepResults({
    ...ctx,
    sweep: {
      routes: [],
      actions: [{ intent: 'find_stuff', handler: 'onSearch', parameters: { query: {} } }],
    },
  });
  assert.equal(out.actions, 0, 'same handler + same params = same action');
  assert.deepEqual(out.skipped, ['find_stuff']);
});

test('a genuinely new action arrives with its evidence and wiring', () => {
  const ctx = base();
  const out = mergeSweepResults({
    ...ctx,
    sweep: {
      routes: [],
      actions: [{ intent: 'export_report', handler: 'exportReport', parameters: {} }],
      evidence: { actions: { export_report: { file: 'Reports.tsx', symbol: 'exportReport' } } },
      wiring: { export_report: { strategy: 'module' } },
    },
  });
  assert.equal(out.actions, 1);
  assert.equal(ctx.evidence.actions.export_report.symbol, 'exportReport');
  assert.deepEqual(ctx.wiring.export_report, { strategy: 'module' });
  assert.deepEqual(ctx.wiring.search, { strategy: 'context' }, 'existing wiring untouched');
});

test('an empty or malformed sweep changes nothing', () => {
  const ctx = base();
  assert.deepEqual(
    mergeSweepResults({ ...ctx, sweep: {} }),
    { routes: 0, actions: 0, skipped: [] },
  );
  assert.deepEqual(
    mergeSweepResults({ ...ctx, sweep: { routes: 'nope', actions: null } }),
    { routes: 0, actions: 0, skipped: [] },
  );
  assert.equal(ctx.proposed.routes.length, 1);
  assert.equal(ctx.proposed.actions.length, 1);
});

test('two passes cannot add the same screen twice', () => {
  const ctx = base();
  const sweep = {
    routes: [{ intent: 'go_agent', route: '/agent', label: 'Agente' }],
    actions: [],
  };
  assert.equal(mergeSweepResults({ ...ctx, sweep }).routes, 1);
  assert.equal(mergeSweepResults({ ...ctx, sweep }).routes, 0);
  assert.equal(ctx.proposed.routes.filter((r) => r.intent === 'go_agent').length, 1);
});
