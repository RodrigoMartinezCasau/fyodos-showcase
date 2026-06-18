/**
 * E2E proof for the INSTALL-TIME auto-correction loop (verify → diagnose →
 * correct → retry, per action), with NO network/AI (a fake corrector + fake
 * build runner stand in for the real ones).
 *
 * It proves the three behaviours the spec demands:
 *   1) An action whose first wiring is INVALID is auto-corrected and ends "ready"
 *      ONLY after it passes verification (here: mechanical + fake compile).
 *   2) An action the corrector can NEVER fix is NOT left pretending: after the
 *      max attempts it is dropped, its edits reverted, and reported honestly.
 *   3) The final code contains only the action that passed; the dropped one left
 *      no trace; the document records the verification outcome per action.
 *
 * Exits non-zero on any failed assertion.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { wireHandlers } = require('../src/wireHandlers');

function section(t) {
  console.log(`\n${'─'.repeat(41)}\n${t}\n`);
}

async function main() {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-loop-'));
  const componentRel = 'Component.js';
  const componentSrc =
    `export function mountComponent() {\n` +
    `  const items = [];\n` +
    `  function addTodo(title) { items.push(title); return { count: items.length }; }\n` +
    `  // FYODOS_ANCHOR\n` +
    `  return { items, addTodo };\n` +
    `}\n`;
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }));
  fs.writeFileSync(path.join(appRoot, componentRel), componentSrc);

  const manifest = {
    appName: 'loop-fixture',
    actions: [
      { intent: 'add_todo', handler: 'add_todo', label: 'Add todo', parameters: { title: { type: 'string', required: true } } },
      { intent: 'frob', handler: 'frob', label: 'Frobnicate', parameters: { x: { type: 'string' } } },
    ],
  };
  const evidence = { actions: { add_todo: { file: componentRel, symbol: 'addTodo' } } };

  // Initial wiring: BOTH actions start broken on purpose.
  //  - add_todo: references a ghost symbol → mechanical fail → corrector fixes it.
  //  - frob:     references a ghost symbol → corrector can't fix → must be dropped.
  const wiring = {
    add_todo: {
      strategy: 'bridge',
      bridge: { file: componentRel, anchor: '// FYODOS_ANCHOR', invoke: 'ghostAddTodo(args.title)' },
      requiredSymbols: [],
    },
    frob: {
      strategy: 'bridge',
      bridge: { file: componentRel, anchor: '// FYODOS_ANCHOR', invoke: 'frobnicate(args.x)' },
      requiredSymbols: [],
    },
  };

  // Fake AI corrector: can fix add_todo (the real function exists) but never frob.
  let correctorCalls = 0;
  const corrector = async ({ intent, prevWiring }) => {
    correctorCalls += 1;
    if (intent === 'add_todo') {
      return {
        add_todo: {
          strategy: 'bridge',
          bridge: { file: componentRel, anchor: '// FYODOS_ANCHOR', invoke: 'addTodo(args.title)' },
          requiredSymbols: [{ name: 'addTodo', file: componentRel }],
        },
      };
    }
    return { [intent]: prevWiring }; // cannot fix → keeps failing
  };

  // Fake build runner: always "compiles" (we are testing the LOOP, not a toolchain).
  const testRunner = async () => ({ ok: true, stage: 'fake', output: '' });

  section('Running install with the auto-correction loop (maxAttempts=2)');
  const result = await wireHandlers(appRoot, {
    manifest, evidence, wiring,
    assumeYes: true,
    runTest: true,
    revertOnFailure: true,
    testRunner,
    corrector,
    files: [{ rel: componentRel, content: componentSrc }],
    maxAttempts: 2,
  });

  console.log('  status     :', result.status);
  console.log('  autoCount  :', result.autoCount);
  console.log('  dropped    :', (result.dropped || []).map((d) => d.intent).join(', ') || '(none)');
  for (const v of result.verification || []) {
    console.log(`  verify · ${v.intent}: ${v.status} in ${v.attempts} attempt(s) [${v.level || v.error}]`);
  }

  section('Assertions');
  assert.strictEqual(result.status, 'applied', 'install should end applied');
  assert.strictEqual(result.autoCount, 1, 'exactly one action should end ready');
  const ver = Object.fromEntries((result.verification || []).map((v) => [v.intent, v]));
  assert.strictEqual(ver.add_todo.status, 'ready', 'add_todo must be ready');
  assert.strictEqual(ver.add_todo.attempts, 2, 'add_todo should pass on attempt 2 (after one correction)');
  assert.strictEqual(ver.frob.status, 'dropped', 'frob must be dropped honestly');
  assert.ok((result.dropped || []).some((d) => d.intent === 'frob'), 'frob in dropped list');
  console.log('  PASS — add_todo auto-corrected to ready; frob honestly dropped');

  // The final component file must contain ONLY the corrected add_todo bridge and
  // NO trace of the dropped frob action.
  const finalSrc = fs.readFileSync(path.join(appRoot, componentRel), 'utf8');
  assert.ok(finalSrc.includes('addTodo(args.title)'), 'corrected add_todo invoke present');
  assert.ok(!finalSrc.includes('frobnicate'), 'dropped action left NO trace in the user file');
  const blocks = (finalSrc.match(/FYODOS:BRIDGE:START/g) || []).length;
  assert.strictEqual(blocks, 2, 'exactly one import block + one register block remain (2 markers)');
  console.log('  PASS — only the verified action was written; dropped one fully reverted');

  // The document must record the verification outcome per action.
  const doc = fs.readFileSync(result.docPath, 'utf8');
  assert.ok(/Verificación automática/.test(doc), 'doc explains the verify+retry loop');
  assert.ok(/frob/.test(doc) && /no se pudo/.test(doc), 'doc marks frob as not auto-wired');
  console.log('  PASS — document is honest about what passed and what did not');

  assert.ok(correctorCalls >= 2, 'corrector was invoked for both failing actions');

  console.log('\n✅ ALL CHECKS PASSED\n');
  fs.rmSync(appRoot, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('\n❌ FAILED:', err && err.message);
  console.error(err);
  process.exit(1);
});
