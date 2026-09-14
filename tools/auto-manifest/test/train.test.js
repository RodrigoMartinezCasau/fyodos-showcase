/**
 * `fiodos train` — the terminal carrier of the training agent.
 *
 * What these tests defend: the session presents itself and says goodbye; the
 * code sent for a diagnosis is the code the failing call points at (not the
 * whole tree), read from the repository root in any language, each file whole
 * or not at all; the repository is READ and never written — even when a model
 * answers with code, nothing lands in the working tree (owner's decision,
 * 11/09/2026); a project training through GitHub is not taken over by accident
 * (D18); the run is marked failed when the terminal cannot finish.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const train = require('../src/train');
const { locateCode, locateNotes, runTrain, termsFor } = train;

/** Every file under `root` with its content — to prove a run changed none of them. */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}

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

  const located = locateCode(root, EVIDENCE, ACTION);
  assert.equal(located.files[0].path, 'src/api/appearance.ts');
  assert.ok(located.files.length < located.considered, 'not the whole tree');
  assert.ok(!located.files.some((f) => f.path.endsWith('Footer.tsx')), 'unrelated UI is left out');
});

test('a diagnosis from the repo root can see the API, even when it is Python', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fiodos-train-mono-'));
  fs.mkdirSync(path.join(root, 'dashboard', 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'backend', 'routes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'examples', 'other'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'src', 'Home.tsx'), 'export const Home = () => <main>home</main>;\n');
  fs.writeFileSync(
    path.join(root, 'backend', 'routes', 'app_api.py'),
    [
      '@router.patch("/v1/projects/{projectId}/appearance")',
      'def update_appearance(accentColor: str):',
      '    if not accentColor.startswith("#"):',
      '        raise HTTPException(400, "invalid_value")',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(root, 'examples', 'other', 'appearance.py'), 'def update_appearance():\n    pass\n');

  const located = locateCode(root, EVIDENCE, ACTION);
  assert.ok(
    located.files.some((f) => f.path === 'backend/routes/app_api.py'),
    `API was not among ${located.files.map((f) => f.path).join(', ') || '(none)'}`,
  );
  assert.ok(
    !located.files.some((f) => f.path.startsWith('examples/')),
    'example apps are not the customer API',
  );
});

test('a file is sent whole or not at all', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fiodos-train-whole-'));
  fs.mkdirSync(path.join(root, 'api'), { recursive: true });
  // The relevant file, far above the per-diagnosis cap: the old code cut it at
  // 60k chars, and half a route file teaches the model half of what the
  // endpoint accepts — the manifest it writes is then a guess.
  const huge = `# appearance route\n${'x = 1  # appearance accentColor\n'.repeat(12_000)}`;
  assert.ok(huge.length > 240_000);
  fs.writeFileSync(path.join(root, 'api', 'appearance.py'), huge);
  fs.writeFileSync(path.join(root, 'api', 'colours.py'), 'def accent_color(appearance):\n    return appearance\n');

  const located = locateCode(root, EVIDENCE, ACTION);
  assert.ok(!located.files.some((f) => f.path === 'api/appearance.py'), 'the huge file did not go cut');
  assert.ok(!located.files.some((f) => f.content.includes('truncated')), 'nothing goes truncated');
  assert.deepEqual(located.tooLarge.map((f) => f.path), ['api/appearance.py']);
  assert.ok(located.files.some((f) => f.path === 'api/colours.py'), 'the smaller relevant file still goes');
  assert.match(locateNotes(located), /too large to send.*api\/appearance\.py/);
});

test('the terminal has no way to write code: the module exports none, and a run leaves the tree byte for byte', async () => {
  // Not a rule the model is asked to follow — a channel that does not exist.
  assert.equal(train.applyCodeChanges, undefined);
  assert.ok(!/writeFileSync|mkdirSync/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'train.js'), 'utf8')));

  // A backend (or a model behind it) that answers with code anyway: nothing lands.
  const root = tmpApp();
  fs.mkdirSync(path.join(root, '.git'));
  const before = snapshot(root);
  const backend = fakeBackend({
    evidence: [EVIDENCE],
    diagnosis: {
      status: 'unresolved',
      manifestPatched: false,
      codeChanges: [{ path: 'src/api/appearance.ts', content: '// rewritten by a model\n', summary: 'nope' }],
    },
  });
  const result = await runTrain({
    appRoot: root,
    apiKey: 'fyd_ok',
    apiUrl: 'https://api.test',
    once: true,
    fetchImpl: backend.fetchImpl,
    log: () => {},
    sleep: async () => {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(snapshot(root), before, 'no file of the repository changed');
  assert.deepEqual(fs.readdirSync(path.join(root, '.git')), [], 'and no commit');
});

/** A backend that remembers what the terminal did to it. */
function fakeBackend({
  settings = { enabled: false, carrier: 'terminal', maxAttempts: null },
  evidence = [],
  diagnosis = {},
  // What the model asks for on the first round, when it asks (the backend
  // answers `needs_code` and the terminal owes a second round).
  askFirst = null,
} = {}) {
  const calls = [];
  let served = false;
  let diagnoseCalls = 0;
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
      diagnoseCalls += 1;
      const sent = body.codeFiles.map((f) => f.path);
      if (askFirst && diagnoseCalls === 1) {
        return json(200, { status: 'needs_code', runId: 'run_1', round: 2, lookFor: askFirst, why: 'the page sends it from somewhere' });
      }
      if (!sent.includes('src/api/appearance.ts')) return json(502, { detail: { error: 'diagnosis_failed', message: 'no code' } });
      return json(200, {
        runId: 'run_1',
        class: 'B',
        cause: 'The manifest sent `colour`; the route reads `accentColor`.',
        manifestPatched: true,
        manifestReverted: false,
        verify: { ok: true },
        explanation: 'The template now names the field the code declares.',
        locked: false,
        attempts: 1,
        status: 'patched',
        ...diagnosis,
      });
    }
    if (/\/runs\/run_1\/fail$/.test(u.pathname)) return json(200, { ok: true });
    return json(404, { detail: 'nope' });
  };
  return { fetchImpl, calls };
}

test('a session presents itself, diagnoses what is waiting, reports the manifest fix and says goodbye', async () => {
  const root = tmpApp();
  const before = snapshot(root);
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
  assert.equal(result.handled[0].status, 'patched');
  assert.deepEqual(snapshot(root), before, 'the repository is read, never written');

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
  // Straight to the point: the failure, "Fixing…", what was fixed and what to
  // do to see it (reload: the manifest is served on load). The model's
  // explanation only with --verbose. Never "fixed in code".
  assert.ok(log.some((l) => /^Failure found: “make the orb green” → update_colour$/.test(l)), log.join('\n'));
  assert.ok(log.some((l) => /Fixing…/.test(l)));
  assert.ok(log.some((l) => /Fixed in the manifest/.test(l)));
  assert.ok(log.some((l) => /Reload the page/.test(l)));
  assert.ok(!log.some((l) => /in code|commit|deploy/i.test(l)), log.join('\n'));
  assert.ok(!log.some((l) => /names the field the code declares/.test(l)), 'explanation is verbose-only');
});

test('when the model asks for more code, the terminal answers from the tree it read: named files whole, terms searched, the rest named as missing', async () => {
  const root = tmpApp();
  const before = snapshot(root);
  const backend = fakeBackend({
    evidence: [EVIDENCE],
    askFirst: { files: ['Footer.tsx', 'src/nowhere.ts'], terms: ['header', 'zzz-nothing-says-this'] },
    diagnosis: {
      status: 'unresolved',
      manifestPatched: false,
      rounds: 2,
      foundInCode: { file: 'src/ui/Footer.tsx', symbol: 'Footer', what: 'the switch that does it' },
      missingCapability: 'accept it in PATCH /appearance',
    },
  });
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
  assert.deepEqual(snapshot(root), before, 'two rounds of reading, nothing written');

  const rounds = backend.calls.filter((c) => /diagnose$/.test(c.path)).map((c) => c.body);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].round, 1);
  assert.ok(rounds[0].repoIndex.includes('src/ui/Footer.tsx'), 'the index names every code path from round one');
  assert.ok(!rounds[0].codeFiles.some((f) => f.path === 'src/ui/Footer.tsx'), 'but the page is not sent unasked');

  const second = rounds[1];
  assert.equal(second.round, 2);
  const sent = second.codeFiles.map((f) => f.path);
  assert.ok(sent.includes('src/ui/Footer.tsx'), 'a tail written from memory resolves to the one file that ends with it');
  assert.equal(second.codeFiles.find((f) => f.path === 'src/ui/Footer.tsx').content, fs.readFileSync(path.join(root, 'src/ui/Footer.tsx'), 'utf8'), 'whole');
  assert.ok(sent.includes('src/ui/Header.tsx'), 'the term found the file that mentions it');
  assert.ok(sent.includes('src/api/appearance.ts'), 'what was on the table stays while it fits');
  assert.equal(second.priorRounds.length, 1);
  assert.deepEqual(second.priorRounds[0].asked, { files: ['Footer.tsx', 'src/nowhere.ts'], terms: ['header', 'zzz-nothing-says-this'] });
  assert.ok(second.priorRounds[0].didNotCome.some((n) => n.path === 'src/nowhere.ts'));
  assert.ok(second.priorRounds[0].didNotCome.some((n) => n.term === 'zzz-nothing-says-this'));
  assert.ok(/Did NOT come: .*src\/nowhere\.ts/.test(second.notes), second.notes);

  assert.ok(log.some((l) => /Reading more code: the page sends it from somewhere/.test(l)), log.join('\n'));
  assert.ok(log.some((l) => /Exists in code, not reachable by the orb/.test(l)), log.join('\n'));
  assert.ok(log.some((l) => /Found in code: src\/ui\/Footer\.tsx → Footer — the switch that does it/.test(l)));
  assert.ok(log.some((l) => /Yours to expose in the API the orb calls: accept it in PATCH \/appearance/.test(l)));
  assert.ok(log.some((l) => /read the code in 2 rounds/.test(l)));
  assert.ok(!log.some((l) => /has no operation for this|nothing in the code does this/.test(l)), 'never "does not exist" about a thing it found');
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
