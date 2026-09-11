/**
 * `fiodos train` — the terminal carrier of the training agent
 * (docs/DESIGN_ENTRENAMIENTO_AGENTE_EXTERNO.md, D13, D18, D22).
 *
 * What it is: a session at the engineer's terminal while somebody talks to the
 * orb on the site. The backend keeps the records of what the orb ran and what
 * came back; this command presents itself (so the backend knows the project is
 * training — a single complaint is enough evidence with an engineer present,
 * D20), fetches the records that earned a diagnosis, LOCATES the code that
 * answered the failing call and sends it to the backend for the diagnosis.
 *
 * The code is READ, never written (owner's decision, 11/09/2026). The agent
 * connects what people say to what the app's code already does — the right
 * route, method, fields and phrases go into the MANIFEST, which the backend
 * serves at the orb's next page load. What the code cannot do is reported as
 * a missing capability for the developer to build; an agent allowed to write
 * code would, asked to "add a TV to the cart" on a site that sells no TVs,
 * build a place to sell TVs. This command touches no file of the repository.
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

const { readSourceTree } = require('./collect');

const HEARTBEAT_MS = 30_000;
const POLL_MS = 5_000;
const MAX_FILES_PER_DIAGNOSIS = 8;
// A file is sent WHOLE or not at all: half a route file teaches the model half
// of what the endpoint accepts, and the manifest it writes is then a guess.
// The API layer of a real app (112k chars, measured 11/09/2026) was above the
// old 60k per-file cut. The total (~80k tokens) leaves room for the evidence
// and the answer inside every model the developer can pick, 128k windows too.
const MAX_CHARS_PER_DIAGNOSIS = 240_000;

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
  // Words an API publishes in place of an id (`/projects/current`): they name
  // the caller, not the route, and they are everywhere in any codebase.
  'current', 'self',
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

/**
 * The files a diagnosis should read for this record, best first, within caps.
 *
 * Run from the ROOT of the app's repository: the call that failed was answered
 * by the API (Python, Go, Node…), and the page the orb sits on is only half of
 * the story. The whole tree is read (no analysis budget — that budget is
 * applied before relevance is known and drops exactly the file a diagnosis
 * needs), every file is scored against the failing call, and the best ones go
 * whole. A file too large to go whole is named in `tooLarge` so the diagnosis
 * knows it exists and can say the fix belongs there without rewriting it.
 */
function locateCode(appRoot, evidence, action, { read = readSourceTree } = {}) {
  const files = read(appRoot, 'train') || [];
  const terms = termsFor(evidence, action);
  const ranked = files
    .map((f) => ({ file: f, score: scoreFile(f, terms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.file.rel.localeCompare(b.file.rel));
  const picked = [];
  const tooLarge = [];
  let used = 0;
  for (const { file } of ranked) {
    if (picked.length >= MAX_FILES_PER_DIAGNOSIS) break;
    const rel = file.rel.replace(/\\/g, '/');
    if (file.content.length > MAX_CHARS_PER_DIAGNOSIS) {
      if (tooLarge.length < 4) tooLarge.push({ path: rel, chars: file.content.length });
      continue;
    }
    if (used + file.content.length > MAX_CHARS_PER_DIAGNOSIS) continue;
    picked.push({ path: rel, content: file.content });
    used += file.content.length;
  }
  return { files: picked, tooLarge, considered: files.length, terms: [...terms.keys()] };
}

/** What the brief says about where the code came from and what could not go. */
function locateNotes(located) {
  if (!located.files.length && !located.tooLarge.length) {
    return 'No matching code file was found in the working tree.';
  }
  const parts = [
    `Files picked by fiodos train from ${located.considered} in the repository (each one complete); terms: ${located.terms.slice(0, 12).join(', ')}.`,
  ];
  if (located.tooLarge.length) {
    parts.push(
      'Also matching but too large to send, so NOT shown: ' +
        located.tooLarge.map((f) => `${f.path} (${f.chars} chars)`).join(', ') +
        '. Do not point the manifest at a route or field you have not seen declared; if the answer lives there, say so in `cause`.',
    );
  }
  return parts.join(' ');
}

// ── The session ──────────────────────────────────────────────────────────────

/**
 * What the terminal says about one concluded run. Straight to the point: the
 * engineer is watching people talk to the orb, not reading an essay. One line
 * for the verdict, one for what to do to see it (reload the page with the
 * orb: the manifest is served on load). The model's explanation only with
 * `verbose`. Nothing here is ever "fixed in code": the agent does not write
 * code, so what the app cannot do is named for the developer to build.
 */
function describeOutcome(outcome, { verbose = false } = {}) {
  const lines = [];
  const cause = outcome.cause ? ` — ${outcome.cause}` : '';

  if (outcome.repeatOf) {
    lines.push(
      outcome.class === 'D'
        ? `Same failure already judged: nothing to fix${cause}`
        : `Same sentence already judged, no fix from here${cause}`,
    );
    return lines;
  }
  if (outcome.class === 'D') {
    lines.push(`Nothing to fix: the call was refused correctly${cause}`);
    return lines;
  }
  if (outcome.manifestPatched) {
    lines.push(`Fixed in the manifest${cause}`);
    lines.push('→ Reload the page where the orb is to see it (the manifest is served on load; nothing to publish).');
  } else if (outcome.manifestReverted) {
    lines.push(`Manifest fix tried and reverted: the replay did not pick the right action${cause}`);
  } else {
    lines.push(
      outcome.missingCapability
        ? `No fix from here: your app has no operation for this — it is yours to add to your API: ${outcome.missingCapability}${cause}`
        : `No fix from here${cause}`,
    );
  }
  if (outcome.locked) lines.push(`Given up on this action after ${outcome.attempts} attempt(s) — retry from the dashboard.`);
  if (verbose && outcome.explanation) lines.push(outcome.explanation);
  return lines;
}

/**
 * One record, start to finish: claim → locate → diagnose → write. Returns the
 * outcome, or null when the record was refused (another carrier took it, the
 * action is locked). Never throws for a single record's failure: the run is
 * marked failed in the backend and the session goes on.
 */
async function handleEvidence(client, appRoot, evidence, { local, log, verbose = false, waiting = 0 }) {
  let claimed;
  try {
    claimed = await client.claim(evidence.id, local);
  } catch (e) {
    if (e instanceof TrainApiError && e.status === 409) return null;
    throw e;
  }
  const { runId, action } = claimed;
  const phrase = evidence.message ? `“${evidence.message}”` : evidence.intent;
  const queue = waiting > 0 ? ` · ${waiting} more waiting` : '';
  log(`Failure found: ${phrase} → ${evidence.intent}${queue}`);

  // Already judged on an identical record: the backend closed the run itself.
  if (claimed.settled) {
    for (const line of describeOutcome(claimed.settled, { verbose })) log(`  ${line}`);
    return claimed.settled;
  }

  log('  Fixing…');
  const located = locateCode(appRoot, claimed.evidence || evidence, action);
  try {
    // The backend writes the manifest (or nothing). Nothing comes back for
    // this command to write: the repository is read, never touched.
    const outcome = await client.diagnose(runId, {
      evidenceId: evidence.id,
      codeFiles: located.files,
      notes: locateNotes(located),
    });
    for (const line of describeOutcome(outcome, { verbose })) log(`  ${line}`);
    return outcome;
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

//: Polls that may fail before the terminal says so: the edge in front of the
//: API answers an occasional 502 that the next poll does not see.
const QUIET_POLL_FAILURES = 3;

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
  verbose = false,
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
  let pollFailures = 0;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (aborted()) break;
      let list;
      try {
        list = await client.listEvidence(local);
        if (pollFailures >= QUIET_POLL_FAILURES) log('Fiodos is reachable again.');
        pollFailures = 0;
      } catch (e) {
        if (e instanceof TrainApiError && e.code === 'carrier_is_github') {
          log('The project switched to GitHub while this session was open; ending here.');
          break;
        }
        pollFailures += 1;
        if (pollFailures === QUIET_POLL_FAILURES) {
          log(`Could not read the records ${pollFailures} times in a row (${(e && e.message) || e}); still trying.`);
        }
        list = { evidence: [] };
      }
      // Oldest first: the failures are fixed in the order they happened, one
      // at a time — the next one starts only when this one has concluded.
      const items = (Array.isArray(list.evidence) ? list.evidence : []).slice().reverse();
      for (let i = 0; i < items.length; i += 1) {
        if (aborted()) break;
        const ev = items[i];
        const outcome = await handleEvidence(client, root, ev, {
          local, log, verbose, waiting: items.length - i - 1,
        });
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
  describeOutcome,
  handleEvidence,
  locateCode,
  locateNotes,
  runTrain,
  termsFor,
  HEARTBEAT_MS,
  POLL_MS,
};
