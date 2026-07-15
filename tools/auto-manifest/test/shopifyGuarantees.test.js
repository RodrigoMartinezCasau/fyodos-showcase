/**
 * Shopify platform guarantee (CLI side): the five universal commerce actions
 * always leave the analysis with their canonical `execution` templates, no
 * matter what the AI returned — a manifest without them is silently inert
 * (the embed builds zero handlers and the orb promises actions it cannot run).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { enforceShopifyGuaranteedExecutions } = require('../src/shopifyTheme');
const { verifyManifest } = require('../src/verify');

function executionlessManifest() {
  return {
    appId: 'store',
    appName: 'Store',
    routes: [],
    actions: [
      {
        intent: 'add_to_cart',
        label: 'Añadir al carrito',
        kind: 'function',
        handler: 'shopifyAddToCart',
        description: 'Añade una variante al carrito.',
        parameters: {
          variantId: { type: 'number', required: true, description: 'ID de la VARIANTE' },
          quantity: { type: 'number', required: true },
        },
        examples: ['añade esto al carrito'],
      },
      {
        intent: 'update_cart_item',
        label: 'Cambiar cantidad',
        kind: 'function',
        handler: 'shopifyUpdateCartItem',
        parameters: {
          line: { type: 'number', required: true },
          quantity: { type: 'number', required: true },
        },
        examples: ['quita una unidad'],
      },
      { intent: 'go_checkout', label: 'Pagar', kind: 'link', navTarget: '/checkout', examples: ['pagar'] },
    ],
  };
}

test('enforce injects canonical executions and preserves prose', () => {
  const manifest = executionlessManifest();
  const repaired = enforceShopifyGuaranteedExecutions(manifest);
  assert.deepStrictEqual(repaired.sort(), ['add_to_cart', 'update_cart_item']);

  const add = manifest.actions.find((a) => a.intent === 'add_to_cart');
  assert.deepStrictEqual(add.execution, {
    kind: 'http',
    method: 'POST',
    url: '{baseUrl}/cart/add.js',
    headers: { 'Content-Type': 'application/json' },
    body: { id: '{variantId}', quantity: '{quantity}' },
  });
  assert.strictEqual(add.label, 'Añadir al carrito');
  assert.strictEqual(add.parameters.variantId.description, 'ID de la VARIANTE');

  // Old line-based contract migrates to the variantId contract the screen
  // context actually feeds the agent.
  const upd = manifest.actions.find((a) => a.intent === 'update_cart_item');
  assert.deepStrictEqual(Object.keys(upd.parameters).sort(), ['quantity', 'variantId']);
  assert.deepStrictEqual(upd.execution.body, { id: '{variantId}', quantity: '{quantity}' });

  // Link actions and repeated runs: untouched / idempotent.
  const checkout = manifest.actions.find((a) => a.intent === 'go_checkout');
  assert.strictEqual(checkout.execution, undefined);
  assert.deepStrictEqual(enforceShopifyGuaranteedExecutions(manifest), []);
});

test('enforce never rewrites a foreign handler with the same intent', () => {
  const manifest = {
    actions: [
      { intent: 'add_to_cart', kind: 'function', handler: 'myOwnAddToCart', parameters: {} },
    ],
  };
  assert.deepStrictEqual(enforceShopifyGuaranteedExecutions(manifest), []);
  assert.strictEqual(manifest.actions[0].execution, undefined);
});

test('verify drops shopify function actions without an execution block', () => {
  // Simulates the production hole: an execution-less commerce action whose
  // handler name appears in the synthetic storefront.json used as evidence —
  // it must be DROPPED, never verified through the identifier match.
  const manifest = {
    appId: 's', appName: 'S',
    routes: [],
    actions: [
      {
        intent: 'mystery_action',
        label: 'Mystery',
        kind: 'function',
        handler: 'shopifyMystery',
        examples: ['do it'],
      },
    ],
  };
  const evidence = {
    actions: {
      mystery_action: { file: '_fyodos/storefront/storefront.json', symbol: 'shopify_storefront' },
    },
  };
  const included = [
    { rel: '_fyodos/storefront/storefront.json', content: '{"handler":"shopifyMystery"}' },
  ];
  const { manifest: out, provenance } = verifyManifest(manifest, evidence, included, [], {
    verifyRoutes: false,
    platform: 'shopify',
  });
  assert.strictEqual(out.actions.length, 0);
  const entry = provenance.actions.find((a) => a.intent === 'mystery_action');
  assert.strictEqual(entry.included, false);
  assert.match(entry.reason, /without a declarative execution block/);
});
