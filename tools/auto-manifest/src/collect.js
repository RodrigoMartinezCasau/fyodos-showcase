/**
 * Source collector for the AI-first engine.
 *
 * Cheap, rule-based file selection — NOT analysis. It cannot "fail to zero":
 * every code file is included unless it is objectively irrelevant (deps,
 * native projects, assets, tests, build configs). When the app exceeds the
 * input budget, files are prioritized by tier (screens/state/services first,
 * generic UI last) and the omitted ones are reported so the model can declare
 * what it did not see.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIRS = new Set([
  'node_modules', 'assets', '.git', 'dist', 'build', '.expo', 'android', 'ios',
  'coverage', '.next', 'web-build',
]);
const SKIP_FILES = /\.(d\.ts|test\.|spec\.)|babel\.config|metro\.config|tailwind\.config|postcss\.config|jest\.config|eslint/;

/** Rough chars→tokens for budgeting (code averages ~3.6 chars/token). */
const CHARS_PER_TOKEN = 3.6;

/** Lower tier = higher priority when the budget forces choices. */
function tierFor(rel) {
  const p = rel.replace(/\\/g, '/');
  if (/^(src\/)?app\//.test(p)) return 0; // expo-router screens
  if (/(^|\/)(state|store|stores|context|contexts|redux)\//.test(p)) return 1;
  if (/(^|\/)(services|api|db|data|domain|agent|handlers|actions|lib|utils)\//.test(p)) return 1;
  if (/(^|\/)(hooks)\//.test(p)) return 2;
  return 3; // generic components / ui
}

function collectFiles(appRoot, { maxInputTokens = 150_000 } = {}) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      const full = path.join(dir, entry.name);
      const rel = path.relative(appRoot, full);
      if (!CODE_EXT.has(path.extname(entry.name))) continue;
      if (SKIP_FILES.test(rel)) continue;
      const content = fs.readFileSync(full, 'utf8');
      files.push({ rel, content, tier: tierFor(rel), chars: content.length });
    }
  };
  walk(appRoot);

  // Stable order: tier, then path (deterministic prompts → reproducible runs).
  files.sort((a, b) => a.tier - b.tier || a.rel.localeCompare(b.rel));

  const budgetChars = maxInputTokens * CHARS_PER_TOKEN;
  const included = [];
  const omitted = [];
  let used = 0;
  for (const f of files) {
    if (used + f.chars <= budgetChars) {
      included.push(f);
      used += f.chars;
    } else {
      omitted.push({ rel: f.rel, chars: f.chars, tier: f.tier });
    }
  }

  return {
    included,
    omitted,
    totalChars: used,
    estimatedTokens: Math.round(used / CHARS_PER_TOKEN),
  };
}

module.exports = { collectFiles };
