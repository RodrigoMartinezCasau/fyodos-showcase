/**
 * insertImportBlock must treat a MULTI-LINE import as one statement.
 *
 * Regression: the per-line matcher saw `import {` and inserted the generated
 * import in the middle of the open brace list, corrupting the host file
 * (TS1003 "Identifier expected") — which then failed the wiring of EVERY
 * action anchored in that file (the exact AssistantSection.tsx failure).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { insertImportBlock } = require('../src/wireHandlers');

const GEN = "import { fyodosRegisterHandler } from './fyodos/registry';";

test('inserts after a trailing multi-line import, never inside it', () => {
  const src = [
    "import { useEffect } from 'react';",
    'import {',
    '  prepareLogoForMobileUpload,',
    '  UnsupportedLogoFormatError,',
    "} from '@/lib/normalizeLogoUpload';",
    '',
    'export function AssistantSection() {}',
    '',
  ].join('\n');

  const out = insertImportBlock(src, GEN);
  const lines = out.split('\n');
  assert.strictEqual(lines[5], GEN, 'generated import must follow the closing `} from …` line');
  // The multi-line import must remain intact and contiguous.
  assert.ok(out.includes("import {\n  prepareLogoForMobileUpload,\n  UnsupportedLogoFormatError,\n} from '@/lib/normalizeLogoUpload';"));
});

test('single-line imports still get the block after the last one', () => {
  const src = ["import a from 'a';", "import b from 'b';", '', 'const x = 1;', ''].join('\n');
  const out = insertImportBlock(src, GEN);
  assert.strictEqual(out.split('\n')[2], GEN);
});

test('files with no imports get the block at the top', () => {
  const out = insertImportBlock('const x = 1;\n', GEN);
  assert.ok(out.startsWith(GEN));
});
