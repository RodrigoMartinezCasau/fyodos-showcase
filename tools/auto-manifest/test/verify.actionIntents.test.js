'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyManifest } = require('../src/verify');

// Layer 2: a route's actionIntents must be kept fail-open — only intents whose
// action survived verification stay; unknown/dropped intents are removed and
// duplicates collapsed. When nothing survives, the field is deleted entirely.
test('verify keeps route.actionIntents fail-open', () => {
  const manifest = {
    appId: 'app',
    appName: 'App',
    version: '1',
    routes: [
      {
        intent: 'cart',
        route: '/cart',
        label: 'Cart',
        examples: ['open cart'],
        // 'checkout' is real, 'ghost' has no action, dup 'checkout' collapses.
        actionIntents: ['checkout', 'ghost', 'checkout'],
      },
      {
        intent: 'about',
        route: '/about',
        label: 'About',
        examples: ['about'],
        actionIntents: ['ghost_only'], // none survive → field removed
      },
    ],
    actions: [
      {
        intent: 'checkout',
        label: 'Checkout',
        category: 'order',
        handler: 'doCheckout',
        requireConfirmation: false,
        parameters: {},
        examples: ['pay'],
      },
    ],
    policies: { requireConfirmationForDestructive: true, allowedWithoutAuth: [], contextRetentionTurns: 5 },
  };
  const evidence = { routes: {}, actions: { checkout: { file: 'cart.ts', symbol: 'doCheckout' } } };
  const sentFiles = [{ rel: 'cart.ts', content: 'export function doCheckout() { return true; }' }];

  // Web mode (no static route ground truth) keeps the routes as proposed.
  const { manifest: out } = verifyManifest(manifest, evidence, sentFiles, [], { verifyRoutes: false });

  const cart = out.routes.find((r) => r.intent === 'cart');
  const about = out.routes.find((r) => r.intent === 'about');
  assert.deepEqual(cart.actionIntents, ['checkout']);
  assert.equal(about.actionIntents, undefined);
});

console.log('ALL verify.actionIntents tests passed');
