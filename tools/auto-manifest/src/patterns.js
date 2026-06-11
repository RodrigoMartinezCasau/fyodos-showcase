/**
 * Layer 4 — pattern knowledge base.
 *
 * Loads patterns/*.md from the Fyodos monorepo, gives the LLM a summary list
 * for classification, and (when a pattern matches) feeds the full pattern to
 * the gap-fill step. With only 2-3 patterns today this layer is a seed: the
 * mechanism works, the coverage will come with volume.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function loadPatterns(patternsDir) {
  if (!fs.existsSync(patternsDir)) return [];
  return fs
    .readdirSync(patternsDir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => {
      const text = fs.readFileSync(path.join(patternsDir, f), 'utf8');
      const id = f.replace(/\.md$/, '');
      // First heading line as summary
      const firstLine = text.split('\n').find((l) => l.startsWith('#')) || id;
      return { id, file: f, text, summary: firstLine.replace(/^#+\s*/, '') };
    });
}

module.exports = { loadPatterns };
