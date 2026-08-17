/**
 * Crash/cancel safety net for the wiring phases.
 *
 * Wiring edits the developer's own files and writes generated modules, and every
 * phase already knows how to undo its work — but only if it reaches its own
 * revert. A Ctrl-C (or a crash, or a SIGTERM from a CI runner) in the middle of a
 * phase skips all of that and leaves half-applied edits behind. Nothing fails
 * locally, because the CLI is gone; it fails on the developer's next build.
 *
 * So each phase registers its in-flight edits here the moment they hit disk, and
 * confirms them once they are verified. On an interrupt we roll back everything
 * still PENDING, newest first, and leave everything CONFIRMED alone: an action
 * that already passed its verification is the developer's to keep, and throwing
 * it away would be a second kind of damage.
 *
 * Every revert must be SYNCHRONOUS: a signal handler cannot wait for async work,
 * so the phases hand over plain `fs` closures (`revertAll`).
 */
'use strict';

let nextId = 1;
const pending = new Map();

/**
 * Register in-flight edits. `revert` must be synchronous and idempotent.
 * Returns a ticket to confirm (keep) or discard (roll back) them.
 */
function beginPendingEdits(revert, label = 'wiring') {
  if (typeof revert !== 'function') return null;
  const id = nextId++;
  pending.set(id, { revert, label });
  return id;
}

/** The edits survived verification: never roll them back after this. */
function confirmPendingEdits(id) {
  if (id == null) return false;
  return pending.delete(id);
}

/**
 * Undo every registered-but-unconfirmed edit, newest first (a later phase may
 * have edited a file an earlier one also touched, so the last snapshot taken is
 * the first to be restored). Returns the labels rolled back, for the report.
 */
function rollbackPendingEdits() {
  const rolledBack = [];
  for (const id of [...pending.keys()].reverse()) {
    const entry = pending.get(id);
    pending.delete(id);
    try {
      entry.revert();
      rolledBack.push(entry.label);
    } catch {
      /* best effort: an unrevertable snapshot must not stop the rest */
    }
  }
  return rolledBack;
}

function pendingEditCount() {
  return pending.size;
}

module.exports = {
  beginPendingEdits,
  confirmPendingEdits,
  rollbackPendingEdits,
  pendingEditCount,
};
