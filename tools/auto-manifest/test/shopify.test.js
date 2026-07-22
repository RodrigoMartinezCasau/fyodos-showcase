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

  // The snippet's Liquid stays balanced (every tag opened is closed; every
  // {% elsif %} lives inside the one if/endif pair).
  const snippet = buildShopifySnippet(opts);
  const opens = (snippet.match(/\{%\s*(if|capture)/g) || []).length;
  const closes = (snippet.match(/\{%\s*end(if|capture)/g) || []).length;
  assert.strictEqual(opens, closes, 'balanced Liquid tags in the snippet');
  const fors = (snippet.match(/\{%\s*for\s/g) || []).length;
  const endfors = (snippet.match(/\{%\s*endfor/g) || []).length;
  assert.strictEqual(fors, endfors, 'balanced for/endfor in the snippet');

  // SCREEN CONTEXT ON EVERY ACTING PAGE TYPE: product, collection, search and
  // cart must each publish window.__fyodosScreen with the visible items and
  // their variantIds. With product-only context the agent was blind on
  // collection pages: "add it to the cart" next to a visible product became a
  // doomed text search ("no encontré productos…").
  for (const kind of ['product', 'collection', 'search', 'cart']) {
    assert.ok(
      snippet.includes(`kind: '${kind}'`),
      `screen context published on ${kind} pages`,
    );
  }
  assert.ok(
    snippet.includes('collection.products limit:'),
    'collection context lists the visible products',
  );
  assert.ok(
    snippet.includes('fyodosCollectViewportProducts'),
    'viewport scrape publishes products the customer is looking at',
  );
  assert.ok(
    snippet.includes('__fyodosRefreshScreen'),
    'screen context refreshes before each agent turn',
  );
  assert.ok(
    snippet.includes('__fyodosVariantMap'),
    'Liquid handle→variant map for collection cards without cart forms',
  );
  assert.ok(
    /collection[\s\S]*variantId \{\{ fyodos_p\.selected_or_first_available_variant\.id \}\}/.test(snippet),
    'collection items carry their add-to-cart variantId',
  );
  assert.ok(
    snippet.includes('search.results limit:'),
    'search context lists the visible results',
  );
  assert.ok(
    snippet.includes('cart.items'),
    'cart context lists the cart lines',
  );
  assert.ok(
    snippet.includes("base.kind === 'cart'"),
    'cart page keeps Liquid cart context (viewport scrape must not replace it)',
  );
  assert.ok(
    snippet.includes('Never use add_to_cart for remove/quantity changes'),
    'cart screen text steers remove/qty to update_cart_item',
  );

  fs.rmSync(root, { recursive: true, force: true });
  console.log('PASS wireShopifyTheme idempotent injection');
}

// ── 6. layout/password.liquid is wired too (Shopify renders it INSTEAD of
//      theme.liquid while the store is password-protected — dev/trial stores
//      default to this, and it's exactly the "installed correctly but the orb
//      never shows up" report) ─────────────────────────────────────────────
{
  const root = makeThemeFixture();
  const opts = { apiKey: 'fyo_test_key', apiUrl: 'https://api.fyodos.com' };
  const passwordAbs = path.join(root, 'layout', 'password.liquid');
  fs.writeFileSync(passwordAbs, '<!doctype html>\n<html>\n<body>\n{{ content_for_layout }}\n</body>\n</html>\n');

  const first = wireShopifyTheme(root, opts);
  assert.strictEqual(first.status, 'added', 'theme.liquid still wired');
  assert.ok(first.password, 'password layout result present when the file exists');
  assert.strictEqual(first.password.status, 'added', 'password.liquid wired too');
  const pwSource = fs.readFileSync(passwordAbs, 'utf8');
  assert.ok(pwSource.includes('FYODOS:ORB:START'), 'markers present in password.liquid');
  assert.ok(pwSource.includes('fyo_test_key'), 'api key present in password.liquid snippet');

  const second = wireShopifyTheme(root, opts);
  assert.strictEqual(second.password.status, 'already', 'unchanged password.liquid re-run is a no-op');
  assert.strictEqual(
    (fs.readFileSync(passwordAbs, 'utf8').match(/FYODOS:ORB:START/g) || []).length,
    1, 'no duplicate injection in password.liquid',
  );

  fs.rmSync(root, { recursive: true, force: true });
  console.log('PASS wireShopifyTheme also wires layout/password.liquid when present');
}

// ── 7. Agent-to-agent discovery tag: baked in when the project's MCP connector
//      is known at wire time (external channel enabled); absent otherwise
//      (closed by default) ─────────────────────────────────────────────────
{
  const root = makeThemeFixture();
  const base = { apiKey: 'fyo_test_key', apiUrl: 'https://api.fyodos.com' };

  // Without a connector URL (channel disabled / lookup failed): no tag.
  wireShopifyTheme(root, base);
  let source = fs.readFileSync(path.join(root, 'layout/theme.liquid'), 'utf8');
  assert.ok(!source.includes('rel="mcp-server"'), 'no discovery tag when the channel is off');

  // With a connector URL: the tag is advertised inside the orb block, and a
  // re-run refreshes the block in place (idempotent markers).
  const withMcp = { ...base, mcpConnectorUrl: 'https://api.fyodos.com/mcp/app-123' };
  const result = wireShopifyTheme(root, withMcp);
  assert.strictEqual(result.status, 'added', 'snippet refreshed with the discovery tag');
  source = fs.readFileSync(path.join(root, 'layout/theme.liquid'), 'utf8');
  assert.ok(
    source.includes('<link rel="mcp-server" href="https://api.fyodos.com/mcp/app-123" data-fyodos-mcp>'),
    'discovery link advertised in the theme layout',
  );
  assert.strictEqual((source.match(/rel="mcp-server"/g) || []).length, 1, 'exactly one discovery tag');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('PASS shopify snippet advertises the MCP connector when enabled');
}

// ── 7. Themes without a password.liquid (older/simpler themes) are unaffected
{
  const root = makeThemeFixture(); // no password.liquid in this fixture
  const result = wireShopifyTheme(root, { apiKey: 'k', apiUrl: 'https://api.fyodos.com' });
  assert.strictEqual(result.status, 'added', 'theme.liquid still wired');
  assert.strictEqual(result.password, null, 'no password result when the theme has no password.liquid');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('PASS themes without password.liquid are unaffected (no failure)');
}

console.log('ALL shopify tests passed');
