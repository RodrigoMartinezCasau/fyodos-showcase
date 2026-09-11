/**
 * `fiodos train` — the terminal carrier of the training agent
 * (docs/DESIGN_ENTRENAMIENTO_AGENTE_EXTERNO.md, D13, D18, D22).
 *
 * What it is: a session at the engineer's terminal while somebody talks to the
 * orb on the site. The backend keeps the records of what the orb ran and what
 * came back; this command presents itself (so the backend knows the project is
 * training — a single complaint is enough evidence with an engineer present,
 * D20), fetches the records that earned a diagnosis, LOCATES the code that
 * answered the failing call, sends it to the backend for the diagnosis, and
 * writes the code changes the diagnosis proposes into the working tree — as
 * plain edits, never a commit. The developer reviews them in their own git.
 *
 * What it is not: the brain. Diagnosis, the manifest patch and its replay
 * check (D19), the attempts cap (D5) and the accounting all live in the
 * backend, so the terminal and the GitHub carrier cannot drift apart.
 *
 * Nothing of the code leaves the machine except the files this command picks
 * for ONE diagnosis, which the backend keeps in memory for that call (the same
 * promise as the analysis proxy). It signs with the PROJECT key (`fyd_…`),
 * exactly like `install` and `analyze` — never a personal token.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectFiles } = require('./collect');

const HEARTBEAT_MS = 30_000;
const POLL_MS = 5_000;
const MAX_FILES_PER_DIAGNOSIS = 12;
const MAX_CHARS_PER_DIAGNOSIS = 200_000;
const MAX_CHARS_PER_FILE = 60_000;

// ── Backend ──────────────────────────────────────────────────────────────────

class TrainApiError extends Error {
  constructor(message, { code = '', status = 0 } = {}) {
    super(message);
    this.name = 'TrainApiError';
    this.code = code;
    this.status = status;
  }
}

/** Thin client over the api-key half of `/v1/developer/training/*`. */
class TrainClient {
  constructor({ apiKey, apiUrl, fetchImpl = globalThis.fetch }) {
    this.apiKey = apiKey;
    this.apiUrl = String(apiUrl || '').replace(/\/$/, '');
    this.fetch = fetchImpl;
  }

  async _call(method, route, body) {
    const res = await this.fetch(`${this.apiUrl}${route}`, {
      method,
      headers: {
        'x-api-key': this.apiKey,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const detail = data && data.detail;
      const code = detail && typeof detail === 'object' ? detail.error || '' : '';
      const message =
        (detail && typeof detail === 'object' && (detail.message || detail.error)) ||
        (typeof detail === 'string' ? detail : '') ||
        `Fiodos answered ${res.status}`;
      throw new TrainApiError(message, { code, status: res.status });
    }
    return data;
  }

  status() {
    return this._call('GET', '/v1/developer/training/status');
  }

  startSession(label, local) {
    return this._call('POST', '/v1/developer/training/sessions', { label, local: Boolean(local) });
  }

  heartbeat(sessionId) {
    return this._call('POST', `/v1/developer/training/sessions/${encodeURIComponent(sessionId)}/heartbeat`);
  }

  endSession(sessionId) {
    return this._call('DELETE', `/v1/developer/training/sessions/${encodeURIComponent(sessionId)}`);
  }

  listEvidence(local) {
    return this._call('GET', `/v1/developer/training/evidence?local=${local ? 'true' : 'false'}&limit=20`);
  }

  claim(evidenceId, local) {
    return this._call('POST', `/v1/developer/training/evidence/${encodeURIComponent(evidenceId)}/claim`, {
      local: Boolean(local),
    });
  }

  diagnose(runId, { evidenceId, codeFiles, notes }) {
    return this._call('POST', `/v1/developer/training/runs/${encodeURIComponent(runId)}/diagnose`, {
      evidenceId,
      codeFiles,
      notes: notes || '',
    });
  }

  fail(runId, error) {
    return this._call('POST', `/v1/developer/training/runs/${encodeURIComponent(runId)}/fail`, {
      error: String(error || '').slice(0, 2000),
    });
  }
}

// ── Locating the code ────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'api', 'v1', 'v2', 'the', 'and', 'for', 'with', 'from', 'this', 'that', 'http', 'https', 'www',
  'get', 'set', 'put', 'post', 'patch', 'delete', 'true', 'false', 'null', 'error', 'string',
  'json', 'com', 'app', 'index', 'main', 'src', 'lib', 'utils', 'types', 'const', 'function',
]);

function words(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * The terms a diagnosis will be looking for: the path the orb called (its
 * segments are almost always the route's name in the code), the action's
 * intent and handler, its parameters, and the error the server sent back.
 */
function termsFor(evidence, action) {
  const req = (evidence && evidence.request) || {};
  const res = (evidence && evidence.response) || {};
  const out = new Map();
  const add = (list, weight) => {
    for (const w of list) out.set(w, Math.max(out.get(w) || 0, weight));
  };
  let urlPath = '';
  try {
    urlPath = new URL(String(req.url || '')).pathname;
  } catch {
    urlPath = String(req.url || '');
  }
  const segments = urlPath.split('/').filter((s) => s && !/^[0-9a-f-]{8,}$/i.test(s) && !/^\d+$/.test(s));
  add(segments.flatMap(words), 5);
  add(words(evidence && evidence.intent), 4);
  add(words(action && action.handler), 4);
  const params = (action && (action.parameters || action.params)) || [];
  add((Array.isArray(params) ? params : []).flatMap((p) => words(p && p.name)), 3);
  add(words(evidence && evidence.error), 2);
  add(words(res.body).slice(0, 40), 2);
  add(words(evidence && evidence.message).slice(0, 20), 1);
  return out;
}

function scoreFile(file, terms) {
  const relWords = new Set(words(file.rel));
  const haystack = file.content.toLowerCase();
  let score = 0;
  for (const [term, weight] of terms) {
    if (relWords.has(term)) score += weight * 3;
    let idx = haystack.indexOf(term);
    let hits = 0;
    while (idx !== -1 && hits < 20) {
      hits += 1;
      idx = haystack.indexOf(term, idx + term.length);
    }
    if (hits) score += weight * Math.min(hits, 20) ** 0.5;
  }
  // Route/handler/API layers over generic UI: they are where a 400 is born.
  if (/(route|router|api|handler|controller|endpoint|service|schema|model)/i.test(file.rel)) score *= 1.3;
  if (/\.(test|spec)\./.test(file.rel) || /(^|\/)(tests?|__tests__)\//.test(file.rel)) score *= 0.2;
  return score;
}

/** The files a diagnosis should read for this record, best first, within caps. */
function locateCode(appRoot, evidence, action, { platform = 'web', collect = collectFiles } = {}) {
  const collected = collect(appRoot, { maxInputTokens: 400_000, platform });
  const files = (collected && collected.included) || [];
  const terms = termsFor(evidence, action);
  const ranked = files
    .map((f) => ({ file: f, score: scoreFile(f, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.file.rel.localeCompare(b.file.rel));
  const picked = [];
  let used = 0;
  for (const { file } of ranked) {
    if (picked.length >= MAX_FILES_PER_DIAGNOSIS) break;
    const content = file.content.length > MAX_CHARS_PER_FILE
      ? `${file.content.slice(0, MAX_CHARS_PER_FILE)}\n/* … truncated by fiodos train (${file.content.length} chars) … */`
      : file.content;
    if (used + content.length > MAX_CHARS_PER_DIAGNOSIS) continue;
    picked.push({ path: file.rel.replace(/\\/g, '/'), content });
    used += content.length;
  }
  return { files: picked, considered: files.length, terms: [...terms.keys()] };
}

// ── Writing what the diagnosis proposes ──────────────────────────────────────

const NEVER_WRITE = /(^|\/)(node_modules|\.git|\.env[^/]*|dist|build)(\/|$)/;

/**
 * Put the proposed files into the working tree — and nothing else: no commit,
 * no branch, no stash. The developer's git shows the diff and decides. A path
 * that leaves the app folder, or lands in dependencies or secrets, is refused.
 */
function applyCodeChanges(appRoot, codeChanges, { io = fs } = {}) {
  const root = path.resolve(appRoot);
  const written = [];
  const refused = [];
  for (const change of Array.isArray(codeChanges) ? codeChanges : []) {
    if (!change || typeof change.path !== 'string' || typeof change.content !== 'string') continue;
    const rel = change.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep) || NEVER_WRITE.test(rel)) {
      refused.push({ path: change.path, reason: 'outside the app or in a folder the agent never writes' });
      continue;
    }
    io.mkdirSync(path.dirname(full), { recursive: true });
    io.writeFileSync(full, change.content, 'utf8');
    written.push({ path: rel, summary: change.summary || '' });
  }
  return { written, refused };
}

// ── The session ──────────────────────────────────────────────────────────────

function describeOutcome(outcome) {
  const lines = [];
  const klass = outcome.class ? `class ${outcome.class}` : 'no class';
  lines.push(`${klass}${outcome.cause ? ` — ${outcome.cause}` : ''}`);
  if (outcome.manifestPatched) lines.push('manifest corrected and checked by replay; the orb serves it at its next load');
  else if (outcome.manifestReverted) lines.push('manifest patch reverted: the replay did not pick the right action');
  if (Array.isArray(outcome.codeChanges) && outcome.codeChanges.length) {
    lines.push(`${outcome.codeChanges.length} code change(s) proposed`);
  }
  if (outcome.explanation) lines.push(outcome.explanation);
  if (outcome.locked) lines.push(`given up on this action after ${outcome.attempts} attempt(s) — retry from the dashboard`);
  return lines;
}

/**
 * One record, start to finish: claim → locate → diagnose → write. Returns the
 * outcome, or null when the record was refused (another carrier took it, the
 * action is locked). Never throws for a single record's failure: the run is
 * marked failed in the backend and the session goes on.
 */
async function handleEvidence(client, appRoot, evidence, { local, log, platform }) {
  let claimed;
  try {
    claimed = await client.claim(evidence.id, local);
  } catch (e) {
    if (e instanceof TrainApiError && e.status === 409) return null;
    throw e;
  }
  const { runId, action } = claimed;
  const phrase = evidence.message ? `“${evidence.message}”` : evidence.intent;
  log(`Diagnosing ${phrase} (${evidence.intent}, class ${evidence.class || '?'})`);
  const located = locateCode(appRoot, claimed.evidence || evidence, action, { platform });
  try {
    const outcome = await client.diagnose(runId, {
      evidenceId: evidence.id,
      codeFiles: located.files,
      notes: located.files.length
        ? `Files picked by fiodos train from ${located.considered} in the working tree; terms: ${located.terms.slice(0, 12).join(', ')}.`
        : 'No matching code file was found in the working tree.',
    });
    const applied = applyCodeChanges(appRoot, outcome.codeChanges);
    for (const line of describeOutcome(outcome)) log(`  ${line}`);
    for (const w of applied.written) log(`  wrote ${w.path}${w.summary ? ` — ${w.summary}` : ''}`);
    for (const r of applied.refused) log(`  refused ${r.path}: ${r.reason}`);
    if (applied.written.length) log('  Review the diff in your git; nothing was committed.');
    return { ...outcome, written: applied.written, refused: applied.refused };
  } catch (e) {
    if (!(e instanceof TrainApiError) || e.code !== 'diagnosis_failed') {
      try {
        await client.fail(runId, (e && e.message) || String(e));
      } catch {
        /* the backend frees the run on its own timeout */
      }
    }
    log(`  Could not diagnose: ${(e && e.message) || e}`);
    return { failed: true, error: (e && e.message) || String(e) };
  }
}

/**
 * The command. Stays open until `signal` aborts (Ctrl-C) or, with `once`,
 * until the records waiting right now are handled.
 */
async function runTrain({
  appRoot,
  apiKey,
  apiUrl,
  local = false,
  once = false,
  platform = 'web',
  fetchImpl,
  log = (line) => console.error(line),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  signal = null,
  pollMs = POLL_MS,
  heartbeatMs = HEARTBEAT_MS,
}) {
  const client = new TrainClient({ apiKey, apiUrl, fetchImpl });
  const root = path.resolve(appRoot);
  if (!fs.existsSync(root)) return { ok: false, reason: `No such folder: ${root}` };

  let status;
  try {
    status = await client.status();
  } catch (e) {
    if (e instanceof TrainApiError && (e.status === 401 || e.status === 403)) {
      return { ok: false, reason: 'That project key was not accepted — copy the command again from your dashboard.' };
    }
    return { ok: false, reason: `Could not reach Fiodos (${apiUrl}): ${(e && e.message) || e}` };
  }
  const settings = status.settings || {};
  if (settings.carrier === 'github' && settings.enabled && !local) {
    return {
      ok: false,
      reason:
        'This project trains through GitHub 24/7. Run again with --local to take over from this terminal for this session (the GitHub agent waits while it lasts).',
    };
  }

  let session;
  try {
    const started = await client.startSession(`${os.hostname()}:${path.basename(root)}`, local);
    session = started.session;
  } catch (e) {
    return { ok: false, reason: `Could not start the training session: ${(e && e.message) || e}` };
  }

  log(`Training session open for ${path.basename(root)}. Talk to the orb on your site; what fails lands here.`);
  if (!once) log('Press Ctrl-C to end the session.');

  const heartbeat = setInterval(() => {
    client.heartbeat(session.id).catch(() => {});
  }, heartbeatMs);

  const handled = [];
  const aborted = () => Boolean(signal && signal.aborted);
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (aborted()) break;
      let list;
      try {
        list = await client.listEvidence(local);
      } catch (e) {
        if (e instanceof TrainApiError && e.code === 'carrier_is_github') {
          log('The project switched to GitHub while this session was open; ending here.');
          break;
        }
        log(`Could not read the records: ${(e && e.message) || e}`);
        list = { evidence: [] };
      }
      const items = Array.isArray(list.evidence) ? list.evidence : [];
      for (const ev of items) {
        if (aborted()) break;
        const outcome = await handleEvidence(client, root, ev, { local, log, platform });
        if (outcome) handled.push({ evidenceId: ev.id, intent: ev.intent, ...outcome });
      }
      if (once) break;
      await sleep(pollMs);
    }
  } finally {
    clearInterval(heartbeat);
    try {
      await client.endSession(session.id);
    } catch {
      /* a stale session expires on its own */
    }
    log(`Session closed. ${handled.length} record(s) handled.`);
  }
  return { ok: true, session, handled };
}

module.exports = {
  TrainClient,
  TrainApiError,
  applyCodeChanges,
  describeOutcome,
  handleEvidence,
  locateCode,
  runTrain,
  termsFor,
  HEARTBEAT_MS,
  POLL_MS,
};
