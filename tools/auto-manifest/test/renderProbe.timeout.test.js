/**
 * Regression: an uncleared Promise.race timeout left the CLI hanging after
 * analysis printed its last line (shell prompt never returned).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { raceWithTimeout } = require('../src/renderProbe');

function timeoutHandleCount() {
  if (typeof process.getActiveResourcesInfo !== 'function') return null;
  return process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
}

describe('raceWithTimeout', () => {
  it('resolves with the fast promise and clears the watchdog timer', async () => {
    const before = timeoutHandleCount();
    const result = await raceWithTimeout(
      Promise.resolve('ok'),
      60_000,
      () => 'timed-out',
    );
    assert.equal(result, 'ok');
    // Flush microtasks/macrotasks so a cleared timer is gone from the handle list.
    await new Promise((r) => setImmediate(r));
    const after = timeoutHandleCount();
    if (before != null && after != null) {
      assert.equal(
        after,
        before,
        `watchdog timer still active (Timeout handles before=${before} after=${after})`,
      );
    }
  });

  it('returns onTimeout when the promise is slow', async () => {
    const result = await raceWithTimeout(
      new Promise(() => {}),
      20,
      () => 'timed-out',
    );
    assert.equal(result, 'timed-out');
  });
});
