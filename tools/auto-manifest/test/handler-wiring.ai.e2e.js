/**
 * End-to-end proof for AI-DRIVEN handler wiring.
 *
 * The AI (during analysis) proposes, per action, HOW to run it: which module to
 * import and a call expression read straight from the user's code. The mechanical
 * verifier then confirms every referenced symbol really exists before any code is
 * written. This test proves that contract WITHOUT mocking the engine:
 *
 *   1. Creates a fixture whose state lives in a plain module object (NOT an
 *      exported function and NOT a Zustand store — exactly the shape the old
 *      pattern detector could not wire).
 *   2. Feeds an AI `wiring` block (as analyzeWithAI would return) plus three
 *      adversarial proposals the verifier MUST reject:
 *        · a call importing a symbol that does not exist,
 *        · a call referencing a bare identifier that is neither imported nor a
 *          safe global,
 *        · an action the AI marked "bridge" (not module-reachable).
 *   3. Runs wireHandlers() with consent assumed, then runs the REAL @fiodos/core
 *      executor + @fiodos/web-core decideAction over the GENERATED registry to
 *      prove a non-sensitive AI-wired action executes, a sensitive one is gated,
 *      and the rejected proposals are NEVER written.
 *
 * Run: node test/handler-wiring.ai.e2e.js
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-ai-wire-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'tasks-demo', type: 'commonjs' }, null, 2),
  );
  fs.mkdirSync(path.join(dir, 'src'));
  // State lives in a module-level singleton OBJECT with methods — not an
  // exported function, not a Zustand store. Only an AI that read the code can
  // know to call `taskStore.addTask(...)`.
  fs.writeFileSync(
    path.join(dir, 'src', 'data.js'),
    [
      'const taskStore = {',
      '  tasks: [],',
      '  addTask(title) {',
      '    const t = { id: this.tasks.length + 1, title, done: false };',
      '    this.tasks.push(t);',
      '    return t;',
      '  },',
      '  clearTasks() {',
      '    this.tasks = [];',
      '    return { cleared: true };',
      '  },',
      '  list() { return this.tasks.slice(); },',
      '};',
      'module.exports = { taskStore };',
      '',
    ].join('\n'),
  );
  return dir;
}

const manifest = {
  appId: 'tasks-demo',
  appName: 'Tasks Demo',
  appDescription: 'Demo to prove AI-driven wiring.',
  version: '1.0.0',
  routes: [{ intent: 'back', label: 'Back', route: 'BACK', examples: ['back'] }],
  actions: [
    {
      intent: 'add_task',
      label: 'Añadir tarea',
      category: 'tasks',
      handler: 'addTask',
      requireConfirmation: false,
      parameters: { title: { type: 'string', required: true, description: 'Título' } },
      examples: ['añade una tarea', 'apunta comprar pan'],
    },
    {
      intent: 'clear_tasks',
      label: 'Vaciar tareas',
      category: 'tasks',
      handler: 'clearTasks',
      requireConfirmation: true,
      voiceConfirmation: 'standard',
      confirmationMessageTemplate: '¿Seguro que quieres vaciar todas las tareas?',
      parameters: {},
      examples: ['vacía las tareas'],
    },
    {
      intent: 'sync_cloud',
      label: 'Sincronizar',
      category: 'tasks',
      handler: 'syncCloud',
      requireConfirmation: false,
      parameters: {},
      examples: ['sincroniza'],
    },
    {
      intent: 'wipe_secret',
      label: 'Borrar secreto',
      category: 'tasks',
      handler: 'wipeSecret',
      requireConfirmation: false,
      parameters: {},
      examples: ['borra el secreto'],
    },
    {
      intent: 'edit_inline',
      label: 'Editar en línea',
      category: 'tasks',
      handler: 'editInline',
      requireConfirmation: false,
      parameters: { title: { type: 'string', required: true, description: 'Nuevo título' } },
      examples: ['edita la tarea'],
    },
  ],
  policies: { requireConfirmationForDestructive: true, allowedWithoutAuth: [], contextRetentionTurns: 5 },
};

const evidence = {
  actions: {
    add_task: { file: 'src/data.js', symbol: 'addTask', whatItDoes: 'adds a task' },
    clear_tasks: { file: 'src/data.js', symbol: 'clearTasks', whatItDoes: 'clears tasks' },
    sync_cloud: { file: 'src/data.js', symbol: 'syncCloud', whatItDoes: 'syncs' },
    wipe_secret: { file: 'src/data.js', symbol: 'wipeSecret', whatItDoes: 'wipes' },
    edit_inline: { file: 'src/data.js', symbol: 'editInline', whatItDoes: 'edits inline in a component' },
  },
};

// Exactly what analyzeWithAI() would return in `parsed.wiring`.
const wiring = {
  // GOOD: object-method call into a module singleton — the verifier finds both symbols.
  add_task: {
    strategy: 'module',
    imports: [{ kind: 'named', name: 'taskStore', from: 'src/data.js' }],
    call: "taskStore.addTask(params['title'])",
    requiredSymbols: [
      { name: 'taskStore', file: 'src/data.js' },
      { name: 'addTask', file: 'src/data.js' },
    ],
  },
  // GOOD but sensitive: must still be GATED by the engine, not by the wiring.
  clear_tasks: {
    strategy: 'module',
    imports: [{ kind: 'named', name: 'taskStore', from: 'src/data.js' }],
    call: 'taskStore.clearTasks()',
    requiredSymbols: [{ name: 'taskStore', file: 'src/data.js' }],
  },
  // BAD: imports a symbol that does NOT exist → verifier rejects → review.
  sync_cloud: {
    strategy: 'module',
    imports: [{ kind: 'named', name: 'cloudClient', from: 'src/data.js' }],
    call: 'cloudClient.sync()',
    requiredSymbols: [{ name: 'cloudClient', file: 'src/data.js' }],
  },
  // BAD: references a bare identifier neither imported nor a safe global → review.
  wipe_secret: {
    strategy: 'module',
    imports: [],
    call: 'secretVault.wipe()',
    requiredSymbols: [],
  },
  // HONEST: AI says it's only reachable through component-local state → review.
  edit_inline: {
    strategy: 'bridge',
    bridgeReason: 'el título se edita con un useState local del componente TaskRow, sin capa de módulo',
  },
};

async function main() {
  const dir = setupFixture();
  console.log(`\nFixture: ${dir}\n`);

  console.log('1) Running wireHandlers with AI wiring (consent assumed = yes)…');
  const result = await wireHandlers(dir, {
    manifest,
    evidence,
    wiring,
    appName: manifest.appName,
    assumeYes: true,
    ts: false,
    esm: false,
    colors: {},
  });

  check('status applied', result.status === 'applied');
  check('2 actions auto-wired (add_task, clear_tasks)', result.autoCount === 2);
  check('3 actions left for review', result.manualCount === 3);
  check('document generated', result.docPath && fs.existsSync(result.docPath));
  check('registry generated', result.registryFile && fs.existsSync(result.registryFile));

  const autoBySource = (result.plan.auto || []).every((e) => e.source === 'ai');
  check('both auto entries came from the AI (not the mechanical detector)', autoBySource);

  console.log('\n────────── GENERATED DOCUMENT (FYODOS_HANDLERS.md) ──────────');
  console.log(fs.readFileSync(result.docPath, 'utf8'));
  console.log('────────── GENERATED REGISTRY ──────────');
  console.log(fs.readFileSync(result.registryFile, 'utf8'));
  console.log('─────────────────────────────────────────');

  console.log('\n2) Running the REAL engine over the GENERATED registry…');
  const { fyodosGeneratedRegistries } = require(result.registryFile);
  const { taskStore } = require(path.join(dir, 'src', 'data.js'));

  const messages = CORE.resolveMessages('es', {});
  const navigation = { navigate() {}, back() {} };
  const executor = CORE.createActionExecutor({
    manifest,
    registries: fyodosGeneratedRegistries,
    navigation,
    messages,
  });

  // 2a. Non-sensitive AI-wired action executes and mutates real app state.
  const addAction = CORE.parseAgentAction({ type: 'execute', intent: 'add_task', parameters: { title: 'Comprar pan' } });
  const addDecision = await WEBCORE.decideAction({
    action: addAction, manifest, executor, context: {}, messages, userMessage: 'apunta comprar pan',
  });
  check('add_task executed (not gated)', addDecision.kind === 'executed');
  check('add_task reported success', addDecision.result && addDecision.result.success === true);
  check('app state really changed (task stored)', taskStore.list().some((t) => t.title === 'Comprar pan'));

  // 2b. Sensitive AI-wired action is GATED by the engine, not run by the wiring.
  const clearAction = CORE.parseAgentAction({ type: 'execute', intent: 'clear_tasks' });
  const clearDecision = await WEBCORE.decideAction({
    action: clearAction, manifest, executor, context: {}, messages, userMessage: 'vacía las tareas',
  });
  check('clear_tasks is GATED (needs-confirmation)', clearDecision.kind === 'needs-confirmation');
  check('clear_tasks did NOT run before confirmation', taskStore.list().length === 1);
  const confirmed = await executor.execute(clearAction, {});
  check('after confirmation, clear executed', confirmed.success === true);
  check('app state cleared after confirmation', taskStore.list().length === 0);

  // 2c. The verifier rejected the bad/honest proposals → no handlers written.
  check('sync_cloud NOT wired (symbol does not exist)', !has(fyodosGeneratedRegistries, 'syncCloud'));
  check('wipe_secret NOT wired (unimported identifier)', !has(fyodosGeneratedRegistries, 'wipeSecret'));
  check('edit_inline NOT wired (AI marked bridge)', !has(fyodosGeneratedRegistries, 'editInline'));

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}\n`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

function has(reg, name) {
  return Object.prototype.hasOwnProperty.call(reg.handlers, name);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
