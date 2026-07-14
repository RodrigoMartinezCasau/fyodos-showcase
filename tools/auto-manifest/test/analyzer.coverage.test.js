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
  // Draft/workspace setters (patchOrbTheme-style) are commits too: the exact
  // gap seen in production — color pickers writing to a publish-later draft
  // were skipped, so "pon el borde del orbe verde" had no action to run.
  assertHas(prompt, 'DRAFT SETTERS COUNT', `${platform}: draft-setter commits rule`);
  assertHas(prompt, 'NOT one per preset swatch', `${platform}: one action per setting`);
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
  // Full-screen overlays (onboarding/install wizards, first-run panels) are
  // screens the URL never sees — the exact blindness observed in production
  // (orb kept reporting the section UNDER the install wizard).
  assertHas(prompt, 'FULL-SCREEN OVERLAYS COUNT AS SCREENS', `${platform}: overlay rule present`);
  assertHas(prompt, 'onboarding wizard', `${platform}: names the onboarding case`);
  assertHas(prompt, "showOnboarding ? 'onboarding' : section", `${platform}: conditional screenInvoke example`);
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

// 5. Shopify (closed platform): the prompt swaps code wiring for the
// declarative execution contract and demands per-store personalization.
{
  const prompt = buildSystemPrompt('shopify');
  assertHas(prompt, 'Shopify STOREFRONT', 'shopify: storefront identity');
  assertHas(prompt, '_fyodos/storefront/', 'shopify: snapshot files as input');
  assertHas(prompt, 'STORE LANGUAGE & PERSONALIZATION', 'shopify: personalization is the point');
  assertHas(prompt, 'shopifyAddToCart', 'shopify: universal commerce handler names');
  assertHas(prompt, '{baseUrl}/cart/add.js', 'shopify: exact Ajax Cart execution template');
  assertHas(prompt, '"/checkout"', 'shopify: universal checkout link');
  assertHas(prompt, 'Do NOT return "wiring", "session" or "screen" blocks', 'shopify: no code-wiring contract');
  assert.ok(!prompt.includes('WIRING (how to actually RUN'), 'shopify: wiring guide absent');
  assert.ok(!prompt.includes('SCREEN TRUTH'), 'shopify: screen-truth section absent');
  const schemaWithExecution = manifestSchemaDoc(true);
  assertHas(schemaWithExecution, 'Additional action field for CLOSED platforms', 'schema documents execution when asked');
  assert.ok(!manifestSchemaDoc().includes('Additional action field'), 'execution stays out of the default schema');
  console.log('PASS shopify prompt uses the closed-platform execution contract');
}

console.log('ALL analyzer.coverage tests passed');
