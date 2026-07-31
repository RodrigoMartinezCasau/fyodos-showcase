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
 *  with dashboard/src/lib/shopifyInstall.ts and shopify_theme_install.py. */
const FIODOS_EMBED_CDN_DEFAULT_TAG = 'latest';

function embedCdnUrl(sdkVersion) {
  const raw = String(sdkVersion || FIODOS_EMBED_CDN_DEFAULT_TAG).trim();
  const tag =
    /^(?:latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.test(raw) && !raw.includes('..')
      ? raw
      : FIODOS_EMBED_CDN_DEFAULT_TAG;
  return `https://unpkg.com/@fiodos/web-core@${tag}/dist/embed/fiodos-embed.js`;
}

const FIODOS_EMBED_CDN_URL = embedCdnUrl(FIODOS_EMBED_CDN_DEFAULT_TAG);

const ORB_START = '<!-- FYODOS:ORB:START (Fiodos agent — safe to remove) -->';
const ORB_END = '<!-- FYODOS:ORB:END -->';

/** Repo-relative folder of the synthetic storefront snapshot files. */
const SNAPSHOT_DIR = '_fyodos/storefront';

/**
 * Canonical mechanics of the guaranteed Shopify commerce actions.
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
  // variantId OR handle: models kept INVENTING variant ids when none was
  // visible (422 Cannot find variant). The handle IS in the model's evidence
  // (search results, /products/<handle> urls), so the contract accepts it and
  // the SDK resolves handle → default variant mechanically (products/….js) —
  // the same thing the theme's own Add button does.
  add_to_cart: {
    handler: 'shopifyAddToCart',
    parameters: {
      variantId: {
        type: 'number',
        required: false,
        description:
          'Exact VARIANT id, only when visible in the screen context, cart data ' +
          'or product details. Never a product id from search results, never invented.',
      },
      handle: {
        type: 'string',
        required: false,
        description:
          'Product handle copied EXACTLY from a search result or a /products/<handle> ' +
          'url. Pass it whenever no variantId is visible — the store resolves the ' +
          'default variant automatically. At least one of variantId/handle is required.',
      },
      quantity: { type: 'number', required: true },
    },
    execution: {
      kind: 'http',
      method: 'POST',
      url: '{baseUrl}/cart/add.js',
      headers: { 'Content-Type': 'application/json' },
      body: {
        id: '{variantId}',
        quantity: '{quantity}',
        sections: 'cart-drawer,template--cart',
      },
      resolve: [
        { param: 'variantId', url: '{baseUrl}/products/{handle}.js', path: 'variants.0.id' },
      ],
    },
  },
  get_cart: {
    handler: 'shopifyGetCart',
    parameters: {},
    execution: { kind: 'http', method: 'GET', url: '{baseUrl}/cart.js' },
  },
  // variantId-based: cart screen context hands the agent variantIds.
  // SDK coerces numeric id → string for /cart/change.js (JSON number 400s
  // on some storefronts; digit-string works).
  update_cart_item: {
    handler: 'shopifyUpdateCartItem',
    parameters: {
      variantId: {
        type: 'number',
        required: true,
        description:
          'Variant id of the cart line (from get_cart or cart screen context). Never invent.',
      },
      quantity: {
        type: 'number',
        required: true,
        description:
          "ABSOLUTE target quantity after the change (not a delta). 'two more' with current 1 → 3. Whole-line remove → remove_from_cart.",
      },
    },
    execution: {
      kind: 'http',
      method: 'POST',
      url: '{baseUrl}/cart/change.js',
      headers: { 'Content-Type': 'application/json' },
      body: {
        id: '{variantId}',
        quantity: '{quantity}',
        sections: 'cart-drawer,template--cart',
      },
    },
  },
  remove_from_cart: {
    handler: 'shopifyRemoveFromCart',
    parameters: {
      variantId: {
        type: 'number',
        required: true,
        description:
          'Variant id of the cart line to remove entirely (from get_cart or cart screen context). Never invent.',
      },
    },
    execution: {
      kind: 'http',
      method: 'POST',
      url: '{baseUrl}/cart/change.js',
      headers: { 'Content-Type': 'application/json' },
      body: {
        id: '{variantId}',
        quantity: 0,
        sections: 'cart-drawer,template--cart',
      },
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
      { intent: 'remove_from_cart', handler: 'shopifyRemoveFromCart', api: '{baseUrl}/cart/change.js' },
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
        tags: Array.isArray(p.tags)
          ? p.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 40)
          : String(p.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 40),
        // How the store classifies it ("Sabor: Naranja, Limón"). Shoppers ask
        // by these words, and dropping them left the catalog unable to tell
        // that a flavour range even existed. Mirrors _product_options in
        // backend/integrations/shopify_snapshot.py — change both together.
        options: (p.options || [])
          .map((o) => ({
            name: String(o.name || '').trim(),
            values: (o.values || []).map((v) => String(v).trim()).filter(Boolean).slice(0, 25),
          }))
          .filter(
            (o) =>
              o.name &&
              o.values.length &&
              !(o.name.toLowerCase() === 'title' && o.values.join().toLowerCase() === 'default title'),
          ),
        description: stripHtml(p.body_html).slice(0, 200),
        priceRange: (() => {
          const prices = (p.variants || []).map((v) => Number(v.price)).filter((n) => !Number.isNaN(n));
          if (!prices.length) return undefined;
          return { min: Math.min(...prices), max: Math.max(...prices) };
        })(),
        variantSample: (p.variants || []).slice(0, 12).map((v) => ({ id: v.id, title: v.title, price: v.price })),
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
    // Prefer `product` object over template name — custom PDP templates may omit
    // the substring "product" and would otherwise fall through to viewport scrape.
    "  {% if product %}",
    // Rich PDP context: opinions/details must use title, price, description —
    // not claim "no details". Related-product viewport scrape must NOT replace this.
    '  {% capture fyodos_screen_text %}The customer is viewing the product page of: {{ product.title }} (handle {{ product.handle }}, price {{ product.price | money | strip_html }}). Selected option: {{ product.selected_or_first_available_variant.title }}. Add-to-cart variantId: {{ product.selected_or_first_available_variant.id }}.{% if product.type != blank %} Type: {{ product.type }}.{% endif %} Description: {{ product.description | strip_html | truncate: 2400 }}. This IS the on-screen product — when asked for an opinion, for details, or HOW TO USE it (dosage, quantities, ingredients, sizes, materials, care, compatibility), answer from this text (title, price, description, options). Never say you lack product details when this block is present. To add it, call add_to_cart with that variantId.{% endcapture %}',
    "  window.__fyodosScreen = { kind: 'product', text: {{ fyodos_screen_text | json }} };",
    "  {% elsif template contains 'collection' and collection %}",
    '  {% capture fyodos_screen_text %}The customer is browsing the collection "{{ collection.title }}". Products visible on screen (title — price — add-to-cart variantId): {% for fyodos_p in collection.products limit: 16 %}{{ fyodos_p.title }} — {{ fyodos_p.price | money | strip_html }} — variantId {{ fyodos_p.selected_or_first_available_variant.id }}; {% endfor %}To add one to the cart, call add_to_cart with its variantId from this list.{% endcapture %}',
    "  window.__fyodosScreen = { kind: 'collection', text: {{ fyodos_screen_text | json }} };",
    "  {% elsif template contains 'search' and search.performed %}",
    '  {% capture fyodos_screen_text %}The customer is viewing search results for "{{ search.terms }}". Products visible on screen (title — price — add-to-cart variantId): {% for fyodos_r in search.results limit: 12 %}{% if fyodos_r.object_type == \'product\' %}{{ fyodos_r.title }} — {{ fyodos_r.price | money | strip_html }} — variantId {{ fyodos_r.selected_or_first_available_variant.id }}; {% endif %}{% endfor %}To add one to the cart, call add_to_cart with its variantId from this list.{% endcapture %}',
    "  window.__fyodosScreen = { kind: 'search', text: {{ fyodos_screen_text | json }} };",
    "  {% elsif template contains 'cart' %}",
    '  {% capture fyodos_screen_text %}The customer is viewing their cart: {{ cart.item_count }} item(s), total {{ cart.total_price | money | strip_html }}. Lines (title × quantity — variantId): {% for fyodos_i in cart.items %}{{ fyodos_i.product.title }} × {{ fyodos_i.quantity }} — variantId {{ fyodos_i.variant_id }}; {% endfor %}To REMOVE a line, call remove_from_cart with that line\'s variantId. To change quantity (keep the line), call update_cart_item with variantId and the ABSOLUTE target quantity. Never use add_to_cart for remove/quantity changes.{% endcapture %}',
    "  window.__fyodosScreen = { kind: 'cart', text: {{ fyodos_screen_text | json }} };",
    '  {% endif %}',
  ];
}

/** Liquid handle → variantId so collection cards without cart forms still resolve. */
function shopifyVariantMapLiquidLines() {
  return [
    '  window.__fyodosVariantMap = window.__fyodosVariantMap || {};',
    "  {% if product %}",
    '  window.__fyodosVariantMap[{{ product.handle | json }}] = {{ product.selected_or_first_available_variant.id }};',
    "  {% elsif template contains 'collection' and collection %}",
    '  {% for fyodos_p in collection.products limit: 50 %}',
    '  window.__fyodosVariantMap[{{ fyodos_p.handle | json }}] = {{ fyodos_p.selected_or_first_available_variant.id }};',
    '  {% endfor %}',
    "  {% elsif template contains 'search' and search.performed %}",
    '  {% for fyodos_r in search.results limit: 24 %}',
    "  {% if fyodos_r.object_type == 'product' %}",
    '  window.__fyodosVariantMap[{{ fyodos_r.handle | json }}] = {{ fyodos_r.selected_or_first_available_variant.id }};',
    '  {% endif %}',
    '  {% endfor %}',
    '  {% endif %}',
  ];
}

/**
 * Viewport scrape + publish — keep in sync with
 * backend/integrations/shopify_screen_js.py (every Shopify install).
 */
function shopifyViewportScreenJsLines() {
  return [
    "  function fyodosIsInViewport(el) {",
    "    if (!el || !el.getBoundingClientRect) return false;",
    "    var rect = el.getBoundingClientRect();",
    "    var vh = window.innerHeight || document.documentElement.clientHeight || 0;",
    "    return rect.bottom >= 40 && rect.top <= vh - 40;",
    "  }",
    "  function fyodosHandleFromHref(href) {",
    "    if (!href) return '';",
    "    var m = String(href).match(/\\/products\\/([^/?#]+)/i);",
    "    if (!m) return '';",
    "    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }",
    "  }",
    "  function fyodosIsGenericTitle(t) {",
    "    return !t || /^products?$/i.test(t) || /^items?$/i.test(t) || /^cards?$/i.test(t);",
    "  }",
    "  function fyodosTitleFromHandle(handle) {",
    "    if (!handle) return '';",
    "    return String(handle).replace(/[-_]+/g, ' ').replace(/\\b\\w/g, function (c) {",
    "      return c.toUpperCase();",
    "    }).slice(0, 120);",
    "  }",
    "  function fyodosResolveCardTitle(root, linkEl, handle) {",
    "    var title = '';",
    "    var attr = (root && (root.getAttribute('data-product-title') || root.getAttribute('data-title'))) || '';",
    "    if (attr) title = String(attr).replace(/\\s+/g, ' ').trim();",
    "    if (fyodosIsGenericTitle(title) && linkEl) {",
    "      var aria = linkEl.getAttribute('aria-label') || '';",
    "      if (aria) title = String(aria).replace(/\\s+/g, ' ').trim().slice(0, 120);",
    "    }",
    "    if (fyodosIsGenericTitle(title) && root) {",
    "      var titleEl = root.querySelector('h2, h3, h1, .card__heading, [class*=\"title\"]');",
    "      if (titleEl) title = String(titleEl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);",
    "    }",
    "    if (fyodosIsGenericTitle(title) && linkEl) {",
    "      title = String(linkEl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);",
    "    }",
    "    if (fyodosIsGenericTitle(title) && root) {",
    "      var img = root.querySelector('img[alt]');",
    "      var alt = img ? String(img.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim() : '';",
    "      if (alt && !fyodosIsGenericTitle(alt)) title = alt.slice(0, 120);",
    "    }",
    "    if (fyodosIsGenericTitle(title)) title = fyodosTitleFromHandle(handle);",
    "    return title;",
    "  }",
    "  function fyodosCollectViewportProducts() {",
    "    var seen = {};",
    "    var rows = [];",
    "    var map = window.__fyodosVariantMap || {};",
    "    var inputs = document.querySelectorAll('form[action*=\"/cart/add\"] input[name=\"id\"]');",
    "    for (var i = 0; i < inputs.length; i++) {",
    "      var input = inputs[i];",
    "      var id = String(input.value || '').trim();",
    "      if (!id || seen[id]) continue;",
    "      var form = input.form || input.closest('form');",
    "      if (!form || !fyodosIsInViewport(form)) continue;",
    "      seen[id] = true;",
    "      var root = form.closest('[class*=\"product\"], [id*=\"product\"], .card, li, article') || form;",
    "      var link = root.querySelector('a[href*=\"/products/\"]');",
    "      var handle = fyodosHandleFromHref(link && link.getAttribute('href'));",
    "      var title = fyodosResolveCardTitle(root, link, handle);",
    "      rows.push({ title: title, variantId: id, handle: handle });",
    "      if (rows.length >= 16) return rows;",
    "    }",
    "    var links = document.querySelectorAll('a[href*=\"/products/\"]');",
    "    for (var j = 0; j < links.length; j++) {",
    "      var a = links[j];",
    "      if (!fyodosIsInViewport(a)) continue;",
    "      var handle2 = fyodosHandleFromHref(a.getAttribute('href'));",
    "      if (!handle2) continue;",
    "      var card = a.closest('[class*=\"product\"], [id*=\"product\"], .card, li, article') || a;",
    "      var vid = '';",
    "      var attrId = card.getAttribute('data-variant-id') || a.getAttribute('data-variant-id') ||",
    "        card.getAttribute('data-product-variant') || '';",
    "      if (attrId) vid = String(attrId).trim();",
    "      if (!vid && map[handle2] != null) vid = String(map[handle2]).trim();",
    "      if (!vid) {",
    "        var hidden = card.querySelector('input[name=\"id\"], [name=\"id\"]');",
    "        if (hidden && hidden.value) vid = String(hidden.value).trim();",
    "      }",
    "      if (!vid || seen[vid]) continue;",
    "      seen[vid] = true;",
    "      var title2 = fyodosResolveCardTitle(card, a, handle2);",
    "      rows.push({ title: title2, variantId: vid, handle: handle2 });",
    "      if (rows.length >= 16) break;",
    "    }",
    "    return rows;",
    "  }",
    "  function fyodosPublishScreen(agent) {",
    "    if (!agent || typeof agent.setScreenContext !== 'function') return;",
    "    var base = window.__fyodosScreen || { kind: 'page', text: '' };",
    "    var path = String((location && location.pathname) || '').toLowerCase();",
    "    var onProductPath = path.indexOf('/products/') === 0;",
    "    // Cart: keep Liquid lines for update_cart_item. Product PDP: keep rich",
    "    // Liquid details \u2014 viewport related cards must not replace the PDP.",
    "    if ((base.kind === 'cart' || base.kind === 'product') && base.text) {",
    "      agent.setScreenContext(base);",
    "      return;",
    "    }",
    "    // URL is a PDP even if Liquid missed kind:'product' (custom templates).",
    "    // Never scrape related/recommended cards \u2014 that swaps the PDP product for a related card.",
    "    if (onProductPath && base.kind !== 'cart') {",
    "      if (base.text) {",
    "        agent.setScreenContext({ kind: 'product', text: base.text });",
    "      }",
    "      return;",
    "    }",
    "    var rows = fyodosCollectViewportProducts();",
    "    if (!rows.length) {",
    "      if (base.text) agent.setScreenContext(base);",
    "      return;",
    "    }",
    "    // If every scraped title is the placeholder 'product', keep Liquid \u2014",
    "    // otherwise clarify speech becomes 'product, product, product'.",
    "    var named = 0;",
    "    for (var n = 0; n < rows.length; n++) {",
    "      if (!fyodosIsGenericTitle(rows[n].title)) named += 1;",
    "    }",
    "    if (named === 0 && base.text) {",
    "      agent.setScreenContext(base);",
    "      return;",
    "    }",
    "    var parts = [];",
    "    for (var r = 0; r < rows.length; r++) {",
    "      var row = rows[r];",
    "      var label = fyodosIsGenericTitle(row.title)",
    "        ? fyodosTitleFromHandle(row.handle)",
    "        : row.title;",
    "      if (!label) label = fyodosTitleFromHandle(row.handle);",
    "      if (!label) continue;",
    "      var bit = label + ' \u2014 variantId ' + row.variantId;",
    "      if (row.handle) bit += ' \u2014 handle ' + row.handle;",
    "      parts.push(bit);",
    "    }",
    "    if (!parts.length) {",
    "      if (base.text) agent.setScreenContext(base);",
    "      return;",
    "    }",
    "    var text = 'Products currently visible in the viewport (title \u2014 add-to-cart variantId): ' + parts.join('; ') + '.';",
    "    if (parts.length === 1) {",
    "      text += ' Only ONE product is visible \u2014 when the customer says add it / a\u00f1\u00e1delo / ese, use that variantId.';",
    "    } else {",
    "      text += ' To add one to the cart, call add_to_cart with its variantId from this list.';",
    "    }",
    "    agent.setScreenContext({ kind: base.kind || 'collection', text: text });",
    "  }"
  ];
}

function shopifyViewportPublishWiringLines() {
  return [
    '        fyodosPublishScreen(agent);',
    '        window.__fyodosRefreshScreen = function () { fyodosPublishScreen(agent); };',
    '        var fyodosScreenTimer = null;',
    '        function fyodosScheduleScreenRefresh() {',
    '          if (fyodosScreenTimer) clearTimeout(fyodosScreenTimer);',
    '          fyodosScreenTimer = setTimeout(function () { fyodosPublishScreen(agent); }, 250);',
    '        }',
    "        window.addEventListener('scroll', fyodosScheduleScreenRefresh, { passive: true });",
    "        window.addEventListener('resize', fyodosScheduleScreenRefresh);",
    "        document.addEventListener('shopify:section:load', fyodosScheduleScreenRefresh);",
  ];
}

/**
 * The theme.liquid block: loads the embed, fetches the published manifest and
 * mounts the orb with API-wired registries. Mirrors the dashboard's
 * buildShopifySnippet, plus a Liquid-rendered screen context (product,
 * collection, search and cart pages) so the agent knows the visible items and
 * their variant ids (what add_to_cart / update_cart_item need by voice).
 */
function buildShopifySnippet({ apiKey, apiUrl, mcpConnectorUrl = '', sdkVersion = '' } = {}) {
  const key = apiKey || '<your-api-key>';
  const url = String(apiUrl || '').replace(/\/$/, '');
  // Agent-to-agent discovery (static): when the project's external channel is
  // enabled at wire time, advertise the MCP connector in the raw HTML so even
  // non-JS crawlers/agents find it. The SDK also injects/removes the same tag
  // at runtime following the dashboard toggle, so a later enable still works.
  const discovery = String(mcpConnectorUrl || '').trim();
  const cdn = embedCdnUrl(sdkVersion);
  return [
    ORB_START,
    ...(discovery
      ? [`<link rel="mcp-server" href="${discovery}" data-fyodos-mcp>`]
      : []),
    `<script src="${cdn}" defer></script>`,
    '<script>',
    ...shopifyScreenContextLiquidLines(),
    ...shopifyVariantMapLiquidLines(),
    ...shopifyViewportScreenJsLines(),
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
    '            // Markets: origin + Shopify.routes.root so suggest/product Ajax',
    '            // returns titles in the shopper locale (not always primary /es).',
    '            baseUrl: (Fiodos.shopifyStorefrontBaseUrl',
    '              ? Fiodos.shopifyStorefrontBaseUrl(window.location.origin)',
    '              : window.location.origin),',
    '          }),',
    "          localeDetection: 'document',",
    '          getLocale: function () {',
    '            try {',
    '              if (window.Shopify && Shopify.locale) {',
    "                return String(Shopify.locale).split(/[-_]/)[0];",
    '              }',
    '            } catch (e) {}',
    "            var seg = String((location.pathname || '').replace(/^\\/+/, '').split('/')[0] || '').toLowerCase();",
    "            if (/^[a-z]{2}(?:-[a-z0-9]{2,8})?$/.test(seg)) return seg.split('-')[0];",
    "            return (document.documentElement.lang || 'en').split(/[-_]/)[0];",
    '          },',
    '        });',
    ...shopifyViewportPublishWiringLines(),
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
  embedCdnUrl,
  fetchMcpConnectorUrl,
  wireShopifyTheme,
  reportShopifyWire,
  normalizeStoreDomain,
  FIODOS_EMBED_CDN_URL,
  SNAPSHOT_DIR,
};
