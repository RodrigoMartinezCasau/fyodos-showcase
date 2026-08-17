/**
 * A READ is wired like any other action, and what it RETURNS reaches the agent.
 *
 * Field incident (17/08/2026): a company panel's analysis produced 27 actions,
 * every one of them a write. Asked for the month's figure, the internal orb had
 * nothing that returns a number and fell back to asking for a required
 * parameter of a per-record mutation ("what is their email?").
 *
 * The analyzer now has to emit reads for internal orbs. This test fixes the
 * other half of that promise — the half that lives here: the wiring makes no
 * distinction between reading and writing, and the generated handler hands the
 * function's RETURN VALUE back as `data`, which is what the turn feeds to the
 * model. If this ever regressed, reads would wire "successfully" and the agent
 * would still have no figures.
 *
 * Usage: node --test test/wireReads.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { wireHandlers } = require('../src/wireHandlers');

const API_REL = 'src/api.ts';
const REGISTRY_REL = 'src/fyodos/handlers.generated.ts';

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** The shape every real panel has: reads and writes side by side in one module. */
function scaffoldApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-reads-'));
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }));
  write(path.join(root, 'tsconfig.json'), '{}');
  write(
    path.join(root, API_REL),
    `export const api = {\n` +
      `  async monthlyCost() { return { eur: 1240.5, tokens: 5233196 }; },\n` +
      `  async setPlan(id: string, planId: string) { return { ok: true }; },\n` +
      `};\n`,
  );
  return root;
}

const manifest = {
  appName: 'reads-fixture',
  actions: [
    {
      intent: 'get_monthly_cost',
      handler: 'monthlyCost',
      label: 'Coste del mes',
      // A read never stops to confirm, and it needs nothing from the user.
      requireConfirmation: false,
      parameters: {},
    },
    {
      intent: 'set_plan',
      handler: 'setPlan',
      label: 'Cambiar plan',
      requireConfirmation: true,
      parameters: {
        id: { type: 'string', required: true },
        planId: { type: 'string', required: true },
      },
    },
  ],
};

const evidence = {
  actions: {
    get_monthly_cost: { file: API_REL, symbol: 'monthlyCost' },
    set_plan: { file: API_REL, symbol: 'setPlan' },
  },
};

const wiring = {
  get_monthly_cost: {
    strategy: 'module',
    imports: [{ kind: 'named', name: 'api', from: API_REL }],
    call: 'api.monthlyCost()',
    requiredSymbols: [
      { name: 'api', file: API_REL },
      { name: 'monthlyCost', file: API_REL },
    ],
  },
  set_plan: {
    strategy: 'module',
    imports: [{ kind: 'named', name: 'api', from: API_REL }],
    call: "api.setPlan(params['id'], params['planId'])",
    requiredSymbols: [
      { name: 'api', file: API_REL },
      { name: 'setPlan', file: API_REL },
    ],
  },
};

async function wire(root) {
  return wireHandlers(root, {
    manifest,
    evidence,
    wiring,
    assumeYes: true,
    quiet: true,
    runTest: false,
    files: [{ rel: API_REL }],
  });
}

test('a read wires exactly like a write, with no extra field and no new strategy', async () => {
  const root = scaffoldApp();
  const result = await wire(root);

  assert.ok(
    result.status === 'applied' || result.status === 'applied-untested',
    `expected the wiring to ship, got '${result.status}'`,
  );
  assert.strictEqual(result.autoCount, 2, 'both the read and the write ship wired');
  const registry = fs.readFileSync(path.join(root, REGISTRY_REL), 'utf8');
  // The registry is keyed by handler name, the read exactly like the write.
  assert.match(registry, /\bmonthlyCost:\s*async/, 'the read is in the registry');
  assert.match(registry, /\bsetPlan:\s*async/, 'and so is the write next to it');
  assert.match(registry, /api\.monthlyCost\(\)/, 'wired to the real function');
});

test("what the function returns is handed back as `data`, or the agent gets no figures", async () => {
  const root = scaffoldApp();
  await wire(root);
  const registry = fs.readFileSync(path.join(root, REGISTRY_REL), 'utf8');

  // The single helper every generated handler funnels through: success carries
  // the resolved value, which is what the turn feeds back to the model.
  assert.match(registry, /success:\s*true,\s*data:/, 'the result travels as data');
  // The read is not special-cased into a fire-and-forget call.
  const readLine = registry
    .split('\n')
    .find((l) => l.includes('api.monthlyCost()'));
  assert.ok(readLine, 'the read has a generated handler');
  assert.match(readLine, /__fyodosRun/, 'it goes through the helper that returns data');
});
