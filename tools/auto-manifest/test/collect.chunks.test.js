'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkFilesForSweep, CHARS_PER_TOKEN } = require('../src/collect');

// Multi-pass: the files that do not fit the first prompt are swept in later
// passes, chunk by chunk. Each chunk must fit the same budget as the main
// prompt, keep tier order (the most valuable code is swept FIRST, so a cost cap
// that stops early still bought the best coverage), and never lose a file.

const file = (rel, chars, tier = 4) => ({ rel, tier, chars, content: 'x'.repeat(chars) });

test('every chunk fits the budget and nothing is lost', () => {
  const budgetTokens = 1000; // 3000 chars
  const files = [
    file('a.ts', 1200),
    file('b.ts', 1200),
    file('c.ts', 1200),
    file('d.ts', 900),
  ];
  const chunks = chunkFilesForSweep(files, budgetTokens);

  const budgetChars = budgetTokens * CHARS_PER_TOKEN;
  for (const chunk of chunks) {
    const size = chunk.reduce((n, f) => n + f.chars, 0);
    assert.ok(size <= budgetChars, `chunk of ${size} chars exceeds ${budgetChars}`);
    assert.ok(chunk.length > 0, 'no empty chunks');
  }
  const swept = chunks.flat().map((f) => f.rel).sort();
  assert.deepEqual(swept, ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
});

test('the most valuable files are swept first', () => {
  const chunks = chunkFilesForSweep(
    [
      file('generic.tsx', 2000, 4),
      file('screen.tsx', 2000, 0),
      file('service.ts', 2000, 2),
    ],
    1000,
  );
  assert.deepEqual(
    chunks.map((c) => c.map((f) => f.rel)),
    [['screen.tsx'], ['service.ts'], ['generic.tsx']],
  );
});

test('a file bigger than the whole budget is skipped, not sent alone forever', () => {
  const chunks = chunkFilesForSweep([file('monster.ts', 100000), file('small.ts', 500)], 1000);
  const swept = chunks.flat().map((f) => f.rel);
  assert.deepEqual(swept, ['small.ts'], 'the monster cannot fit any prompt');
});

test('nothing to sweep yields no passes', () => {
  assert.deepEqual(chunkFilesForSweep([], 1000), []);
});
