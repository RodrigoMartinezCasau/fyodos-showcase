/**
 * E2E proof for the BRIDGE wiring path: when an action's state is locked inside
 * a component (not reachable from a module), Fiodos edits the user's OWN file to
 * register a tiny bridge, generates the holder + registry, and the action then
 * executes for real against the component's live state.
 *
 * It runs end-to-end with REAL ESM modules (a tmp project with type:module):
 *   1) verify the plan: good bridge → auto, adversarial bridges → review,
 *   2) apply the component edit + bridge holder + registry,
 *   3) mount the "component" (registers its live closure) and invoke the
 *      generated handler → assert the component's local state really mutates,
 *   4) assert idempotence (re-apply leaves one block) and clean revert.
 *
 * No network, no AI. Exits non-zero on any failed assertion.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');

const {
  prepareHandlerPlan,
  planComponentEdits,
  applyComponentEdits,
  buildBridgeModule,
  buildRegistryModule,
  stripFiodosBlocks,
  revertAll,
} = require('../src/wireHandlers');

function section(t) {
  console.log(`\n${'─'.repeat(41)}\n${t}\n`);
}

async function main() {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-bridge-'));
  const fyodosDirRel = '.';

  // A component that owns its state in a CLOSURE (the module-level state is not
  // reachable; only the component instance can mutate `items`). This is exactly
  // the React-useState / Vue-ref situation the bridge exists for.
  const componentRel = 'Component.js';
  const componentSrc =
    `export function mountComponent() {\n` +
    `  const items = [];\n` +
    `  function addItem(title) { items.push(title); return { count: items.length }; }\n` +
    `  // FYODOS_ANCHOR_POINT\n` +
    `  return { items, addItem };\n` +
    `}\n`;
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }));
  fs.writeFileSync(path.join(appRoot, componentRel), componentSrc);

  const manifest = {
    appName: 'bridge-fixture',
    actions: [
      { intent: 'add_item', handler: 'add_item', label: 'Add item', parameters: { title: { type: 'string', required: true } } },
      { intent: 'bad_anchor', handler: 'bad_anchor', label: 'Bad anchor', parameters: {} },
      { intent: 'detached_new', handler: 'detached_new', label: 'Detached', parameters: {} },
      { intent: 'ghost', handler: 'ghost', label: 'Ghost symbol', parameters: {} },
    ],
  };
  const evidence = { actions: { add_item: { file: componentRel, symbol: 'addItem' } } };
  const wiring = {
    // GOOD bridge: anchor present once, symbol exists, no `new`.
    add_item: {
      strategy: 'bridge',
      bridgeReason: 'estado en closure del componente',
      bridge: { file: componentRel, anchor: '// FYODOS_ANCHOR_POINT', invoke: 'addItem(args.title)' },
      requiredSymbols: [{ name: 'addItem', file: componentRel }],
    },
    // BAD: anchor not in file → cannot place safely.
    bad_anchor: {
      strategy: 'bridge',
      bridge: { file: componentRel, anchor: '// THIS_ANCHOR_DOES_NOT_EXIST', invoke: 'addItem(args.title)' },
      requiredSymbols: [{ name: 'addItem', file: componentRel }],
    },
    // BAD: detached new instance (would not affect UI).
    detached_new: {
      strategy: 'bridge',
      bridge: { file: componentRel, anchor: '// FYODOS_ANCHOR_POINT', invoke: 'const s = new FooService(); s.run(args)' },
      requiredSymbols: [],
    },
    // BAD: references a symbol that does not exist in the file.
    ghost: {
      strategy: 'bridge',
      bridge: { file: componentRel, anchor: '// FYODOS_ANCHOR_POINT', invoke: 'doesNotExist(args.x)' },
      requiredSymbols: [],
    },
  };

  section('1) Planning the wiring (good bridge auto, adversarial → review)');
  const plan = prepareHandlerPlan({ appRoot, manifest, evidence, wiring, fyodosDirRel });
  const autoIntents = plan.auto.map((e) => e.intent);
  const reviewIntents = plan.review.map((e) => e.intent);
  console.log('  auto   :', autoIntents.join(', ') || '(none)');
  console.log('  review :', reviewIntents.join(', ') || '(none)');
  assert.deepStrictEqual(autoIntents, ['add_item'], 'only the good bridge should be auto-wired');
  assert.ok(reviewIntents.includes('bad_anchor'), 'absent anchor must go to review');
  assert.ok(reviewIntents.includes('detached_new'), 'detached new() must go to review');
  assert.ok(reviewIntents.includes('ghost'), 'unknown symbol must go to review');
  console.log('  PASS — exactly the safe bridge is wired');

  section('2) Applying: bridge holder + registry + edit INSIDE the component');
  fs.writeFileSync(path.join(appRoot, 'bridge.js'), buildBridgeModule({ ts: false, esm: true }));
  fs.writeFileSync(path.join(appRoot, 'handlers.generated.js'), buildRegistryModule(plan, { ts: false, esm: true }));
  const edits = planComponentEdits(appRoot, plan, { ts: false });
  assert.strictEqual(edits.length, 1, 'one component file should be edited');
  assert.strictEqual(edits[0].file, componentRel);
  const { backups } = applyComponentEdits(appRoot, edits);

  const editedSrc = fs.readFileSync(path.join(appRoot, componentRel), 'utf8');
  console.log(editedSrc);
  assert.ok(/import \{ registerFiodosBridge \} from '\.\/bridge'/.test(editedSrc), 'import injected');
  assert.ok(/registerFiodosBridge\(\{/.test(editedSrc), 'registration injected');
  assert.ok(editedSrc.includes('addItem(args.title)'), 'invoke injected');
  console.log('  PASS — the component now registers its live function via the bridge');

  section('3) Executing the generated handler against the component state');
  // The generated code uses extensionless imports ('./bridge'), idiomatic for
  // the bundlers real apps use (Vite/Vue/Angular/Svelte). Node's raw ESM loader
  // needs the extension, so add it ONLY for this runtime check.
  for (const f of [componentRel, 'handlers.generated.js']) {
    const p = path.join(appRoot, f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/'\.\/bridge'/g, "'./bridge.js'"));
  }
  const comp = await import(pathToFileURL(path.join(appRoot, componentRel)).href);
  const instance = comp.mountComponent(); // running it registers the live closure
  const reg = await import(pathToFileURL(path.join(appRoot, 'handlers.generated.js')).href);
  const result = await reg.fyodosGeneratedRegistries.handlers.add_item({ title: 'buy milk' });
  console.log('  handler result:', JSON.stringify(result));
  console.log('  component items:', JSON.stringify(instance.items));
  assert.strictEqual(result.success, true, 'handler should report success');
  assert.deepStrictEqual(instance.items, ['buy milk'], 'the COMPONENT-LOCAL state really mutated');
  console.log('  PASS — bridge executes the real component function and state changes');

  section('4) Idempotence + clean revert');
  applyComponentEdits(appRoot, planComponentEdits(appRoot, plan, { ts: false })); // re-apply
  const twice = fs.readFileSync(path.join(appRoot, componentRel), 'utf8');
  const blockCount = (twice.match(/FYODOS:BRIDGE:START/g) || []).length;
  assert.strictEqual(blockCount, 2, 're-apply must keep exactly one import + one register block (2 markers)');
  console.log('  PASS — re-apply is idempotent (no duplicate blocks)');

  revertAll(backups, [path.join(appRoot, 'bridge.js'), path.join(appRoot, 'handlers.generated.js')]);
  const reverted = fs.readFileSync(path.join(appRoot, componentRel), 'utf8');
  assert.strictEqual(reverted, componentSrc, 'revert restores the component byte-for-byte');
  assert.ok(!fs.existsSync(path.join(appRoot, 'bridge.js')), 'bridge file removed on revert');
  assert.ok(!fs.existsSync(path.join(appRoot, 'handlers.generated.js')), 'registry removed on revert');
  console.log('  PASS — revert leaves the user code byte-for-byte original');

  console.log('\n✅ ALL CHECKS PASSED\n');
  fs.rmSync(appRoot, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('\n❌ FAILED:', err && err.message);
  console.error(err);
  process.exit(1);
});
