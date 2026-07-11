/**
 * Offline proof (no API key) that the analyzer prompt actively instructs the
 * model on the Eje-A coverage rules:
 *   1. Configuration controls (color pickers, theme/language, toggles) are
 *      REAL actions, not skipped as "UI plumbing" (the orb-color case).
 *   2. showcaseRoute — where each action's effect is visible (escort UX).
 *   3. The screen block — URL-driven vs state-driven screens (screen truth).
 * Usage: node test/analyzer.coverage.test.js
 */
'use strict';

const assert = require('assert');
const { buildSystemPrompt, manifestSchemaDoc } = require('../src/aiAnalyze');

function assertHas(haystack, needle, label) {
  assert.ok(haystack.includes(needle), `missing: ${label}`);
}

// 1. Configuration controls are actions (every code platform).
for (const platform of ['web', 'mobile', 'flutter', 'ios', 'android']) {
  const prompt = buildSystemPrompt(platform);
  assertHas(prompt, 'CONFIGURATION CONTROLS ARE ACTIONS', `${platform}: config-controls rule`);
  assertHas(prompt, 'color picker', `${platform}: names the color-picker case`);
  assertHas(prompt, 'COMMITS the value', `${platform}: commit-vs-plumbing rule of thumb`);
  assertHas(prompt, 'UI plumbing AROUND', `${platform}: plumbing is scoped, not a blanket skip`);
  console.log(`PASS ${platform} prompt treats configuration controls as actions`);
}

// 2. showcaseRoute is documented in the schema and the manual section.
const schema = manifestSchemaDoc();
assertHas(schema, 'showcaseRoute', 'schema documents showcaseRoute');
assertHas(schema, 'EFFECT is VISIBLE', 'schema explains what showcaseRoute points at');
const web = buildSystemPrompt('web');
assertHas(web, 'showcaseRoute', 'manual section covers showcaseRoute');
assertHas(web, 'a wrong screen is worse than none', 'precision-over-coverage rule');
console.log('PASS showcaseRoute is in the schema and manual instructions');

// 3. Screen truth: the JS web/mobile prompts request the screen block.
for (const platform of ['web', 'mobile']) {
  const prompt = buildSystemPrompt(platform);
  assertHas(prompt, 'SCREEN TRUTH', `${platform}: screen-truth section`);
  assertHas(prompt, '"kind": "state"', `${platform}: state-driven screens branch`);
  assertHas(prompt, 'screenInvoke', `${platform}: asks for the state expression`);
  assertHas(prompt, '"kind": "url"', `${platform}: url-driven fast path`);
  console.log(`PASS ${platform} prompt requests the screen block`);
}

// 4. Audience map (Eje B): who sees each screen/action + session capabilities.
assertHas(schema, '"audience": "public" | "authenticated"', 'schema documents audience');
assertHas(schema, 'requiredCapabilities', 'schema documents requiredCapabilities');
for (const platform of ['web', 'mobile']) {
  const prompt = buildSystemPrompt(platform);
  assertHas(prompt, 'AUDIENCE MAP', `${platform}: audience-map section`);
  assertHas(prompt, 'VISIBILITY', `${platform}: audience is visibility, not the execution lock`);
  assertHas(prompt, 'requiredCapabilities', `${platform}: fine-grained capabilities rule`);
  assertHas(prompt, 'has_payment_method', `${platform}: names the saved-card example`);
  assertHas(prompt, '"capabilities"', `${platform}: session block exposes live capability flags`);
  assertHas(prompt, 'Booleans only', `${platform}: capabilities carry no user data`);
  console.log(`PASS ${platform} prompt requests the audience map`);
}

console.log('ALL analyzer.coverage tests passed');
