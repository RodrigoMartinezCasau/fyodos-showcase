'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { cancelNoticeLine } = require('../src/index.js');

// Ctrl-C used to leave the terminal's own "^C" echo glued to the live spinner
// row ("Analyzing your project in depth… 4s^C"). The developer now gets a
// branded red line instead, on its own row, saying the run was their call.

test('the cancellation notice is a branded red line, not a control character', () => {
  const line = cancelNoticeLine({ tty: true });
  assert.match(line, /You stopped this process from running\./);
  assert.ok(line.startsWith('\r\x1b[K'), 'erases the row the tty echoed "^C" into');
  assert.match(line, /\x1b\[38;5;203mYou stopped this process from running\.\x1b\[0m/);
  assert.match(line, /Fiodos/);
  assert.ok(line.endsWith('\n'), 'the next shell prompt starts on a clean row');
  assert.ok(!line.includes('^C'));
});

test('without a TTY the notice is plain text (piped output, CI logs)', () => {
  const line = cancelNoticeLine({ tty: false });
  assert.equal(line, '◉ Fiodos · You stopped this process from running.\n');
});

test('Ctrl-C during a real run prints the notice and exits 130', async () => {
  // A backend that accepts and never answers puts the run where the developer
  // actually cancels: waiting on the analysis. No network, no API key needed.
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const cli = path.join(__dirname, '..', 'src', 'index.js');

  try {
    const child = spawn(
      process.execPath,
      [cli, __dirname, '--api-key', 'fyd_test', '--api-url', apiUrl],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    const exit = new Promise((resolve) => child.on('close', resolve));

    await new Promise((resolve) => setTimeout(resolve, 2000));
    child.kill('SIGINT');

    assert.equal(await exit, 130);
    assert.match(stderr, /You stopped this process from running\./);
  } finally {
    server.close();
  }
});
