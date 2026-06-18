/**
 * End-to-end proof for the auto-wiring of handlers.
 *
 * It does NOT mock the engine. It:
 *   1. Creates a tiny fixture app (exported functions + a manifest + evidence).
 *   2. Runs the REAL wireHandlers() with consent assumed (yes).
 *   3. Loads the GENERATED registry and runs the REAL @fyodos/core executor +
 *      @fyodos/web-core decideAction over it, proving:
 *        · a non-sensitive action EXECUTES for real (mutates app state),
 *        · a sensitive action (requireConfirmation) is GATED — never executed by
 *          the generated wiring — and only runs after explicit confirmation,
 *        · an action whose function cannot be found is left MANUAL, not guessed.
 *
 * Run: node test/handler-wiring.e2e.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { wireHandlers } = require('../src/wireHandlers');

const CORE = require(path.resolve(__dirname, '../../../packages/core/dist/cjs/index.js'));
const WEBCORE = require(path.resolve(__dirname, '../../../packages/web-core/dist/cjs/index.js'));

let failures = 0;
function check(label, cond) {
  const ok = Boolean(cond);
  console.log(`${ok ? '  PASS' : '  FAIL'} — ${label}`);
  if (!ok) failures += 1;
}

function setupFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-wire-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'notes-demo', type: 'commonjs' }, null, 2),
  );
  fs.mkdirSync(path.join(dir, 'src'));
  // The real app code: plain exported functions that mutate in-memory state.
  fs.writeFileSync(
    path.join(dir, 'src', 'notesService.js'),
    [
      'const notes = [];',
      'function addNote(text) {',
      '  notes.push(text);',
      '  return { id: notes.length, text };',
      '}',
      'function clearAllNotes() {',
      '  notes.length = 0;',
      '  return { cleared: true };',
      '}',
      'function getNotes() {',
      '  return notes.slice();',
      '}',
      'module.exports = { addNote, clearAllNotes, getNotes };',
      '',
    ].join('\n'),
  );
  return dir;
}

const manifest = {
  appId: 'notes-demo',
  appName: 'Notes Demo',
  appDescription: 'Demo app to prove auto-wiring.',
  version: '1.0.0',
  routes: [{ intent: 'back', label: 'Back', route: 'BACK', examples: ['back'] }],
  actions: [
    {
      intent: 'add_note',
      label: 'Añadir nota',
      category: 'notes',
      handler: 'addNote',
      requireConfirmation: false,
      parameters: { text: { type: 'string', required: true, description: 'Texto de la nota' } },
      examples: ['añade una nota', 'apunta que compre pan'],
    },
    {
      intent: 'clear_all_notes',
      label: 'Vaciar todas las notas',
      category: 'notes',
      handler: 'clearAllNotes',
      requireConfirmation: true,
      voiceConfirmation: 'standard',
      confirmationMessageTemplate: '¿Seguro que quieres vaciar todas las notas?',
      parameters: {},
      examples: ['vacía las notas', 'bórralo todo'],
    },
    {
      // Its function is NOT exported anywhere → must be marked MANUAL, never guessed.
      intent: 'delete_account',
      label: 'Eliminar cuenta',
      category: 'account',
      handler: 'deleteAccount',
      requireConfirmation: true,
      voiceConfirmation: 'strict',
      confirmationPhrase: 'eliminar cuenta',
      confirmationMessageTemplate: '¿Confirmas eliminar tu cuenta?',
      parameters: {},
      examples: ['elimina mi cuenta'],
    },
  ],
  policies: {
    requireConfirmationForDestructive: true,
    allowedWithoutAuth: ['add_note', 'clear_all_notes'],
    contextRetentionTurns: 5,
  },
};

const evidence = {
  actions: {
    add_note: { file: 'src/notesService.js', symbol: 'addNote', whatItDoes: 'adds a note' },
    clear_all_notes: { file: 'src/notesService.js', symbol: 'clearAllNotes', whatItDoes: 'clears notes' },
    delete_account: { file: 'src/notesService.js', symbol: 'deleteAccount (local fn in a component)', whatItDoes: 'deletes account' },
  },
};

async function main() {
  const dir = setupFixture();
  console.log(`\nFixture: ${dir}\n`);

  console.log('1) Running wireHandlers (consent assumed = yes)…');
  const result = await wireHandlers(dir, {
    manifest,
    evidence,
    appName: manifest.appName,
    assumeYes: true,
    ts: false,
    esm: false,
    colors: {},
  });

  check('status applied', result.status === 'applied');
  check('2 actions auto-wired', result.autoCount === 2);
  check('1 action left manual', result.manualCount === 1);
  check('document was generated', result.docPath && fs.existsSync(result.docPath));
  check('registry was generated', result.registryFile && fs.existsSync(result.registryFile));

  console.log('\n────────── GENERATED DOCUMENT (FYODOS_HANDLERS.md) ──────────');
  console.log(fs.readFileSync(result.docPath, 'utf8'));
  console.log('────────── GENERATED REGISTRY ──────────');
  console.log(fs.readFileSync(result.registryFile, 'utf8'));
  console.log('─────────────────────────────────────────');

  console.log('\n2) Running the REAL engine over the GENERATED registry…');
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const { fyodosGeneratedRegistries } = require(result.registryFile);
  const notesService = require(path.join(dir, 'src', 'notesService.js'));

  const messages = CORE.resolveMessages('es', {});
  const navigation = { navigate() {}, back() {} };
  const executor = CORE.createActionExecutor({
    manifest,
    registries: fyodosGeneratedRegistries,
    navigation,
    messages,
  });

  // 2a. Non-sensitive action → executes for real and mutates app state.
  const addAction = CORE.parseAgentAction({
    type: 'execute',
    intent: 'add_note',
    parameters: { text: 'Comprar pan' },
  });
  const addDecision = await WEBCORE.decideAction({
    action: addAction,
    manifest,
    executor,
    context: {},
    messages,
    userMessage: 'apunta que compre pan',
  });
  check('add_note was executed (not gated)', addDecision.kind === 'executed');
  check('add_note handler reported success', addDecision.result && addDecision.result.success === true);
  check('app state really changed (note stored)', notesService.getNotes().includes('Comprar pan'));

  // 2b. Sensitive action → the generated wiring NEVER runs it; engine gates it.
  const clearAction = CORE.parseAgentAction({ type: 'execute', intent: 'clear_all_notes' });
  const clearDecision = await WEBCORE.decideAction({
    action: clearAction,
    manifest,
    executor,
    context: {},
    messages,
    userMessage: 'vacía todas las notas',
  });
  check('clear_all_notes is GATED (needs-confirmation)', clearDecision.kind === 'needs-confirmation');
  check('clear_all_notes did NOT run before confirmation', notesService.getNotes().length === 1);

  // 2c. After explicit confirmation, the SAME generated handler runs for real.
  const confirmed = await executor.execute(clearAction, {});
  check('after confirmation, clear executed', confirmed.success === true);
  check('app state cleared after confirmation', notesService.getNotes().length === 0);

  // 2d. The unfindable action stays manual (no handler generated for it).
  check(
    'delete_account left MANUAL (no generated handler)',
    !Object.prototype.hasOwnProperty.call(fyodosGeneratedRegistries.handlers, 'deleteAccount'),
  );

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}\n`);
  // Clean up the temp fixture.
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
