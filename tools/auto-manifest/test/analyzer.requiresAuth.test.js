/**
 * Offline proof (no API key) that the analyzer ACTIVELY instructs the model to
 * mark requiresAuth on private ("inside the app") actions, while leaving public
 * actions untouched, and fail-safe when genuinely unsure. We assert the built
 * prompt + schema text the model receives — the mechanism behind deliverable #1.
 * Usage: node test/analyzer.requiresAuth.test.js
 */
'use strict';

const assert = require('assert');
const { buildSystemPrompt, manifestSchemaDoc } = require('../src/aiAnalyze');

function assertHas(haystack, needle, label) {
  assert.ok(haystack.includes(needle), `missing: ${label}`);
}

// 1. The schema doc points the model at the requiresAuth rule.
const schema = manifestSchemaDoc();
assertHas(schema, 'requiresAuth', 'schema mentions requiresAuth');
assertHas(schema, 'signed-in user', 'schema explains requiresAuth meaning');
console.log('PASS schema documents requiresAuth');

// 2. Every code platform that produces a manifest gets the REQUIRES-AUTH rule.
for (const platform of ['web', 'mobile', 'flutter', 'ios', 'android']) {
  const prompt = buildSystemPrompt(platform);
  assertHas(prompt, 'REQUIRES-AUTH', `${platform}: has the REQUIRES-AUTH section`);
  assertHas(prompt, 'requiresAuth: true', `${platform}: tells the model to set requiresAuth: true`);
  // Private = inside-the-app / personal session.
  assertHas(prompt, 'signed-in user', `${platform}: defines private actions`);
  // Public actions must NOT be over-marked.
  assertHas(prompt, 'public', `${platform}: warns against over-marking public actions`);
  // Fail-safe tie-breaker when unsure.
  assertHas(prompt, 'prefer requiresAuth: true', `${platform}: fail-safe on genuine doubt`);
  // Global auth gate signal is used as a default for inside-app actions.
  assertHas(prompt, 'global auth gate', `${platform}: uses global auth gate signal`);
  console.log(`PASS ${platform} prompt instructs requiresAuth (private yes, public no, fail-safe)`);
}

// 3. The web prompt explicitly treats landing LINK actions as public (not gated).
const web = buildSystemPrompt('web');
assertHas(web, 'LINK actions', 'web: link actions called out as public');
console.log('PASS web treats public link actions as non-auth');

console.log('ALL analyzer.requiresAuth tests passed');
