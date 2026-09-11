/**
 * `fiodos train` — the terminal carrier of the training agent.
 *
 * What these tests defend: the session presents itself and says goodbye; the
 * code sent for a diagnosis is the code the failing call points at (not the
 * whole tree); proposed edits land in the working tree and nowhere dangerous,
 * and never as a commit; a project training through GitHub is not taken over
 * by accident (D18); the run is marked failed when the terminal cannot finish.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyCodeChanges, locateCode, runTrain, termsFor } = require('../src/train');

function tmpApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fiodos-train-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"panel","dependencies":{"react":"19"}}');
  fs.mkdirSync(path.join(root, 'src', 'api'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'ui'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'api', 'appearance.ts'),
    [
      "import { Router } from 'express';",
      'export const appearance = Router();',
      "appearance.patch('/appearance', (req, res) => {",
      '  const { accentColor } = req.body;',
      "  if (!/^#[0-9a-f]{6}$/i.test(accentColor)) return res.status(400).json({ error: 'invalid_value' });",
      '  res.json({ ok: true });',
      '});',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(root, 'src', 'ui', 'Footer.tsx'), 'export const Footer = () => <footer>Panel</footer>;\n');
  fs.writeFileSync(path.join(root, 'src', 'ui', 'Header.tsx'), 'export const Header = () => <header>Panel</header>;\n');
  return root;
}

const EVIDENCE = {
  id: 'tre_1',
  intent: 'update_colour',
  class: 'B',
  message: 'make the orb green',
  params: { accentColor: 'green' },
  request: { method: 'PATCH', url: 'https://panel.example/api/appearance', headers: {}, body: '{"accentColor":"green"}' },
  response: { status: 400, body: '{"error":"invalid_value"}' },
  error: 'HTTP 400',
};

const ACTION = {
  intent: 'update_colour',
  handler: 'updateAppearance',
  parameters: [{ name: 'accentColor', type: 'string', required: true }],
  execution: { kind: 'http', method: 'PATCH', url: '{baseUrl}/appearance' },
};

test('the code sent for a diagnosis is the code the failing call points at', () => {
  const root = tmpApp();
  const terms = termsFor(EVIDENCE, ACTION);
  assert.ok(terms.has('appearance'), 'the path segment the orb called');
  assert.ok(terms.has('colour') || terms.has('update'), 'the intent');
  assert.ok(terms.has('accentcolor') || terms.has('accent'), 'the parameter');

  const located = locateCode(root, EVIDENCE, ACTION, { platform: 'web' });
  assert.equal(located.files[0].path, 'src/api/appearance.ts');
  assert.ok(located.files.length < located.considered, 'not the whole tree');
  assert.ok(!located.files.some((f) => f.path.endsWith('Footer.tsx')), 'unrelated UI is left out');
});

test('proposed edits land in the working tree, never outside it, never as a commit', () => {
  const root = tmpApp();
  fs.mkdirSync(path.join(root, '.git'));
  const result = applyCodeChanges(root, [
    { path: 'src/api/appearance.ts', content: '// fixed\n', summary: 'accept colour names' },
    { path: '../escape.ts', content: 'nope' },
    { path: 'node_modules/x/index.js', content: 'nope' },
    { path: '.env', content: 'SECRET=1' },
  ]);
  assert.deepEqual(result.written.map((w) => w.path), ['src/api/appearance.ts']);
  assert.equal(result.refused.length, 3);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'api', 'appearance.ts'), 'utf8'), '// fixed\n');
  assert.ok(!fs.existsSync(path.join(path.dirname(root), 'escape.ts')));
  // No commit: the .git folder is exactly what it was (empty).
  assert.deepEqual(fs.readdirSync(path.join(root, '.git')), []);
});

/** A backend that remembers what the terminal did to it. */
function fakeBackend({ settings = { enabled: false, carrier: 'terminal', maxAttempts: null }, evidence = [] } = {}) {
  const calls = [];
  let served = false;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname + u.search, body, key: init.headers['x-api-key'] });
    const json = (status, data) => ({ ok: status < 400, status, json: async () => data });
    if (init.headers['x-api-key'] !== 'fyd_ok') return json(401, { detail: 'invalid key' });
    if (u.pathname === '/v1/developer/training/status') {
      return json(200, { active: false, settings, githubConnected: false, terminalSessions: [] });
    }
    if (u.pathname === '/v1/developer/training/sessions' && method === 'POST') {
      if (settings.carrier === 'github' && settings.enabled && !body.local) {
        return json(409, { detail: { error: 'carrier_is_github', message: 'GitHub trains this project.' } });
      }
      return json(200, { session: { id: 'ts_1', label: body.label }, settings });
    }
    if (u.pathname.startsWith('/v1/developer/training/sessions/ts_1')) return json(200, { ok: true });
    if (u.pathname === '/v1/developer/training/evidence' && method === 'GET') {
      if (served) return json(200, { evidence: [], lost: [] });
      served = true;
      return json(200, { evidence, lost: [] });
    }
    if (/\/evidence\/tre_1\/claim$/.test(u.pathname)) {
      return json(200, { runId: 'run_1', evidence: evidence[0], action: ACTION, neighbours: [], worked: [] });
    }
    if (/\/runs\/run_1\/diagnose$/.test(u.pathname)) {
      const sent = body.codeFiles.map((f) => f.path);
      if (!sent.includes('src/api/appearance.ts')) return json(502, { detail: { error: 'diagnosis_failed', message: 'no code' } });
      return json(200, {
        runId: 'run_1',
        class: 'B',
        cause: 'The API only accepts #rrggbb; the orb sends colour names.',
        manifestPatched: false,
        manifestReverted: false,
        verify: null,
        codeChanges: [{ path: 'src/api/appearance.ts', content: '// accepts names\n', summary: 'accept colour names' }],
        explanation: 'Accept CSS colour names.',
        locked: false,
        attempts: 1,
        status: 'proposed',
      });
    }
    if (/\/runs\/run_1\/fail$/.test(u.pathname)) return json(200, { ok: true });
    return json(404, { detail: 'nope' });
  };
  return { fetchImpl, calls };
}

test('a session presents itself, diagnoses what is waiting, writes the edit and says goodbye', async () => {
  const root = tmpApp();
  const backend = fakeBackend({ evidence: [EVIDENCE] });
  const log = [];
  const result = await runTrain({
    appRoot: root,
    apiKey: 'fyd_ok',
    apiUrl: 'https://api.test',
    once: true,
    fetchImpl: backend.fetchImpl,
    log: (l) => log.push(l),
    sleep: async () => {},
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.handled.length, 1);
  assert.equal(result.handled[0].status, 'proposed');
  assert.deepEqual(result.handled[0].written.map((w) => w.path), ['src/api/appearance.ts']);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'api', 'appearance.ts'), 'utf8'), '// accepts names\n');

  const paths = backend.calls.map((c) => `${c.method} ${c.path}`);
  assert.equal(paths[0], 'GET /v1/developer/training/status');
  assert.equal(paths[1], 'POST /v1/developer/training/sessions');
  assert.ok(paths.includes('POST /v1/developer/training/evidence/tre_1/claim'));
  assert.ok(paths.includes('POST /v1/developer/training/runs/run_1/diagnose'));
  assert.equal(paths[paths.length - 1], 'DELETE /v1/developer/training/sessions/ts_1', 'the goodbye');
  // Every call signs with the project key.
  assert.ok(backend.calls.every((c) => c.key === 'fyd_ok'));
  // The diagnosis was sent ONLY the located files, not the tree.
  const diagnose = backend.calls.find((c) => /diagnose$/.test(c.path));
  assert.ok(diagnose.body.codeFiles.length >= 1 && diagnose.body.codeFiles.length < 4);
  assert.ok(log.some((l) => /nothing was committed/i.test(l)));
  // Straight to the point: the failure, "Fixing…", what was fixed and what to
  // do to see it. The model's explanation only with --verbose.
  assert.ok(log.some((l) => /^Failure found: “make the orb green” → update_colour$/.test(l)), log.join('\n'));
  assert.ok(log.some((l) => /Fixing…/.test(l)));
  assert.ok(log.some((l) => /Fixed in code: src\/api\/appearance\.ts/.test(l)));
  assert.ok(log.some((l) => /commit and deploy to see it/.test(l)));
  assert.ok(!log.some((l) => /Accept CSS colour names/.test(l)), 'explanation is verbose-only');
});

test('failures are fixed one at a time, oldest first, with the queue counted; a repeat is one line and no diagnosis', async () => {
  const root = tmpApp();
  const newest = { ...EVIDENCE, id: 'tre_2', message: 'has fallado' };
  const backend = fakeBackend({ evidence: [newest, EVIDENCE] }); // the backend lists newest first
  const inner = backend.fetchImpl;
  backend.fetchImpl = async (url, init) => {
    if (/\/evidence\/tre_2\/claim$/.test(new URL(url).pathname)) {
      return {
        ok: true, status: 200,
        json: async () => ({
          runId: 'run_2', evidence: newest, action: ACTION, neighbours: [], worked: [],
          settled: { runId: 'run_2', class: 'D', cause: 'The API refused correctly.', status: 'nothing_wrong', repeatOf: 'run_1', repeatKind: 'failure' },
        }),
      };
    }
    return inner(url, init);
  };
  const log = [];
  const result = await runTrain({
    appRoot: root, apiKey: 'fyd_ok', apiUrl: 'https://api.test', once: true,
    fetchImpl: backend.fetchImpl, log: (l) => log.push(l), sleep: async () => {},
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.handled.map((h) => h.evidenceId), ['tre_1', 'tre_2'], 'oldest first');
  assert.ok(log.some((l) => /^Failure found: “make the orb green” → update_colour · 1 more waiting$/.test(l)), log.join('\n'));
  assert.ok(log.some((l) => /^Failure found: “has fallado” → update_colour$/.test(l)));
  assert.ok(log.some((l) => /Same failure already judged: nothing to fix — The API refused correctly\./.test(l)));
  // The settled record never went to the diagnosis.
  assert.ok(!backend.calls.some((c) => /run_2\/diagnose$/.test(c.path)));
  // Only ONE "Fixing…" — the repeat did not pretend to work.
  assert.equal(log.filter((l) => /Fixing…/.test(l)).length, 1);
});

test('a poll that fails is retried in silence; the terminal speaks only when it keeps failing', async () => {
  const root = tmpApp();
  const backend = fakeBackend();
  let polls = 0;
  const inner = backend.fetchImpl;
  backend.fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === '/v1/developer/training/evidence') {
      polls += 1;
      if (polls <= 3) return { ok: false, status: 502, json: async () => null };
    }
    return inner(url, init);
  };
  const log = [];
  const controller = new AbortController();
  const result = await runTrain({
    appRoot: root, apiKey: 'fyd_ok', apiUrl: 'https://api.test',
    fetchImpl: backend.fetchImpl, log: (l) => log.push(l), signal: controller.signal,
    sleep: async () => { if (polls >= 4) controller.abort(); },
  });
  assert.equal(result.ok, true);
  const complaints = log.filter((l) => /Could not read the records/.test(l));
  assert.equal(complaints.length, 1, log.join('\n'));
  assert.match(complaints[0], /3 times in a row .*502.*still trying/);
  assert.ok(log.some((l) => /reachable again/.test(l)));
});

test('a project that trains through GitHub is not taken over without --local', async () => {
  const root = tmpApp();
  const backend = fakeBackend({ settings: { enabled: true, carrier: 'github', maxAttempts: null } });
  const refused = await runTrain({
    appRoot: root, apiKey: 'fyd_ok', apiUrl: 'https://api.test', once: true, fetchImpl: backend.fetchImpl, log: () => {},
  });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /--local/);
  assert.ok(!backend.calls.some((c) => c.path.startsWith('/v1/developer/training/sessions')), 'no session was opened');

  const taken = await runTrain({
    appRoot: root, apiKey: 'fyd_ok', apiUrl: 'https://api.test', once: true, local: true,
    fetchImpl: backend.fetchImpl, log: () => {}, sleep: async () => {},
  });
  assert.equal(taken.ok, true);
  const start = backend.calls.find((c) => c.method === 'POST' && c.path === '/v1/developer/training/sessions');
  assert.equal(start.body.local, true);
});

test('a key that is not accepted stops before anything else, with the dashboard sentence', async () => {
  const root = tmpApp();
  const backend = fakeBackend();
  const result = await runTrain({
    appRoot: root, apiKey: 'fyd_wrong', apiUrl: 'https://api.test', once: true, fetchImpl: backend.fetchImpl, log: () => {},
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /copy the command again/);
  assert.equal(backend.calls.length, 1);
});
