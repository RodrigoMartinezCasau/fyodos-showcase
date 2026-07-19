/**
 * Shopify theme support — the closed-platform branch of the analyze pipeline.
 *
 * A Shopify store's "codebase" is its Liquid theme (GitHub-synced via
 * Shopify's native integration), and its live catalog is PUBLIC JSON
 * (/collections.json, /products.json). This module:
 *
 *   1. detects a theme repo (layout/theme.liquid + templates/),
 *   2. fetches a public storefront snapshot and exposes it as synthetic FILE
 *      blocks (_fyodos/storefront/*.json) so the analyzer can personalize
 *      routes/bubbles/examples to the REAL catalog — and so evidence
 *      verification has concrete files to point at,
 *   3. injects the embed snippet into layout/theme.liquid (idempotent
 *      FYODOS:ORB markers, same pattern as every other wire step), including
 *      a Liquid-rendered screen context so the agent knows the visible
 *      product's variant id (what add_to_cart needs).
 *
 * No wiring/session/screen blocks apply here: commerce actions carry
 * declarative `execution` templates resolved by buildApiActionRegistries in
 * the embed at runtime ({baseUrl} → the store's own origin).
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** CDN URL of the self-contained embed bundle (global `Fiodos`). Keep in sync
 *  with dashboard/src/lib/shopifyInstall.ts. */
const FIODOS_EMBED_CDN_URL =
  'https://unpkg.com/@fiodos/web-core@latest/dist/embed/fiodos-embed.js';

const ORB_START = '<!-- FYODOS:ORB:START (Fiodos agent — safe to remove) -->';
const ORB_END = '<!-- FYODOS:ORB:END -->';

/** Repo-relative folder of the synthetic storefront snapshot files. */
const SNAPSHOT_DIR = '_fyodos/storefront';

/**
 * Canonical mechanics of the five guaranteed Shopify commerce actions.
 *
 * These execution templates are PLATFORM CONSTANTS (identical on every
 * Shopify store), yet the analysis prompt asks the AI to reproduce them
 * verbatim — and models sometimes omit or mangle the `execution` block. A
 * manifest published without it is silently dead: the embed registers zero
 * handlers and the orb promises cart actions it can never run (observed in
 * production). `enforceShopifyGuaranteedExecutions` overwrites the MECHANICS
 * (execution/parameters) of any action matching intent+handler while leaving
 * the AI's personalized prose (labels, descriptions, examples) untouched.
 * The backend applies the same guarantee at publish/serve time
 * (backend/clients/shopify_guarantees.py) — keep both in sync.
 */
const SHOPIFY_GUARANTEED_ACTIONS = {
  search_products: {
    handler: 'shopifySearchProducts',
    parameters: { query: { type: 'string', required: true } },
    execution: {
      kind: 'http',
      method: 'GET',
      url: '{baseUrl}/search/suggest.json?q={query}&resources[type]=product&resources[limit]=8',
    },
  },
  get_product_details: {
    handler: 'shopifyGetProductDetails',
    parameters: { handle: { type: 'string', required: true } },
    execution: { kind: 'http', method: 'GET', url: '{baseUrl}/products/{handle}.js' },
  },
  add_to_cart: {
    handler: 'shopifyAddToCart',
    parameters: {
      variantId: { type: 'number', required: true },
      quantity: { type: 'number', required: true },
    },
    execution: {
      kind: 'http',
      method: 'POST',
      url: '{baseUrl}/cart/add.js',
      headers: { 'Content-Type': 'application/json' },
      body: { id: '{variantId}', quantity: '{quantity}' },
    },
  },
  get_cart: {
    handler: 'shopifyGetCart',
    parameters: {},
    execution: { kind: 'http', method: 'GET', url: '{baseUrl}/cart.js' },
  },
  // variantId-based on purpose (cart/change.js accepts a variant id as `id`):
  // the theme snippet's cart screen context hands the agent variantIds, so
  // the action contract must accept exactly what the agent can see.
  update_cart_item: {
    handler: 'shopifyUpdateCartItem',
    parameters: {
      variantId: { type: 'number', required: true },
      quantity: { type: 'number', required: true },
    },
    execution: {
      kind: 'http',
      method: 'POST',
      url: '{baseUrl}/cart/change.js',
      headers: { 'Content-Type': 'application/json' },
      body: { id: '{variantId}', quantity: '{quantity}' },
    },
  },
};

/**
 * Enforce the canonical execution/parameters on every guaranteed commerce
 * action of a Shopify manifest, in place. Prose fields are never touched;
 * per-parameter descriptions written by the AI survive when the parameter
 * survives. Returns the intents that were repaired (for logging).
 */
function enforceShopifyGuaranteedExecutions(manifest) {
  const repaired = [];
  if (!manifest || !Array.isArray(manifest.actions)) return repaired;
  for (const action of manifest.actions) {
    if (!action || typeof action !== 'object' || action.kind === 'link') continue;
    const spec = SHOPIFY_GUARANTEED_ACTIONS[String(action.intent || '').trim()];
    if (!spec || String(action.handler || '').trim() !== spec.handler) continue;

    const params = {};
    const prior = (action.parameters && typeof action.parameters === 'object') ? action.parameters : {};
    for (const [name, shape] of Object.entries(spec.parameters)) {
      params[name] = { ...shape };
      const priorShape = prior[name];
      if (priorShape && typeof priorShape.description === 'string') {
        params[name].description = priorShape.description;
      }
    }

    const already =
      JSON.stringify(action.execution || null) === JSON.stringify(spec.execution) &&
      JSON.stringify(Object.keys(prior).sort()) === JSON.stringify(Object.keys(spec.parameters).sort());
    if (already) continue;

    action.execution = JSON.parse(JSON.stringify(spec.execution));
    action.parameters = params;
    repaired.push(action.intent);
  }
  return repaired;
}

/** A Shopify theme repo is unmistakable: layout/theme.liquid is the layout
 *  every Online Store 2.0 theme must have, plus templates/ or sections/. */
function isShopifyThemeRoot(appRoot) {
  const has = (rel) => {
    try {
      return fs.existsSync(path.join(appRoot, rel));
    } catch {
      return false;
    }
  };
  return (
    has('layout/theme.liquid') &&
    (has('templates') || has('sections') || has('config/settings_schema.json'))
  );
}

/** Store name from the theme's settings_schema.json (theme_info), best-effort. */
function readThemeMeta(appRoot) {
  const meta = {};
  try {
    const raw = fs.readFileSync(path.join(appRoot, 'config', 'settings_schema.json'), 'utf8');
    const schema = JSON.parse(raw);
    const info = Array.isArray(schema)
      ? schema.find((s) => s && (s.name === 'theme_info' || s.theme_name))
      : null;
    if (info && info.theme_name) meta.themeName = String(info.theme_name);
  } catch {
    /* not required */
  }
  return meta;
}

function normalizeStoreDomain(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

async function fetchJson(url, { timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The universal storefront surface, written into the snapshot so evidence
 *  ("_fyodos/storefront/storefront.json", symbol "shopify_storefront") is
 *  backed by a real file among the ones sent to the model. */
function universalSurfaceDoc(storeDomain) {
  return {
    shopify_storefront: true,
    store: storeDomain || '(unknown — no --store domain provided)',
    universalRoutes: ['/', '/collections/all', '/search', '/cart'],
    universalActions: [
      { intent: 'search_products', handler: 'shopifySearchProducts', api: '{baseUrl}/search/suggest.json' },
      // The search→cart bridge: suggest.json returns product ids/handles but
      // NEVER variant ids, and cart/add.js only accepts variant ids. This
      // endpoint (universal on every store) turns a handle into its variants.
      { intent: 'get_product_details', handler: 'shopifyGetProductDetails', api: '{baseUrl}/products/{handle}.js' },
      { intent: 'add_to_cart', handler: 'shopifyAddToCart', api: '{baseUrl}/cart/add.js' },
      { intent: 'get_cart', handler: 'shopifyGetCart', api: '{baseUrl}/cart.js' },
      { intent: 'update_cart_item', handler: 'shopifyUpdateCartItem', api: '{baseUrl}/cart/change.js' },
      { intent: 'go_checkout', kind: 'link', navTarget: '/checkout' },
    ],
    note:
      'Universal Shopify storefront surface — present on every Shopify store ' +
      'regardless of theme. Ajax Cart API + Predictive Search, anonymous access.',
  };
}

/**
 * Fetch the public storefront snapshot for a store and return it as synthetic
 * collection entries ({ rel, content, tier, chars }) ready to append to the
 * collector's `included` list.
 *
 * Fail-open: any fetch error still yields storefront.json (the universal
 * surface), so the analysis and its evidence contract always work — the
 * manifest just loses catalog personalization when the store is unreachable.
 */
async function fetchStorefrontSnapshot(storeRaw, { log = () => {} } = {}) {
  const store = normalizeStoreDomain(storeRaw);
  const files = [];
  const pushFile = (name, data) => {
    const content = JSON.stringify(data, null, 2);
    files.push({ rel: `${SNAPSHOT_DIR}/${name}`, content, tier: 0, chars: content.length });
  };

  const warnings = [];
  let collections = [];
  let products = [];
  if (store) {
    const base = `https://${store}`;
    try {
      const data = await fetchJson(`${base}/collections.json?limit=250`);
      collections = (data.collections || []).map((c) => ({
        handle: c.handle,
        title: c.title,
        description: stripHtml(c.body_html).slice(0, 200),
        productsCount: c.products_count,
        updatedAt: c.updated_at,
      }));
    } catch (e) {
      warnings.push(`collections.json: ${e.message}`);
    }
    try {
      const data = await fetchJson(`${base}/products.json?limit=50`);
      products = (data.products || []).map((p) => ({
        handle: p.handle,
        title: p.title,
        productType: p.product_type,
        vendor: p.vendor,
        tags: p.tags,
        description: stripHtml(p.body_html).slice(0, 200),
        priceRange: (() => {
          const prices = (p.variants || []).map((v) => Number(v.price)).filter((n) => !Number.isNaN(n));
          if (!prices.length) return undefined;
          return { min: Math.min(...prices), max: Math.max(...prices) };
        })(),
        variantSample: (p.variants || []).slice(0, 3).map((v) => ({ id: v.id, title: v.title, price: v.price })),
      }));
    } catch (e) {
      warnings.push(`products.json: ${e.message}`);
    }
  } else {
    warnings.push('no store domain provided (--store) — catalog personalization limited to theme files');
  }

  pushFile('storefront.json', {
    ...universalSurfaceDoc(store),
    fetchedAt: new Date().toISOString(),
    collectionsCount: collections.length,
    productSampleCount: products.length,
    ...(warnings.length ? { warnings } : {}),
  });
  if (collections.length) pushFile('collections.json', { collections });
  if (products.length) pushFile('products.json', { products });

  for (const w of warnings) log(`[shopify] snapshot warning: ${w}`);
  log(
    `[shopify] storefront snapshot: ${collections.length} collections, ` +
    `${products.length} product sample${store ? ` (${store})` : ''}`,
  );
  return { files, store, collections, products, warnings };
}

/**
 * The Liquid-rendered SCREEN CONTEXT lines shared by the CLI and dashboard
 * snippets. One branch per storefront template the agent can act on, each
 * exposing the visible items WITH their add-to-cart variantIds.
 *
 * Why every branch matters: with product-only context (the original version)
 * the agent was BLIND on collection/search/cart pages — "add it to the cart"
 * said next to a perfectly visible product degenerated into a text search
 * with the user's phrasing, zero results, and an apology. The agent must be
 * able to act on whatever the customer is LOOKING AT, on every page type.
 */
function shopifyScreenContextLiquidLines() {
  return [
    "  {% if template contains 'product' and product %}",
    '  {% capture fyodos_screen_text %}The customer is viewing the product page of: {{ product.title }} (price {{ product.price | money | strip_html }}). Add-to-cart variantId: {{ product.selected_or_first_available_variant.id }}.{% endcapture %}',
    "  window.__fyodosScreen = { kind: 'product', text: {{ fyodos_screen_text | json }} };",
    "  {% elsif template contains 'collection' and collection %}",
    '  {% capture fyodos_screen_text %}The customer is browsing the collection "{{ collection.title }}". Products visible on screen (title — price — add-to-cart variantId): {% for fyodos_p in collection.products limit: 16 %}{{ fyodos_p.title }} — {{ fyodos_p.price | money | strip_html }} — variantId {{ fyodos_p.selected_or_first_available_variant.id }}; {% endfor %}To add one to the cart, call add_to_cart with its variantId from this list.{% endcapture %}',
    "  window.__fyodosScreen = { kind: 'collection', text: {{ fyodos_screen_text | json }} };",
    "  {% elsif template contains 'search' and search.performed %}",
    '  {% capture fyodos_screen_text %}The customer is viewing search results for "{{ search.terms }}". Products visible on screen (title — price — add-to-cart variantId): {% for fyodos_r in search.results limit: 12 %}{% if fyodos_r.object_type == \'product\' %}{{ fyodos_r.title }} — {{ fyodos_r.price | money | strip_html }} — variantId {{ fyodos_r.selected_or_first_available_variant.id }}; {% endif %}{% endfor %}To add one to the cart, call add_to_cart with its variantId from this list.{% endcapture %}',
    "  window.__fyodosScreen = { kind: 'search', text: {{ fyodos_screen_text | json }} };",
    "  {% elsif template contains 'cart' %}",
    '  {% capture fyodos_screen_text %}The customer is viewing their cart: {{ cart.item_count }} item(s), total {{ cart.total_price | money | strip_html }}. Lines (title × quantity — variantId): {% for fyodos_i in cart.items %}{{ fyodos_i.product.title }} × {{ fyodos_i.quantity }} — variantId {{ fyodos_i.variant_id }}; {% endfor %}Use update_cart_item with a variantId from this list to change quantities.{% endcapture %}',
    "  window.__fyodosScreen = { kind: 'cart', text: {{ fyodos_screen_text | json }} };",
    '  {% endif %}',
  ];
}

/**
 * The theme.liquid block: loads the embed, fetches the published manifest and
 * mounts the orb with API-wired registries. Mirrors the dashboard's
 * buildShopifySnippet, plus a Liquid-rendered screen context (product,
 * collection, search and cart pages) so the agent knows the visible items and
 * their variant ids (what add_to_cart / update_cart_item need by voice).
 */
function buildShopifySnippet({ apiKey, apiUrl, mcpConnectorUrl = '' }) {
  const key = apiKey || '<your-api-key>';
  const url = String(apiUrl || '').replace(/\/$/, '');
  // Agent-to-agent discovery (static): when the project's external channel is
  // enabled at wire time, advertise the MCP connector in the raw HTML so even
  // non-JS crawlers/agents find it. The SDK also injects/removes the same tag
  // at runtime following the dashboard toggle, so a later enable still works.
  const discovery = String(mcpConnectorUrl || '').trim();
  return [
    ORB_START,
    ...(discovery
      ? [`<link rel="mcp-server" href="${discovery}" data-fyodos-mcp>`]
      : []),
    `<script src="${FIODOS_EMBED_CDN_URL}" defer></script>`,
    '<script>',
    ...shopifyScreenContextLiquidLines(),
    "  window.addEventListener('DOMContentLoaded', function () {",
    `    var FYODOS_API_KEY = '${key}';`,
    `    var FYODOS_API_URL = '${url}';`,
    "    fetch(FYODOS_API_URL + '/v1/client/manifest', { headers: { 'x-api-key': FYODOS_API_KEY } })",
    '      .then(function (r) { return r.json(); })',
    '      .then(function (data) {',
    '        if (!data || !data.manifest || !window.Fiodos) return;',
    '        var agent = Fiodos.createFiodosAgent({',
    '          baseUrl: FYODOS_API_URL,',
    '          apiKey: FYODOS_API_KEY,',
    '          manifest: data.manifest,',
    '          registries: Fiodos.buildApiActionRegistries(data.manifest, {',
    '            baseUrl: window.location.origin,',
    '          }),',
    "          localeDetection: 'document',",
    '        });',
    '        if (window.__fyodosScreen) agent.setScreenContext(window.__fyodosScreen);',
    '      });',
    '  });',
    '</script>',
    ORB_END,
  ].join('\n');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Inject (or refresh) the snippet into ONE liquid layout file, right before
 * </body>. Idempotent via the FYODOS:ORB markers: an existing block is
 * replaced in place, so re-running the CLI updates the snippet instead of
 * duplicating it. Returns { status: 'added'|'already'|'skipped'|'failed'|
 * 'not-found', file, reason?, refreshed? }.
 */
function injectSnippetInLayout(file, relFile, snippet, { noWire = false } = {}) {
  if (!fs.existsSync(file)) {
    return { status: 'not-found', file: relFile };
  }
  const source = fs.readFileSync(file, 'utf8');

  const markerRe = new RegExp(`${escapeRe(ORB_START)}[\\s\\S]*?${escapeRe(ORB_END)}`);
  if (markerRe.test(source)) {
    const existing = source.match(markerRe)[0];
    if (existing === snippet) return { status: 'already', file: relFile };
    if (noWire) return { status: 'skipped', file: relFile, reason: '--no-wire' };
    fs.writeFileSync(file, source.replace(markerRe, snippet));
    return { status: 'added', file: relFile, refreshed: true };
  }

  if (noWire) return { status: 'skipped', file: relFile, reason: '--no-wire' };
  const bodyClose = source.lastIndexOf('</body>');
  const next = bodyClose === -1
    ? `${source}\n${snippet}\n`
    : `${source.slice(0, bodyClose)}${snippet}\n  ${source.slice(bodyClose)}`;
  fs.writeFileSync(file, next);
  return { status: 'added', file: relFile };
}

/**
 * Wire the theme's layout(s). layout/theme.liquid is the one every storefront
 * page uses and is REQUIRED. layout/password.liquid — when the theme ships
 * one (Dawn, Horizon and most modern themes do) — is a SEPARATE layout Shopify
 * renders INSTEAD of theme.liquid on every page while the store has password
 * protection active (the default on every new/trial store, and very common on
 * dev stores used to test an install). Without wiring it too, the orb is
 * correctly embedded and published yet invisible to anyone hitting the
 * password gate — "installed correctly but nothing shows up". Best-effort:
 * its absence is normal (older/simpler themes have none) and never fails the
 * install.
 *
 * Returns { status, file, reason?, refreshed?, password: {status, file,...} }
 * — `password` mirrors the same shape for layout/password.liquid, or null
 * when that file does not exist in this theme.
 */
function wireShopifyTheme(appRoot, { apiKey, apiUrl, noWire = false, mcpConnectorUrl = '' } = {}) {
  const snippet = buildShopifySnippet({ apiKey, apiUrl, mcpConnectorUrl });

  const themeRelFile = path.join('layout', 'theme.liquid');
  const themeFile = path.join(appRoot, themeRelFile);
  if (!fs.existsSync(themeFile)) {
    return { status: 'failed', file: themeRelFile, reason: 'layout/theme.liquid not found', password: null };
  }
  const themeResult = injectSnippetInLayout(themeFile, themeRelFile, snippet, { noWire });

  const passwordRelFile = path.join('layout', 'password.liquid');
  const passwordFile = path.join(appRoot, passwordRelFile);
  const passwordResult = fs.existsSync(passwordFile)
    ? injectSnippetInLayout(passwordFile, passwordRelFile, snippet, { noWire })
    : null;

  return { ...themeResult, password: passwordResult };
}

/**
 * Best-effort lookup of the project's MCP connector URL for the static
 * discovery tag: GET /v1/client/config (x-api-key). Returns '' when the
 * external-agents channel is disabled (the backend then omits the URL —
 * closed by default) or on any failure; a missing tag never blocks a wire,
 * and the SDK still injects it at runtime once the developer enables the
 * channel.
 */
async function fetchMcpConnectorUrl({ apiKey, apiUrl }) {
  if (!apiKey || !apiUrl) return '';
  try {
    const res = await fetch(`${String(apiUrl).replace(/\/$/, '')}/v1/client/config`, {
      headers: { 'x-api-key': apiKey },
    });
    if (!res.ok) return '';
    const data = await res.json();
    return typeof data.mcpConnectorUrl === 'string' ? data.mcpConnectorUrl : '';
  } catch {
    return '';
  }
}

function reportShopifyWire(result, colors = {}, { quiet = false } = {}) {
  const { blue = '', cyan = '', reset = '' } = colors;
  const say = (line) => console.error(`${cyan}◉${reset} ${blue}Fiodos${reset} · ${line}`);
  if (result.status === 'added') {
    say(`orb embedded in ${result.file}${result.refreshed ? ' (snippet refreshed)' : ''} — commit & push to deploy via Shopify's GitHub sync`);
  } else if (result.status === 'already') {
    say(`orb already embedded in ${result.file}`);
  } else if (result.status === 'failed') {
    say(`could not embed the orb: ${result.reason}`);
  } else if (!quiet) {
    say(`orb embed skipped (${result.reason || result.status})`);
  }

  const pw = result.password;
  if (pw && (pw.status === 'added' || pw.status === 'already')) {
    say(`orb also embedded in ${pw.file} — keeps working while your store is password-protected`);
  } else if (pw && pw.status === 'failed') {
    say(`could not embed the orb in ${pw.file}: ${pw.reason} — the orb won't show while your store is password-protected`);
  }
}

module.exports = {
  enforceShopifyGuaranteedExecutions,
  isShopifyThemeRoot,
  readThemeMeta,
  fetchStorefrontSnapshot,
  shopifyScreenContextLiquidLines,
  buildShopifySnippet,
  fetchMcpConnectorUrl,
  wireShopifyTheme,
  reportShopifyWire,
  normalizeStoreDomain,
  FIODOS_EMBED_CDN_URL,
  SNAPSHOT_DIR,
};
