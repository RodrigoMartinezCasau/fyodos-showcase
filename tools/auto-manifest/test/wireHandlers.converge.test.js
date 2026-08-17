/**
 * The wiring must CONVERGE on the largest set of actions that builds, never give
 * up on the batch.
 *
 * The failure this fixes: every action was verified alone, the combined build
 * regressed, the culprit could not be attributed from the error text (all the
 * bridges live in the same component, so every error names the same file) and the
 * CLI rolled the WHOLE batch back. 64 verified actions were thrown away because
 * of one bad apple — after paying for the analysis that produced them.
 *
 * The contract asserted here:
 *   1) when one action poisons the union, the innocent ones stay wired and only
 *      the culprit is dropped, even when the error text names nobody,
 *   2) a culprit gets another chance: the AI is asked to correct it with the
 *      COMBINED error and, if the fix builds, it ships wired,
 *   3) whatever is left on disk builds — that invariant is never traded away.
 *
 * Usage: node --test test/wireHandlers.converge.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { wireHandlers } = require('../src/wireHandlers');

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const COMPONENT_REL = 'src/components/Panel.tsx';
const REGISTRY_REL = 'src/fyodos/handlers.generated.ts';
const POISON = 'breakTheBuild';

/**
 * Three actions whose state lives in the same component, so every bridge edit
 * lands in the same file and no build error can point at one of them.
 */
function scaffoldApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-converge-'));
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }));
  write(path.join(root, 'tsconfig.json'), '{}');
  write(
    path.join(root, COMPONENT_REL),
    `import { useState } from 'react';\n` +
      `\n` +
      `export default function Panel() {\n` +
      `  const [items, setItems] = useState<string[]>([]);\n` +
      `  function addItem(title: string) { setItems((prev) => [...prev, title]); }\n` +
      `  function renameItem(title: string) { setItems((prev) => [title, ...prev.slice(1)]); }\n` +
      `  function ${POISON}(title: string) { setItems((prev) => [...prev, title]); }\n` +
      `  return null;\n` +
      `}\n`,
  );
  return root;
}

function fixture() {
  const intents = ['add_item', 'rename_item', 'poison_item'];
  const symbols = { add_item: 'addItem', rename_item: 'renameItem', poison_item: POISON };
  const manifest = {
    appName: 'converge-fixture',
    actions: intents.map((intent) => ({
      intent,
      handler: intent,
      label: intent,
      parameters: { title: { type: 'string', required: true } },
    })),
  };
  const evidence = {
    actions: Object.fromEntries(intents.map((i) => [i, { file: COMPONENT_REL, symbol: symbols[i] }])),
  };
  const wiring = Object.fromEntries(
    intents.map((i) => [
      i,
      {
        strategy: 'bridge',
        bridgeReason: 'state lives in the component closure',
        bridge: {
          file: COMPONENT_REL,
          anchor: `  function ${symbols[i]}(title: string)`,
          invoke: `${symbols[i]}(args.title)`,
        },
        requiredSymbols: [{ name: symbols[i], file: COMPONENT_REL }],
      },
    ]),
  );
  return { manifest, evidence, wiring };
}

/**
 * Builds green unless the registry wires the poison AND at least one other
 * action — exactly the "passes alone, breaks together" shape. The error text
 * names only the shared component, so attribution cannot isolate anyone.
 */
function unionSensitiveRunner(root, symbols = ['addItem', 'renameItem', POISON]) {
  const runner = async () => {
    runner.builds += 1;
    // The bridge `invoke` lands in the developer's component, which is where a
    // real compiler would trip over it.
    let component = '';
    try {
      component = fs.readFileSync(path.join(root, COMPONENT_REL), 'utf8');
    } catch {
      component = '';
    }
    const wired = symbols.filter((s) => component.includes(`${s}(args`));
    if (wired.includes(POISON) && wired.length > 1) {
      return {
        ok: false,
        stage: 'build',
        output: `${COMPONENT_REL}(7,3): error TS2345: Argument of type 'string' is not assignable.`,
      };
    }
    return { ok: true, stage: 'build', output: '' };
  };
  runner.builds = 0;
  return runner;
}

function readRegistry(root) {
  try {
    return fs.readFileSync(path.join(root, REGISTRY_REL), 'utf8');
  } catch {
    return '';
  }
}

async function run(root, { corrector }) {
  const { manifest, evidence, wiring } = fixture();
  return wireHandlers(root, {
    manifest,
    evidence,
    wiring,
    assumeYes: true,
    quiet: true,
    runTest: true,
    testRunner: unionSensitiveRunner(root),
    corrector,
    files: [{ rel: COMPONENT_REL }],
    maxAttempts: 3,
  });
}

test('one action poisoning the union does not cost the others their wiring', async () => {
  const root = scaffoldApp();
  // No fix available from the AI: the culprit must be dropped ALONE.
  const result = await run(root, { corrector: async () => null });

  assert.notStrictEqual(result.status, 'reverted', 'the whole batch must never be thrown away');
  assert.ok(
    result.status === 'applied' || result.status === 'applied-untested',
    `expected the survivors to ship, got '${result.status}'`,
  );
  assert.strictEqual(result.autoCount, 2, 'the two innocent actions stay wired');

  const registry = readRegistry(root);
  assert.match(registry, /"add_item"/, 'add_item stays wired');
  assert.match(registry, /"rename_item"/, 'rename_item stays wired');
  assert.ok(!registry.includes('poison_item'), 'only the culprit is left out of the registry');

  const component = fs.readFileSync(path.join(root, COMPONENT_REL), 'utf8');
  assert.ok(!component.includes(`${POISON}(args`), 'and its bridge block is gone from the component');
  assert.match(component, /addItem\(args/, 'the innocent bridge blocks stay in place');

  const degraded = (result.degraded || []).map((d) => d.intent);
  assert.deepStrictEqual(degraded, ['poison_item'], 'the culprit is reported, not silently missing');

  fs.rmSync(root, { recursive: true, force: true });
});

test('a culprit gets corrected with the combined error and ships wired', async () => {
  const root = scaffoldApp();
  // The AI returns a candidate that no longer calls the poisoned symbol.
  const corrector = async ({ intent }) => {
    if (intent !== 'poison_item') return null;
    return {
      poison_item: {
        strategy: 'bridge',
        bridge: {
          file: COMPONENT_REL,
          anchor: '  function renameItem(title: string)',
          invoke: 'renameItem(args.title)',
        },
        requiredSymbols: [{ name: 'renameItem', file: COMPONENT_REL }],
      },
    };
  };

  const result = await run(root, { corrector });

  assert.ok(
    result.status === 'applied' || result.status === 'applied-untested',
    `expected everything wired, got '${result.status}'`,
  );
  assert.strictEqual(result.autoCount, 3, 'the corrected action ships too — nothing is abandoned');
  const registry = readRegistry(root);
  assert.ok(!registry.includes(`${POISON}(`), 'the corrected wiring no longer calls the poisoned symbol');
  assert.match(registry, /poison_item|poisonItem/i, 'the action itself is present, wired through the fix');

  fs.rmSync(root, { recursive: true, force: true });
});

test('one bad apple in a large batch costs one action, not the batch', async () => {
  // The shape of the real incident: many verified actions, one that cannot
  // coexist, and errors that name only the shared component.
  const names = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-converge-many-'));
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }));
  write(path.join(root, 'tsconfig.json'), '{}');
  write(
    path.join(root, COMPONENT_REL),
    `import { useState } from 'react';\n\nexport default function Panel() {\n` +
      `  const [items, setItems] = useState<string[]>([]);\n` +
      names.map((n) => `  function do_${n}(title: string) { setItems((p) => [...p, title]); }\n`).join('') +
      `  function ${POISON}(title: string) { setItems((p) => [...p, title]); }\n` +
      `  return null;\n}\n`,
  );

  const intents = [...names.map((n) => `act_${n}`), 'poison_item'];
  const symbolFor = (i) => (i === 'poison_item' ? POISON : `do_${i.slice(4)}`);
  const manifest = {
    appName: 'many',
    actions: intents.map((intent) => ({
      intent, handler: intent, label: intent,
      parameters: { title: { type: 'string', required: true } },
    })),
  };
  const evidence = {
    actions: Object.fromEntries(intents.map((i) => [i, { file: COMPONENT_REL, symbol: symbolFor(i) }])),
  };
  const wiring = Object.fromEntries(
    intents.map((i) => [
      i,
      {
        strategy: 'bridge',
        bridge: {
          file: COMPONENT_REL,
          anchor: `  function ${symbolFor(i)}(title: string)`,
          invoke: `${symbolFor(i)}(args.title)`,
        },
        requiredSymbols: [{ name: symbolFor(i), file: COMPONENT_REL }],
      },
    ]),
  );

  const runner = unionSensitiveRunner(root, [...names.map((n) => `do_${n}`), POISON]);
  const result = await wireHandlers(root, {
    manifest, evidence, wiring,
    assumeYes: true, quiet: true, runTest: true,
    testRunner: runner,
    corrector: async () => null,
    files: [{ rel: COMPONENT_REL }],
    maxAttempts: 2,
    maxBuilds: 24,
  });

  assert.notStrictEqual(result.status, 'reverted', 'seven good actions must not die for one');
  assert.strictEqual(result.autoCount, names.length, 'every action that can coexist stays wired');
  assert.deepStrictEqual((result.degraded || []).map((d) => d.intent), ['poison_item']);
  assert.ok(result.builds <= 24, `the search must stay inside its build budget (spent ${result.builds})`);

  fs.rmSync(root, { recursive: true, force: true });
});

test('whatever ends up on disk builds', async () => {
  const root = scaffoldApp();
  const result = await run(root, { corrector: async () => null });

  const finalRunner = unionSensitiveRunner(root);
  const proof = await finalRunner();
  assert.strictEqual(proof.ok, true, 'the project must build with what we left applied');
  assert.ok(result.autoCount > 0, 'and it must not be green just because we wired nothing');

  fs.rmSync(root, { recursive: true, force: true });
});
