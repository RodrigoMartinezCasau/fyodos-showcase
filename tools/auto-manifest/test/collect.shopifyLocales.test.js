/**
 * Shopify locale collection — every published storefront language must reach
 * the analyzer, cheaply.
 *
 * Regression: locale files were sent WHOLE and alphabetically; a theme with
 * dozens of locales (bg, cs, da…) blew the budget before en/es arrived, and
 * the schema.json editor translations added pure noise. The AI then saw a
 * "monolingual" store and never emitted appLanguages/bubblePrompts — the
 * Salubell case (English storefront, Spanish-only bubbles).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectFiles } = require('../src/collect');

function makeTheme() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-shopify-'));
  fs.mkdirSync(path.join(root, 'layout'));
  fs.mkdirSync(path.join(root, 'locales'));
  fs.writeFileSync(path.join(root, 'layout', 'theme.liquid'), '<html>{{ content_for_layout }}</html>');
  // A default locale with real content + many other published locales, each
  // heavy enough that sending them whole would have crowded the budget.
  fs.writeFileSync(path.join(root, 'locales', 'en.default.json'), JSON.stringify({ cart: 'Cart', pad: 'x'.repeat(2000) }));
  for (const code of ['bg', 'cs', 'da', 'de', 'el', 'es', 'fi', 'fr']) {
    fs.writeFileSync(path.join(root, 'locales', `${code}.json`), JSON.stringify({ pad: 'y'.repeat(50000) }));
    fs.writeFileSync(path.join(root, 'locales', `${code}.schema.json`), JSON.stringify({ pad: 'z'.repeat(50000) }));
  }
  return root;
}

test('all published locales arrive as cheap stubs; schema.json noise is dropped', () => {
  const root = makeTheme();
  const { included: files, omitted } = collectFiles(root, { platform: 'shopify', maxInputTokens: 20_000 });
  const rels = files.map((f) => f.rel.replace(/\\/g, '/'));

  // Every published language is visible to the AI — including the ones that
  // sort AFTER the budget cut used to hit.
  for (const code of ['bg', 'cs', 'da', 'de', 'el', 'es', 'fi', 'fr']) {
    assert.ok(rels.includes(`locales/${code}.json`), `locales/${code}.json must be included`);
  }
  assert.ok(rels.includes('locales/en.default.json'), 'default locale must be included');
  assert.strictEqual((omitted ?? []).filter((o) => /^locales\//.test(o.rel)).length, 0);

  // Editor translations never reach the analysis.
  assert.ok(!rels.some((r) => r.endsWith('.schema.json')), 'schema.json files are noise');

  // Non-default locales are stubs (evidence of the language, not its content);
  // the default locale keeps its real content (store terminology).
  const es = files.find((f) => f.rel.replace(/\\/g, '/') === 'locales/es.json');
  assert.ok(es.content.includes('__fyodos_note'));
  assert.ok(es.chars < 200, 'stub must be tiny');
  const en = files.find((f) => f.rel.replace(/\\/g, '/') === 'locales/en.default.json');
  assert.ok(en.content.includes('Cart'), 'default locale keeps real content');
});
