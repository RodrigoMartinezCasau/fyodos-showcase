/**
 * Shopify theme pipeline — offline proof (no network, no API key):
 *   1. detection: a Liquid theme repo is recognized as platform 'shopify'
 *   2. collection: the shopify profile picks .liquid/.json with theme tiering
 *   3. snapshot: fetchStorefrontSnapshot fails OPEN without a store domain
 *      (universal surface file always present, so evidence always verifies)
 *   4. verify: execution-carrying actions pass structurally; broken execution
 *      blocks and undeclared placeholders are dropped; /checkout is universal
 *   5. wire: the theme.liquid snippet injection is idempotent (markers) and
 *      refreshes in place on re-run
 * Usage: node --test test/shopify.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectFiles } = require('../src/collect');
const { verifyManifest, validateExecutionShape } = require('../src/verify');
const {
  isShopifyThemeRoot,
  fetchStorefrontSnapshot,
  buildShopifySnippet,
  wireShopifyTheme,
  normalizeStoreDomain,
  SNAPSHOT_DIR,
} = require('../src/shopifyTheme');

function makeThemeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fyodos-shopify-'));
  const write = (rel, content) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  write('layout/theme.liquid', '<!doctype html>\n<html>\n<head></head>\n<body>\n{{ content_for_layout }}\n</body>\n</html>\n');
  write('templates/index.json', '{"sections": {"hero": {"type": "hero"}}}');
  write('templates/product.liquid', '{% section "product-form" %}');
  write('sections/footer.liquid', '<a href="mailto:hola@tienda.com">Contacto</a>');
  write('snippets/price.liquid', '{{ product.price | money }}');
  write('locales/es.default.json', '{"general": {"search": "Buscar"}}');
  write('config/settings_schema.json', '[{"name": "theme_info", "theme_name": "Dawn"}]');
  write('assets/theme.css', 'body { color: red; }');
  return root;
}

// ── 1 + 2. Detection + collection profile ───────────────────────────────────
{
  const root = makeThemeFixture();
  assert.ok(isShopifyThemeRoot(root), 'theme fixture detected as shopify');
  assert.ok(!isShopifyThemeRoot(os.tmpdir()), 'plain dir is not a shopify theme');

  const { included } = collectFiles(root, { platform: 'shopify' });
  const rels = included.map((f) => f.rel.replace(/\\/g, '/')).sort();
  assert.ok(rels.includes('layout/theme.liquid'), 'collects layout');
  assert.ok(rels.includes('templates/product.liquid'), 'collects liquid templates');
  assert.ok(rels.includes('templates/index.json'), 'collects JSON templates');
  assert.ok(rels.includes('locales/es.default.json'), 'collects locales (store language)');
  assert.ok(rels.includes('sections/footer.liquid'), 'collects sections');
  assert.ok(!rels.some((r) => r.startsWith('assets/')), 'skips static assets');
  const tierOf = (rel) => included.find((f) => f.rel.replace(/\\/g, '/') === rel).tier;
  assert.ok(tierOf('layout/theme.liquid') < tierOf('sections/footer.liquid'), 'layout outranks sections');
  assert.ok(tierOf('locales/es.default.json') < tierOf('snippets/price.liquid'), 'locales outrank snippets');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('PASS shopify detection + collection profile');
}

// ── 3. Snapshot fails open without a store domain ────────────────────────────
{
  assert.strictEqual(normalizeStoreDomain('https://mi-tienda.com/path'), 'mi-tienda.com');
  fetchStorefrontSnapshot('', {}).then(({ files }) => {
    const surface = files.find((f) => f.rel === `${SNAPSHOT_DIR}/storefront.json`);
    assert.ok(surface, 'universal surface file always produced');
    const data = JSON.parse(surface.content);
    assert.ok(data.shopify_storefront, 'evidence symbol present in the snapshot file');
    assert.ok(data.universalActions.some((a) => a.handler === 'shopifyAddToCart'), 'universal actions listed');
    assert.ok(Array.isArray(data.warnings) && data.warnings.length > 0, 'missing-store warning recorded');
    console.log('PASS storefront snapshot fails open without --store');
  });
}

// ── 4. Verify: the closed-platform branch ────────────────────────────────────
{
  const snapshotFile = {
    rel: `${SNAPSHOT_DIR}/storefront.json`,
    content: JSON.stringify({ shopify_storefront: true }),
  };
  const themeFile = {
    rel: 'sections/footer.liquid',
    content: '<a href="mailto:hola@tienda.com">Contacto</a>',
  };
  const manifest = {
    appId: 'x', appName: 'X', appDescription: 'd', version: '1',
    routes: [
      { intent: 'go_home', label: 'Inicio', route: '/', examples: ['inicio'] },
    ],
    actions: [
      {
        intent: 'add_to_cart', label: 'Añadir al carrito', category: 'commerce',
        handler: 'shopifyAddToCart',
        parameters: {
          variantId: { type: 'number', required: true, description: 'variant' },
          quantity: { type: 'number', required: true, description: 'qty' },
        },
        execution: {
          kind: 'http', method: 'POST', url: '{baseUrl}/cart/add.js',
          headers: { 'Content-Type': 'application/json' },
          body: { id: '{variantId}', quantity: '{quantity}' },
        },
        examples: ['añade esto al carrito'],
      },
      {
        // Undeclared placeholder → structural drop.
        intent: 'broken_exec', label: 'Broken', category: 'commerce', handler: 'shopifyBroken',
        execution: { kind: 'http', method: 'GET', url: '{baseUrl}/search?q={query}' },
        examples: ['busca'],
      },
      {
        intent: 'go_checkout', label: 'Pagar', category: 'commerce', kind: 'link',
        navTarget: '/checkout', requireConfirmation: true,
        confirmationMessageTemplate: '¿Vamos al pago?', examples: ['quiero pagar'],
      },
      {
        // Theme link: still needs the verbatim href in the evidence file.
        intent: 'contact_email', label: 'Contacto', category: 'links', kind: 'link',
        navTarget: 'mailto:hola@tienda.com', examples: ['contacto'],
      },
      {
        // Hallucinated theme link (href not in the file) → dropped as usual.
        intent: 'fake_link', label: 'Fake', category: 'links', kind: 'link',
        navTarget: 'https://instagram.com/no-existe', examples: ['insta'],
      },
    ],
    policies: {},
  };
  const evidence = {
    routes: { go_home: { file: snapshotFile.rel, symbol: 'shopify_storefront' } },
    actions: {
      add_to_cart: { file: snapshotFile.rel, symbol: 'shopify_storefront' },
      broken_exec: { file: snapshotFile.rel, symbol: 'shopify_storefront' },
      go_checkout: { file: snapshotFile.rel, symbol: 'shopify_storefront' },
      contact_email: { file: themeFile.rel, symbol: 'mailto:hola@tienda.com' },
      fake_link: { file: themeFile.rel, symbol: 'instagram' },
    },
  };

  const { manifest: verified, provenance } = verifyManifest(
    manifest, evidence, [snapshotFile, themeFile], [], { verifyRoutes: false, platform: 'shopify' },
  );
  const kept = verified.actions.map((a) => a.intent).sort();
  assert.deepStrictEqual(kept, ['add_to_cart', 'contact_email', 'go_checkout'], `kept: ${kept}`);
  const dropped = provenance.actions.filter((a) => !a.included).map((a) => a.intent).sort();
  assert.deepStrictEqual(dropped, ['broken_exec', 'fake_link'], `dropped: ${dropped}`);
  assert.ok(
    verified.actions.find((a) => a.intent === 'add_to_cart').execution,
    'execution block survives verification',
  );
  assert.strictEqual(
    validateExecutionShape(manifest.actions[1]),
    "execution references undeclared parameter '{query}'",
    'undeclared placeholder named in the drop reason',
  );
  console.log('PASS shopify verify: execution structural check + universal checkout');
}

// ── 5. wireShopifyTheme is idempotent and refreshes in place ─────────────────
{
  const root = makeThemeFixture();
  const opts = { apiKey: 'fyo_test_key', apiUrl: 'https://api.fyodos.com' };

  const first = wireShopifyTheme(root, opts);
  assert.strictEqual(first.status, 'added', 'first run injects');
  const source = fs.readFileSync(path.join(root, 'layout/theme.liquid'), 'utf8');
  assert.ok(source.includes('FYODOS:ORB:START'), 'markers present');
  assert.ok(source.includes('fyo_test_key'), 'api key in snippet');
  assert.ok(source.includes('buildApiActionRegistries'), 'execution registries wired');
  assert.ok(source.includes('setScreenContext'), 'product screen context wired');
  assert.ok(source.indexOf('</body>') > source.indexOf('FYODOS:ORB:END'), 'injected before </body>');

  const second = wireShopifyTheme(root, opts);
  assert.strictEqual(second.status, 'already', 'unchanged re-run is a no-op');
  assert.strictEqual(
    (fs.readFileSync(path.join(root, 'layout/theme.liquid'), 'utf8').match(/FYODOS:ORB:START/g) || []).length,
    1, 'no duplicate injection',
  );

  const third = wireShopifyTheme(root, { ...opts, apiKey: 'fyo_new_key' });
  assert.strictEqual(third.status, 'added', 'changed snippet refreshes in place');
  assert.ok(third.refreshed, 'refresh flagged');
  const updated = fs.readFileSync(path.join(root, 'layout/theme.liquid'), 'utf8');
  assert.ok(updated.includes('fyo_new_key') && !updated.includes('fyo_test_key'), 'old key replaced');
  assert.strictEqual((updated.match(/FYODOS:ORB:START/g) || []).length, 1, 'still exactly one block');

  // The snippet's Liquid stays balanced (every tag opened is closed).
  const snippet = buildShopifySnippet(opts);
  const opens = (snippet.match(/\{%\s*(if|capture)/g) || []).length;
  const closes = (snippet.match(/\{%\s*end(if|capture)/g) || []).length;
  assert.strictEqual(opens, closes, 'balanced Liquid tags in the snippet');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('PASS wireShopifyTheme idempotent injection');
}

console.log('ALL shopify tests passed');
