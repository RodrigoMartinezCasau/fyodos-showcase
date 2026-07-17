/**
 * continuityFloor — a re-analysis must never DROP a previously-published
 * action that is still wired in the repo.
 *
 * PROBLEM (observed in production, 17/07/2026): a re-analysis of the Fiodos
 * dashboard silently omitted the landing actions (go_to_login / go_to_signup /
 * log_in_with_credentials) even though their code — and their generated
 * FYODOS:BRIDGE registrations — were untouched. The backend's continuity guard
 * reconciles RENAMES but cannot restore an action the model simply forgot, and
 * the wiring step then REMOVED the orphaned bridges: voice login died.
 *
 * FIX (mechanical, hallucination-proof): before wiring, compare the verified
 * manifest against the PREVIOUS published manifest. A previous action missing
 * from the new manifest is restored VERBATIM when — and only when — its
 * registration still exists in the repo's FYODOS:BRIDGE blocks (proof it was
 * wireable yesterday and its code is still in place). The extracted invoke
 * expression is fed back through the normal wiring verifier, so a restored
 * action is re-verified like any other; if that fails, it drops again with an
 * honest provenance note. Nothing is ever restored on `--fresh-intents`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.expo',
  'web-build', 'android', 'ios',
]);
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte']);

const BLOCK_RE = /\/\/ FYODOS:BRIDGE:START[\s\S]*?\/\/ FYODOS:BRIDGE:END/g;
// Generated single-line registration entries: `"intent": (args) => (EXPR),`
const ENTRY_RE = /"([A-Za-z0-9_$]+)"\s*:\s*\(\s*(args)?\s*\)\s*=>\s*\((.*)\),?\s*$/gm;

function walkCodeFiles(root, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkCodeFiles(path.join(root, entry.name), out);
      continue;
    }
    if (CODE_EXTS.has(path.extname(entry.name))) out.push(path.join(root, entry.name));
  }
  return out;
}

/**
 * Scan the repo's FYODOS:BRIDGE blocks and index every registered intent:
 * intent → { file (repo-relative), invoke (the inner expression) }.
 */
function extractBridgeRegistrations(appRoot) {
  const registrations = new Map();
  for (const file of walkCodeFiles(appRoot)) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!content.includes('FYODOS:BRIDGE:START')) continue;
    const rel = path.relative(appRoot, file).replace(/\\/g, '/');
    for (const block of content.match(BLOCK_RE) || []) {
      ENTRY_RE.lastIndex = 0;
      let entry;
      while ((entry = ENTRY_RE.exec(block))) {
        const [, intent, , invoke] = entry;
        if (!registrations.has(intent)) {
          registrations.set(intent, { file: rel, invoke: invoke.trim() });
        }
      }
    }
  }
  return registrations;
}

/**
 * Restore previously-published actions the new analysis dropped, when their
 * bridge registration still exists in the repo. Mutates `manifest`, `wiring`
 * and `provenance` in place; returns the restored intents.
 */
function restoreDroppedActions({ manifest, wiring, provenance, previousManifest, appRoot, log }) {
  const note = typeof log === 'function' ? log : () => {};
  const prevActions = (previousManifest && previousManifest.actions) || [];
  if (!prevActions.length) return [];

  const newIntents = new Set((manifest.actions || []).map((a) => String(a.intent || '')));
  const newHandlers = new Set(
    (manifest.actions || []).map((a) => String(a.handler || '').trim()).filter(Boolean),
  );

  let registrations = null; // lazy: only scan the repo when something dropped
  const restored = [];
  for (const prev of prevActions) {
    const intent = String(prev.intent || '').trim();
    if (!intent || newIntents.has(intent)) continue;
    // Same handler under a new intent = probable RENAME: the backend's
    // continuity reconciliation maps it back to the previous id at publish.
    // Restoring here would duplicate the action.
    const prevHandler = String(prev.handler || '').trim();
    if (prevHandler && newHandlers.has(prevHandler)) continue;

    if (registrations == null) registrations = extractBridgeRegistrations(appRoot);
    const reg = registrations.get(intent);
    if (!reg) {
      note(`[continuity] previous action '${intent}' missing from the new manifest and no bridge registration remains — respecting the drop`);
      continue;
    }

    manifest.actions.push(prev);
    if (wiring && typeof wiring === 'object') {
      wiring[intent] = {
        strategy: 'bridge',
        bridgeReason:
          'restored by the continuity floor: previously-published action the re-analysis dropped; its bridge registration still exists in the repo',
        bridge: {
          file: reg.file,
          // Anchor intentionally empty: the wiring verifier's anchor ladder
          // reuses the EXISTING block position for this intent (proven spot).
          anchor: '',
          invoke: reg.invoke,
          scope: 'statement',
        },
        requiredSymbols: [],
      };
    }
    provenance.actions.push({
      intent,
      included: true,
      verification:
        `restored from the previous manifest (continuity floor): still registered in '${reg.file}' — the re-analysis dropped it without the code changing`,
    });
    restored.push(intent);
    note(`[continuity] restored previously-published action '${intent}' (bridge in ${reg.file})`);
  }
  return restored;
}

module.exports = { restoreDroppedActions, extractBridgeRegistrations };
