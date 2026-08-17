/**
 * A Ctrl-C in the middle of the wiring must leave the repo as it was found.
 *
 * The hazard: the wiring phases each know how to undo their work, but only if
 * they reach their own revert. An interrupt (or a crash, or a CI SIGTERM) skips
 * it and leaves edited files and generated modules behind. Nothing fails
 * locally — the CLI is gone — it fails on the developer's next build, and they
 * have no idea we were the ones who touched it.
 *
 * The contract asserted here:
 *   1) unconfirmed edits are undone on interrupt, newest first,
 *   2) CONFIRMED work is never undone: an action that already passed its
 *      verification is the developer's to keep,
 *   3) a real interrupted process restores the files it had already written,
 *      exits 130 and says both things: that the developer stopped it, and that
 *      the unfinished work was undone.
 *
 * Usage: node --test test/rollbackGuard.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  beginPendingEdits,
  confirmPendingEdits,
  rollbackPendingEdits,
  pendingEditCount,
} = require('../src/rollbackGuard');
const { rollbackNoticeLine } = require('../src/index');

test('only the unconfirmed edits are rolled back, newest first', () => {
  const order = [];
  const confirmed = beginPendingEdits(() => order.push('confirmed'), 'session wiring');
  beginPendingEdits(() => order.push('first'), 'action wiring');
  beginPendingEdits(() => order.push('second'), 'screen wiring');
  confirmPendingEdits(confirmed);

  const labels = rollbackPendingEdits();

  assert.deepStrictEqual(order, ['second', 'first'], 'later snapshots restore before earlier ones');
  assert.ok(!order.includes('confirmed'), 'verified work must survive an interrupt');
  assert.deepStrictEqual(labels, ['screen wiring', 'action wiring']);
  assert.strictEqual(pendingEditCount(), 0, 'the registry is emptied so a second signal is a no-op');
});

test('a revert that throws does not stop the others', () => {
  const done = [];
  beginPendingEdits(() => done.push('a'), 'action wiring');
  beginPendingEdits(() => { throw new Error('unwritable'); }, 'session wiring');
  beginPendingEdits(() => done.push('c'), 'screen wiring');

  const labels = rollbackPendingEdits();

  assert.deepStrictEqual(done, ['c', 'a']);
  assert.ok(!labels.includes('session wiring'), 'what could not be undone is not claimed as undone');
});

test('the notice names what was undone and reassures about the repo', () => {
  const line = rollbackNoticeLine(['action wiring', 'action wiring', 'screen wiring'], { tty: false });
  assert.match(line, /action wiring, screen wiring/, 'duplicates collapse into one mention');
  assert.match(line, /exactly as you left it/);
  assert.ok(line.endsWith('\n'), 'it owns its line like every other Fiodos message');
});

test('the wiring phase registers its edits, so an interrupt during its build undoes them', async () => {
  const { wireHandlers } = require('../src/wireHandlers');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-interrupt-wire-'));
  const rel = 'src/components/Panel.tsx';
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  const ORIGINAL =
    `import { useState } from 'react';\n\nexport default function Panel() {\n` +
    `  const [items, setItems] = useState<string[]>([]);\n` +
    `  function addItem(title: string) { setItems((p) => [...p, title]); }\n` +
    `  return null;\n}\n`;
  fs.writeFileSync(abs, ORIGINAL);

  // The signal lands while a build is running, which is where the wiring spends
  // almost all of its time.
  let afterInterrupt = null;
  let calls = 0;
  const testRunner = async () => {
    calls += 1;
    if (calls === 2) {
      assert.notStrictEqual(fs.readFileSync(abs, 'utf8'), ORIGINAL, 'precondition: edits are on disk');
      const labels = rollbackPendingEdits();
      afterInterrupt = {
        labels,
        component: fs.readFileSync(abs, 'utf8'),
        leftovers: fs.existsSync(path.join(root, 'src/fyodos/handlers.generated.ts')),
      };
    }
    return { ok: true, stage: 'build', output: '' };
  };

  await wireHandlers(root, {
    manifest: {
      appName: 'guard',
      actions: [{ intent: 'add_item', handler: 'add_item', label: 'Add', parameters: { title: { type: 'string', required: true } } }],
    },
    evidence: { actions: { add_item: { file: rel, symbol: 'addItem' } } },
    wiring: {
      add_item: {
        strategy: 'bridge',
        bridge: { file: rel, anchor: '  function addItem(title: string)', invoke: 'addItem(args.title)' },
        requiredSymbols: [{ name: 'addItem', file: rel }],
      },
    },
    assumeYes: true, quiet: true, runTest: true, testRunner,
    files: [{ rel }],
  });

  assert.ok(afterInterrupt, 'the wiring must have run a build with its edits applied');
  assert.ok(afterInterrupt.labels.length, 'the phase must have registered its edits as undoable');
  assert.strictEqual(afterInterrupt.component, ORIGINAL, 'the interrupt restored the developer file');
  assert.strictEqual(afterInterrupt.leftovers, false, 'and removed the module it had just created');

  fs.rmSync(root, { recursive: true, force: true });
});

test('an interrupted process restores what it had written and exits 130', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-interrupt-'));
  const victim = path.join(root, 'App.tsx');
  const generated = path.join(root, 'bridge.generated.ts');
  const ORIGINAL = 'export default function App() { return null; }\n';
  fs.writeFileSync(victim, ORIGINAL);

  // A stand-in for a wiring phase: it edits a file, writes a generated module,
  // registers the undo, and then hangs as if it were running a build.
  const script = `
    const fs = require('fs');
    const { beginPendingEdits } = require(${JSON.stringify(path.join(__dirname, '../src/rollbackGuard'))});
    const { rollbackNoticeLine } = require(${JSON.stringify(path.join(__dirname, '../src/index'))});
    const victim = ${JSON.stringify(victim)};
    const generated = ${JSON.stringify(generated)};
    const original = fs.readFileSync(victim, 'utf8');
    process.on('SIGINT', () => {
      const { rollbackPendingEdits } = require(${JSON.stringify(path.join(__dirname, '../src/rollbackGuard'))});
      const labels = rollbackPendingEdits();
      process.stderr.write(rollbackNoticeLine(labels, { tty: false }));
      process.exit(130);
    });
    fs.writeFileSync(victim, original + 'BROKEN_HALF_EDIT\\n');
    fs.writeFileSync(generated, 'export const x = 1;\\n');
    beginPendingEdits(() => {
      fs.writeFileSync(victim, original);
      fs.rmSync(generated, { force: true });
    }, 'action wiring');
    console.log('WIRED');
    setInterval(() => {}, 50);
  `;

  const child = spawn(process.execPath, ['-e', script], { cwd: root });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  await new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      if (d.toString().includes('WIRED')) resolve();
    });
  });

  assert.match(fs.readFileSync(victim, 'utf8'), /BROKEN_HALF_EDIT/, 'precondition: the edit is on disk');
  child.kill('SIGINT');
  const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));

  assert.strictEqual(code, 130, 'a cancellation is not a failure');
  assert.strictEqual(
    fs.readFileSync(victim, 'utf8'),
    ORIGINAL,
    'the half-applied edit must be gone, byte for byte',
  );
  assert.ok(!fs.existsSync(generated), 'the module written by the interrupted run must be gone');
  assert.match(stderr, /exactly as you left it/, 'and the developer is told, not left guessing');

  fs.rmSync(root, { recursive: true, force: true });
});
