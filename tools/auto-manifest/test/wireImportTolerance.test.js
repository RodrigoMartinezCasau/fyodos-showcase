/**
 * An action the analysis DETECTED, backed by a real function, must not be left
 * out because of how the AI spelled its import.
 *
 * Field incident (17/08/2026, owner panel): three actions whose functions exist
 * in `src/api.ts` — create_employee, update_employee, clock_employee — were
 * published as "wire it by hand". The call expressions the AI proposed were
 * perfect. What sank them was the import descriptor:
 *
 *   · create/update said {name: 'api', file: 'src/api'} — the EVIDENCE key —
 *     while the verifier only reads `from`, so it called the import incomplete
 *     and never even tried to resolve it;
 *   · clock retried five times and ended at {from: '../api'}, a path written
 *     the way the COMPONENT sees it, which the verifier resolved from the repo
 *     root, landing outside the project.
 *
 * Both are the same mistake a person makes and fixes in a second, and the cost
 * is real twice over: the action is lost, and the doc then tells the developer
 * to wire it by hand — which is what leaves hand-written blocks in files the
 * next install can break.
 *
 * Tolerance never means guessing: the file must exist and the symbol must be in
 * it, exactly as before. The last test here is the one that keeps us honest.
 *
 * Usage: node --test test/wireImportTolerance.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { wireHandlers } = require('../src/wireHandlers');

const API_REL = 'src/api.ts';
const PAGE_REL = 'src/components/EmployeesPage.tsx';
const REGISTRY_REL = 'src/fyodos/handlers.generated.ts';

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/**
 * The exact shape of the real panel: the operations live in a module and the
 * screen only holds thin wrappers around them. This is the most common layout
 * in business software, so it must be the best-supported one.
 */
function scaffoldApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-imports-'));
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }));
  write(path.join(root, 'tsconfig.json'), '{}');
  write(
    path.join(root, API_REL),
    `export const api = {\n` +
      `  createEmployee: async (body: Record<string, unknown>) => ({ id: '1', ...body }),\n` +
      `  clockEmployee: async (id: string) => ({ id, working: true }),\n` +
      `};\n`,
  );
  write(
    path.join(root, PAGE_REL),
    `import { api } from '../api';\n` +
      `\n` +
      `export default function EmployeesPage() {\n` +
      `  const create = async () => { await api.createEmployee({ name: 'x' }); };\n` +
      `  const clock = async (id: string) => { await api.clockEmployee(id); };\n` +
      `  return null;\n` +
      `}\n`,
  );
  return root;
}

function fixture(imports) {
  return {
    manifest: {
      appName: 'imports-fixture',
      actions: [
        {
          intent: 'create_employee',
          handler: 'createEmployee',
          label: 'Crear empleado',
          requireConfirmation: false,
          parameters: { name: { type: 'string', required: true } },
        },
      ],
    },
    // What the analysis saw: the SCREEN, calling into the module.
    evidence: { actions: { create_employee: { file: PAGE_REL, symbol: 'api.createEmployee' } } },
    wiring: {
      create_employee: {
        strategy: 'module',
        imports,
        call: "api.createEmployee({ name: params['name'] })",
        requiredSymbols: [
          { name: 'api', file: API_REL },
          { name: 'createEmployee', file: API_REL },
        ],
      },
    },
  };
}

async function wire(root, imports) {
  const { manifest, evidence, wiring } = fixture(imports);
  return wireHandlers(root, {
    manifest,
    evidence,
    wiring,
    assumeYes: true,
    quiet: true,
    runTest: false,
    files: [{ rel: API_REL }, { rel: PAGE_REL }],
  });
}

function registry(root) {
  try {
    return fs.readFileSync(path.join(root, REGISTRY_REL), 'utf8');
  } catch {
    return '';
  }
}

test('an import that names the file with the evidence key still wires', async () => {
  const root = scaffoldApp();
  // What the AI really wrote for create_employee and update_employee.
  const result = await wire(root, [{ name: 'api', file: 'src/api' }]);

  assert.strictEqual(result.autoCount, 1, 'the action must ship wired, not "wire it by hand"');
  assert.match(registry(root), /api\.createEmployee/, 'wired to the real function');
});

test('an import path written the way the component sees it still wires', async () => {
  const root = scaffoldApp();
  // What the AI ended at for clock_employee after five attempts.
  const result = await wire(root, [{ kind: 'named', name: 'api', from: '../api' }]);

  assert.strictEqual(result.autoCount, 1, 'a component-relative path is not a reason to give up');
  assert.match(registry(root), /api\.createEmployee/, 'wired to the real function');
});

test('the import the contract asks for keeps working exactly as before', async () => {
  const root = scaffoldApp();
  const result = await wire(root, [{ kind: 'named', name: 'api', from: API_REL }]);

  assert.strictEqual(result.autoCount, 1);
});

test('the bridge strategy reads an import exactly like the module one', async () => {
  const root = scaffoldApp();
  const result = await wireHandlers(root, {
    manifest: {
      appName: 'imports-fixture',
      actions: [{ intent: 'clock_employee', handler: 'clockEmployee', label: 'Fichar', parameters: {} }],
    },
    evidence: { actions: { clock_employee: { file: PAGE_REL, symbol: 'clock' } } },
    wiring: {
      clock_employee: {
        strategy: 'bridge',
        bridgeReason: 'the wrapper lives in the component',
        bridge: {
          file: PAGE_REL,
          scope: 'statement',
          anchor: '  return null;',
          invoke: "api.clockEmployee('1')",
          // The same slip, on the other branch: the evidence key, not `from`.
          imports: [{ kind: 'named', name: 'api', file: 'src/api' }],
        },
        requiredSymbols: [{ name: 'clockEmployee', file: API_REL }],
      },
    },
    assumeYes: true,
    quiet: true,
    runTest: false,
    files: [{ rel: API_REL }, { rel: PAGE_REL }],
  });

  assert.strictEqual(result.autoCount, 1, 'a bridge is not lost to the import key either');
});

test('tolerance is not guessing: a file that does not exist is still refused', async () => {
  const root = scaffoldApp();
  const result = await wire(root, [{ kind: 'named', name: 'api', from: 'src/nowhere' }]);

  assert.strictEqual(result.autoCount, 0, 'nothing may be wired against a file that is not there');
  assert.strictEqual(result.manualCount, 1);
});

test('tolerance is not guessing: a name absent from the resolved file is still refused', async () => {
  const root = scaffoldApp();
  const result = await wire(root, [{ kind: 'named', name: 'invented', from: 'src/api' }]);

  assert.strictEqual(result.autoCount, 0, 'a symbol that is not in the file is never imported');
  assert.strictEqual(result.manualCount, 1);
});
