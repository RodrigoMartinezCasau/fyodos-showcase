/**
 * changeRegistry — transparent, per-file record of every change the Fiodos
 * installer makes in the client's repo.
 *
 * On each install / re-analysis run we write:
 *   · `.fyodos/changes/<runId>.json` — structured snapshot of THIS run (machine-readable)
 *   · `.fyodos/changes/index.json`     — chronological index of all runs
 *   · `src/fyodos/FYODOS_CHANGES.md`   — human-readable log (APPENDS; history is never lost)
 *
 * SECURITY: never embed API keys, secrets, or env values — only file paths, variable
 * names, and descriptions of what was touched.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function normRel(appRoot, absOrRel) {
  const rel = path.isAbsolute(absOrRel) ? path.relative(appRoot, absOrRel) : absOrRel;
  return String(rel || '').replace(/\\/g, '/');
}

function resolveFyodosDirRel(appRoot) {
  if (fs.existsSync(path.join(appRoot, 'src'))) return 'src/fyodos';
  return 'fyodos';
}

function makeRunId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function uniquePaths(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item.path;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// ── Phase summarizers ────────────────────────────────────────────────────────

function summarizeOrb(result) {
  if (!result) return { status: 'skipped', applied: false };
  const base = { status: result.status, mountFile: result.file || null };
  switch (result.status) {
    case 'added':
      return {
        ...base,
        applied: true,
        strategy: result.planSummary?.strategy || null,
        steps: result.planSummary?.steps || [],
        files: result.planSummary?.files || [],
        created: result.planSummary?.created || [],
        revert:
          'Remove the blocks between `FYODOS:ORB:START` and `FYODOS:ORB:END` (and the Fiodos import). See `FYODOS_ORB_MOUNT.md`.',
      };
    case 'already':
      return {
        ...base,
        applied: false,
        note: 'The orb was already mounted from a previous run; no orb files were changed.',
      };
    case 'declined':
      return {
        ...base,
        applied: false,
        note: 'You declined the automatic orb mount; your source files were not modified.',
      };
    case 'declined-noninteractive':
      return {
        ...base,
        applied: false,
        note: 'Non-interactive terminal: orb mount was skipped. Re-run with --yes to apply.',
      };
    case 'printed':
    case 'reverted':
    case 'failed':
      return {
        ...base,
        applied: false,
        reason: result.reason || result.error || null,
        note: 'Automatic orb mount did not complete; see the CLI output for the manual snippet.',
      };
    case 'skipped':
      return { ...base, applied: false, note: 'Orb wiring was skipped (--no-wire / --no-orb-wire).' };
    default:
      return { ...base, applied: false };
  }
}

function summarizeHandlers(result, appRoot) {
  if (!result) return { status: 'skipped', applied: false };
  const base = {
    status: result.status,
    autoCount: result.autoCount || 0,
    manualCount: result.manualCount || 0,
    docPath: result.docPath && appRoot ? normRel(appRoot, result.docPath) : null,
  };
  const applied = result.status === 'applied' || result.status === 'applied-untested';

  if (applied) {
    const bridgeEdits = (result.editedFiles || []).map((f) => ({
      path: normRel('', f),
      what:
        'Added reversible `FYODOS:BRIDGE:START` / `FYODOS:BRIDGE:END` blocks (import + registerFiodosBridge call).',
      intents: (result.plan?.auto || [])
        .filter((e) => e.kind === 'bridge' && e.bridge?.file === f)
        .map((e) => e.intent),
      revert: 'Delete the `FYODOS:BRIDGE:START` … `FYODOS:BRIDGE:END` blocks in this file.',
    }));
    return {
      ...base,
      applied: true,
      registryFile: result.registryFile ? normRel('', result.registryFile) : null,
      bridgeFile: result.bridgeFile ? normRel('', result.bridgeFile) : null,
      editedFiles: bridgeEdits,
      wiredIntents: (result.plan?.auto || []).map((e) => e.intent),
      manualIntents: (result.plan?.manual || result.plan?.review || []).map((e) => e.intent),
      note: result.partial && (result.degraded || []).length
        ? `${result.degraded.length} action(s) worked alone but could not coexist with the rest, even after a correction attempt, so they were left out to keep the build green: ${result.degraded.map((d) => d.intent).join(', ')}.`
        : undefined,
      revert:
        'Delete generated files under `src/fyodos/` (handlers.generated.*, bridge.*) and remove `FYODOS:BRIDGE` blocks from your components. See `FYODOS_HANDLERS.md`.',
    };
  }

  const docAlways =
    result.docPath &&
    ['declined', 'declined-noninteractive', 'manual-only', 'applied', 'applied-untested', 'reverted'].includes(
      result.status,
    );

  return {
    ...base,
    applied: false,
    docWritten: Boolean(docAlways),
    note:
      result.status === 'declined'
        ? 'You declined handler wiring; only the documentation file was written.'
        : result.status === 'declined-noninteractive'
          ? 'Non-interactive: handler wiring skipped. Documentation was written; re-run with --wire-yes to apply.'
          : result.status === 'manual-only'
            ? 'No actions could be wired automatically; see FYODOS_HANDLERS.md for manual steps.'
            : result.status === 'no-actions'
              ? 'Manifest has no actions; handler wiring was not needed.'
              : result.status === 'skipped'
                ? 'Handler wiring skipped (--no-wire).'
                : result.status === 'reverted'
                  ? result.revertVerified === false
                    ? 'Wiring was reverted because the post-install build failed, and the project STILL does not build afterwards — inspect the files above before deploying.'
                    : 'Wiring was reverted because the post-install build failed; the project was restored and verified with a build.'
                  : null,
  };
}

function summarizeRegistries(result) {
  if (!result) return { status: 'skipped', applied: false };
  const base = { status: result.status, file: result.file || null };
  switch (result.status) {
    case 'connected':
      return {
        ...base,
        applied: true,
        what: 'Added `registries={fyodosGeneratedRegistries}` to `<FiodosAgent />` inside the existing `FYODOS:ORB` block.',
        revert: 'Remove the `registries={…}` prop and its import from the orb mount file.',
      };
    case 'already':
      return { ...base, applied: false, note: 'Registries were already connected.' };
    case 'no-registry':
    case 'no-target':
    case 'not-mounted':
    case 'unsupported-framework':
      return { ...base, applied: false, note: 'Registry connection was not applicable for this framework/state.' };
    default:
      return { ...base, applied: false };
  }
}

function summarizeEnv(result) {
  if (!result) return { status: 'skipped', applied: false };
  const wp = result.writePlan;
  const base = { status: result.status };
  if (result.status === 'written' && wp) {
    return {
      ...base,
      applied: true,
      envFile: wp.targetRel || wp.file || null,
      variables: [wp.plan?.keyVar, wp.plan?.urlVar].filter(Boolean),
      gitignoreUpdated: true,
      note: 'API key and URL were written to your local env file (values are NOT recorded here). `.gitignore` was updated if needed.',
      revert: `Remove the Fiodos lines from ${wp.targetRel || 'your env file'}.`,
    };
  }
  if (result.status === 'already aligned') {
    return { ...base, applied: false, note: 'Local env already matched the published project key.' };
  }
  if (result.status === 'declined by user') {
    return { ...base, applied: false, note: 'You declined writing the API key to your local env file.' };
  }
  if (result.status === 'manual') {
    return {
      ...base,
      applied: false,
      note: wp?.kind === 'manual-angular' ? 'Angular env must be set manually in environment.ts.' : 'Env write requires manual setup for this framework.',
    };
  }
  return { ...base, applied: false };
}

function summarizeSession(result) {
  if (!result) return { status: 'skipped', applied: false };
  const base = { status: result.status, strategy: result.strategy || null };
  switch (result.status) {
    case 'applied':
    case 'applied-untested':
      return {
        ...base,
        applied: true,
        what: 'Connected the orb to the app\'s real session state (isAuthenticated/getUserId) automatically.',
        revert: 'Delete session.generated.* and remove the FYODOS:SESSION blocks + mount props.',
      };
    case 'review':
      return { ...base, applied: false, note: `Session left for review: ${result.reason || ''}` };
    case 'reverted':
      return { ...base, applied: false, note: `Session wiring reverted: ${result.reason || ''}` };
    case 'no-session':
      return { ...base, applied: false, note: 'No login detected — session wiring not needed.' };
    default:
      return { ...base, applied: false };
  }
}

function summarizeScreen(result) {
  if (!result) return { status: 'skipped', applied: false };
  const base = { status: result.status };
  switch (result.status) {
    case 'applied':
    case 'applied-untested':
      return {
        ...base,
        applied: true,
        what: 'Connected the app\'s ACTIVE screen state to the orb (state-driven screens, no URL change).',
        revert: 'Delete screen.generated.* and remove the FYODOS:SCREEN blocks + mount prop.',
      };
    case 'review':
      return { ...base, applied: false, note: `Screen wiring left for review: ${result.reason || ''}` };
    case 'reverted':
      return { ...base, applied: false, note: `Screen wiring reverted: ${result.reason || ''}` };
    case 'url-screens':
      return { ...base, applied: false, note: 'Screens are URL-driven — no screen wiring needed.' };
    default:
      return { ...base, applied: false };
  }
}

function collectFileEntries(appRoot, ctx) {
  const { orbResult, handlerResult, registryResult, sessionResult, screenResult, envResult } = ctx;
  const created = [];
  const modified = [];
  const docs = [];

  const fyodosDir = resolveFyodosDirRel(appRoot);

  // Orb
  if (orbResult?.status === 'added' && orbResult.planSummary) {
    for (const f of orbResult.planSummary.created || []) {
      created.push({
        path: f,
        phase: 'orb',
        what: 'Created by the orb mount installer.',
        revert: 'Delete this file if it was created solely for Fiodos (see FYODOS_ORB_MOUNT.md).',
      });
    }
    for (const f of orbResult.planSummary.files || []) {
      if ((orbResult.planSummary.created || []).includes(f)) continue;
      modified.push({
        path: f,
        phase: 'orb',
        what: 'Injected `<FiodosAgent />` (or bootstrap equivalent) between `FYODOS:ORB:START` / `FYODOS:ORB:END` markers.',
        revert: 'Remove the `FYODOS:ORB:START` … `FYODOS:ORB:END` block and the Fiodos import.',
      });
    }
    docs.push({
      path: `${fyodosDir}/FYODOS_ORB_MOUNT.md`,
      phase: 'orb',
      what: 'Human-readable orb mount summary (strategy, files, auth props).',
    });
  }

  // Handlers — doc is written even when wiring is declined
  if (handlerResult?.docPath) {
    docs.push({
      path: normRel(appRoot, handlerResult.docPath),
      phase: 'handlers',
      what: 'Action wiring plan: auto-wired actions, manual steps, security notes.',
    });
  }
  if (
    handlerResult &&
    (handlerResult.status === 'applied' || handlerResult.status === 'applied-untested')
  ) {
    if (handlerResult.registryFile) {
      created.push({
        path: normRel(appRoot, handlerResult.registryFile),
        phase: 'handlers',
        what: 'Generated handler registry (`handlers.generated.*`). Regenerated on each apply.',
        revert: 'Safe to delete; re-run the installer to regenerate.',
      });
    }
    if (handlerResult.bridgeFile) {
      created.push({
        path: normRel(appRoot, handlerResult.bridgeFile),
        phase: 'handlers',
        what: 'Bridge module for component-registered live functions.',
        revert: 'Safe to delete together with handlers.generated.*.',
      });
    }
    for (const edit of summarizeHandlers(handlerResult).editedFiles || []) {
      modified.push({ path: edit.path, phase: 'handlers', what: edit.what, revert: edit.revert, intents: edit.intents });
    }
  }

  // Registry connection
  if (registryResult?.status === 'connected' && registryResult.file) {
    modified.push({
      path: registryResult.file,
      phase: 'registries',
      what: 'Connected `registries={fyodosGeneratedRegistries}` to the mounted orb.',
      revert: 'Remove the registries prop and its import from the orb mount.',
    });
  }

  // Session wiring (auth awareness — automatic)
  if (
    sessionResult &&
    (sessionResult.status === 'applied' || sessionResult.status === 'applied-untested')
  ) {
    if (sessionResult.sessionFile) {
      created.push({
        path: normRel(appRoot, sessionResult.sessionFile),
        phase: 'session',
        what: 'Generated session module (`session.generated.*`): isAuthenticated/getUserId for the orb.',
        revert: 'Safe to delete; re-run the installer to regenerate.',
      });
    }
    if (sessionResult.editedFile) {
      modified.push({
        path: sessionResult.editedFile,
        phase: 'session',
        what: 'Registered the live session in the bridge (reversible FYODOS:SESSION block).',
        revert: 'Remove the FYODOS:SESSION blocks.',
      });
    }
    if (sessionResult.docPath) {
      docs.push({
        path: normRel(appRoot, sessionResult.docPath),
        phase: 'session',
        what: 'Session wiring summary: strategy, honesty contract, security notes.',
      });
    }
  }

  // Screen-truth wiring (state-driven screens — automatic)
  if (
    screenResult &&
    (screenResult.status === 'applied' || screenResult.status === 'applied-untested')
  ) {
    if (screenResult.screenFile) {
      created.push({
        path: normRel(appRoot, screenResult.screenFile),
        phase: 'screen',
        what: 'Generated screen module (`screen.generated.*`): reports the ACTIVE screen to the orb.',
        revert: 'Safe to delete; re-run the installer to regenerate.',
      });
    }
    if (screenResult.editedFile) {
      modified.push({
        path: screenResult.editedFile,
        phase: 'screen',
        what: 'Registered the live active-screen state in the bridge (reversible FYODOS:SCREEN block).',
        revert: 'Remove the FYODOS:SCREEN blocks.',
      });
    }
    if (screenResult.docPath) {
      docs.push({
        path: normRel(appRoot, screenResult.docPath),
        phase: 'screen',
        what: 'Screen-truth wiring summary: why it was needed, honesty contract.',
      });
    }
  }

  // Env (never record values)
  if (envResult?.status === 'written' && envResult.writePlan?.targetRel) {
    modified.push({
      path: envResult.writePlan.targetRel,
      phase: 'env',
      what: `Upserted ${envResult.writePlan.plan?.keyVar || 'FYODOS_API_KEY'} (and URL var if applicable). Values not logged here.`,
      revert: 'Remove the Fiodos env lines from this file.',
    });
    modified.push({
      path: '.gitignore',
      phase: 'env',
      what: 'Ensured the env file is git-ignored so secrets are not pushed.',
      revert: 'Optional: remove the Fiodos gitignore comment if you revert everything.',
    });
  }

  // This registry itself
  docs.push({
    path: `${fyodosDir}/FYODOS_CHANGES.md`,
    phase: 'registry',
    what: 'This cumulative change log (appended each run).',
  });
  docs.push({
    path: '.fyodos/changes/',
    phase: 'registry',
    what: 'Per-run JSON snapshots and index (machine-readable history).',
  });

  return {
    created: uniquePaths(created),
    modified: uniquePaths(modified),
    docs: uniquePaths(docs),
  };
}

function computeDelta(appRoot, current) {
  const indexPath = path.join(appRoot, '.fyodos', 'changes', 'index.json');
  const index = readJsonSafe(indexPath);
  if (!index?.runs?.length) return null;

  const prevPath = path.join(appRoot, '.fyodos', 'changes', index.runs[0].jsonFile);
  const prev = readJsonSafe(prevPath);
  if (!prev) return null;

  const prevIntents = new Set(prev.phases?.handlers?.wiredIntents || []);
  const currIntents = new Set(current.phases?.handlers?.wiredIntents || []);
  const addedIntents = [...currIntents].filter((i) => !prevIntents.has(i));
  const removedIntents = [...prevIntents].filter((i) => !currIntents.has(i));

  const prevFiles = new Set([
    ...(prev.files?.created || []).map((f) => f.path),
    ...(prev.files?.modified || []).map((f) => f.path),
  ]);
  const currFiles = new Set([
    ...(current.files?.created || []).map((f) => f.path),
    ...(current.files?.modified || []).map((f) => f.path),
  ]);
  const newFiles = [...currFiles].filter((f) => !prevFiles.has(f));

  return {
    previousRunId: prev.runId,
    previousTimestamp: prev.timestamp,
    actionsAdded: addedIntents,
    actionsRemoved: removedIntents,
    newOrModifiedFiles: newFiles,
    orbFirstInstall: prev.phases?.orb?.applied !== true && current.phases?.orb?.applied === true,
  };
}

/**
 * Build a structured record for one installer run from the phase results.
 */
function buildRunRecord(appRoot, ctx) {
  // Deliberately no CLI version / internal metrics in the record: the registry
  // documents WHAT changed in the client's repo, nothing about our tooling.
  const record = {
    runId: makeRunId(),
    timestamp: new Date().toISOString(),
    appName: ctx.appName || path.basename(appRoot),
    manifest: {
      actionCount: (ctx.manifest?.actions || []).length,
      routeCount: (ctx.manifest?.routes || []).length,
      generatedAt: ctx.publishMeta?.generatedAt || null,
    },
    phases: {
      orb: summarizeOrb(ctx.orbResult),
      handlers: summarizeHandlers(ctx.handlerResult, appRoot),
      registries: summarizeRegistries(ctx.registryResult),
      session: summarizeSession(ctx.sessionResult),
      screen: summarizeScreen(ctx.screenResult),
      env: summarizeEnv(ctx.envResult),
    },
    files: collectFileEntries(appRoot, ctx),
  };
  record.delta = computeDelta(appRoot, record);
  return record;
}

function renderHeader() {
  return [
    '# Fiodos — change log',
    '',
    'Every time the Fiodos installer runs (initial install or re-analysis), an entry is **appended** below.',
    'This is your transparency record: what Fiodos created or modified in your repo, file by file.',
    '',
    '- **Revert orb changes:** remove `FYODOS:ORB:START` … `FYODOS:ORB:END` blocks (see `FYODOS_ORB_MOUNT.md`).',
    '- **Revert handler wiring:** delete `handlers.generated.*`, `bridge.*`, and `FYODOS:BRIDGE` blocks (see `FYODOS_HANDLERS.md`).',
    '- **Machine-readable history:** `.fyodos/changes/` (one JSON file per run).',
    '',
    'No API keys or secrets appear in this log.',
    '',
    '---',
  ].join('\n');
}

function renderFileList(title, items) {
  if (!items?.length) return [];
  const L = [`### ${title}`, ''];
  for (const f of items) {
    L.push(`- \`${f.path}\`${f.intents?.length ? ` — actions: ${f.intents.map((i) => `\`${i}\``).join(', ')}` : ''}`);
    if (f.what) L.push(`  - ${f.what}`);
    if (f.revert) L.push(`  - Revert: ${f.revert}`);
  }
  L.push('');
  return L;
}

function renderRunSection(record) {
  const L = [];
  L.push(`## Run ${record.timestamp}`);
  L.push('');
  L.push(`- App: \`${record.appName}\``);
  L.push(`- Manifest: ${record.manifest.actionCount} action(s), ${record.manifest.routeCount} route(s)`);
  L.push(`- Run id: \`${record.runId}\``);
  L.push('');

  if (record.delta) {
    L.push('### Changes vs previous run');
    L.push('');
    if (record.delta.actionsAdded.length) {
      L.push(`- Actions newly wired: ${record.delta.actionsAdded.map((i) => `\`${i}\``).join(', ')}`);
    }
    if (record.delta.actionsRemoved.length) {
      L.push(`- Actions no longer wired: ${record.delta.actionsRemoved.map((i) => `\`${i}\``).join(', ')}`);
    }
    if (record.delta.newOrModifiedFiles.length) {
      L.push(`- Files touched this run: ${record.delta.newOrModifiedFiles.map((f) => `\`${f}\``).join(', ')}`);
    }
    if (!record.delta.actionsAdded.length && !record.delta.actionsRemoved.length && !record.delta.newOrModifiedFiles.length) {
      L.push('- No file changes compared to the previous run (re-analysis only updated the manifest/backend).');
    }
    L.push('');
  }

  const phases = [
    ['Orb mount', record.phases.orb],
    ['Action handlers', record.phases.handlers],
    ['Registry connection', record.phases.registries],
    ['Environment', record.phases.env],
  ];
  for (const [label, ph] of phases) {
    if (!ph || ph.status === 'skipped') continue;
    L.push(`### ${label}`);
    L.push('');
    L.push(`- Status: \`${ph.status}\`${ph.applied ? ' (applied)' : ''}`);
    if (ph.strategy) L.push(`- Strategy: \`${ph.strategy}\``);
    if (ph.steps?.length) {
      L.push('- Steps:');
      for (const s of ph.steps) L.push(`  - ${s}`);
    }
    if (ph.note) L.push(`- ${ph.note}`);
    if (ph.revert) L.push(`- Revert: ${ph.revert}`);
    L.push('');
  }

  L.push(...renderFileList('Files created', record.files.created));
  L.push(...renderFileList('Files modified', record.files.modified));
  L.push(...renderFileList('Documentation generated', record.files.docs));

  L.push('---');
  return L.join('\n');
}

function briefSummary(record) {
  const parts = [];
  if (record.phases.orb.applied) parts.push('orb mounted');
  if (record.phases.handlers.applied) parts.push(`${record.phases.handlers.autoCount} handlers wired`);
  if (record.phases.registries.applied) parts.push('registries connected');
  if (record.phases.env.applied) parts.push('env written');
  const touched = record.files.created.length + record.files.modified.length;
  if (!parts.length) parts.push('docs/analysis only');
  return `${parts.join(', ')} · ${touched} file(s) touched`;
}

/**
 * Persist the run record: JSON snapshot + append to FYODOS_CHANGES.md + update index.
 */
function writeChangeRegistry(appRoot, runRecord) {
  const changesDir = path.join(appRoot, '.fyodos', 'changes');
  fs.mkdirSync(changesDir, { recursive: true });

  const jsonAbs = path.join(changesDir, `${runRecord.runId}.json`);
  fs.writeFileSync(jsonAbs, `${JSON.stringify(runRecord, null, 2)}\n`);

  const fyodosDir = resolveFyodosDirRel(appRoot);
  const mdAbs = path.join(appRoot, fyodosDir, 'FYODOS_CHANGES.md');
  fs.mkdirSync(path.dirname(mdAbs), { recursive: true });

  const section = renderRunSection(runRecord);
  if (fs.existsSync(mdAbs)) {
    const existing = fs.readFileSync(mdAbs, 'utf8').trimEnd();
    fs.writeFileSync(mdAbs, `${existing}\n\n${section}\n`);
  } else {
    fs.writeFileSync(mdAbs, `${renderHeader()}\n\n${section}\n`);
  }

  const indexAbs = path.join(changesDir, 'index.json');
  const index = readJsonSafe(indexAbs) || { runs: [] };
  index.runs.unshift({
    runId: runRecord.runId,
    timestamp: runRecord.timestamp,
    jsonFile: `${runRecord.runId}.json`,
    summary: briefSummary(runRecord),
  });
  fs.writeFileSync(indexAbs, `${JSON.stringify(index, null, 2)}\n`);

  return {
    mdRel: normRel(appRoot, mdAbs),
    jsonRel: normRel(appRoot, jsonAbs),
    indexRel: normRel(appRoot, indexAbs),
  };
}

module.exports = {
  buildRunRecord,
  writeChangeRegistry,
  resolveFyodosDirRel,
  renderRunSection,
  briefSummary,
};
