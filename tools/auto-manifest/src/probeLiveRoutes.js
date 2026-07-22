/**
 * Live HTTP probe for AI-proposed storefront routes.
 *
 * Filesystem verification does not exist for Shopify/web URL routes, so a
 * hallucinated path like /pages/contacto (real: /pages/contact) ships as a
 * dead navigate. HEAD/GET the public origin and drop 404s before publish.
 */
'use strict';

function normalizeStoreOrigin(store) {
  const raw = String(store || '').trim();
  if (!raw) return '';
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withProto);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

function isProbeableRoute(route) {
  const r = String(route || '').trim();
  if (!r || r === 'BACK') return false;
  if (/^(mailto|tel|sms):/i.test(r)) return false;
  if (/^https?:\/\//i.test(r)) return false; // external absolute — skip
  if (!r.startsWith('/')) return false;
  return true;
}

/**
 * @param {object} opts
 * @param {string} opts.store  storefront host or URL
 * @param {Array<{intent?: string, route?: string}>} opts.routes
 * @param {(url: string, init?: object) => Promise<Response>} [opts.fetchFn]
 * @param {number} [opts.timeoutMs]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ dead: Array<{intent: string, route: string, status: number}>, checked: number }>}
 */
async function probeLiveRoutes({
  store,
  routes,
  fetchFn = globalThis.fetch,
  timeoutMs = 8_000,
  log = () => {},
} = {}) {
  const origin = normalizeStoreOrigin(store);
  if (!origin || typeof fetchFn !== 'function') {
    return { dead: [], checked: 0, skipped: true };
  }

  const dead = [];
  let checked = 0;
  for (const entry of routes || []) {
    const path = entry?.route;
    if (!isProbeableRoute(path)) continue;
    checked += 1;
    const url = `${origin}${path.startsWith('/') ? path : `/${path}`}`;
    let status = 0;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetchFn(url, {
          method: 'HEAD',
          redirect: 'follow',
          signal: controller.signal,
          headers: { Accept: 'text/html' },
        });
        // Some storefronts reject HEAD — fall back to GET.
        if (res.status === 405 || res.status === 501) {
          res = await fetchFn(url, {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal,
            headers: { Accept: 'text/html' },
          });
        }
      } finally {
        clearTimeout(timer);
      }
      status = res.status;
    } catch (e) {
      log(`[probe] ${path} network error: ${e.message || e}`);
      continue; // fail-open on network blips — never drop routes we couldn't reach
    }
    if (status === 404 || status === 410) {
      dead.push({
        intent: String(entry.intent || ''),
        route: path,
        status,
      });
      log(`[probe] DROP ${path} → HTTP ${status}`);
    } else {
      log(`[probe] ok ${path} → HTTP ${status}`);
    }
  }
  return { dead, checked, skipped: false };
}

/**
 * Remove routes that probeLiveRoutes marked dead; annotate provenance.
 */
function dropDeadRoutes(manifest, provenance, dead) {
  if (!dead?.length) return [];
  const deadPaths = new Set(dead.map((d) => d.route));
  const dropped = [];
  const kept = [];
  for (const route of manifest.routes || []) {
    if (deadPaths.has(route.route)) {
      dropped.push(route.intent);
      if (provenance?.routes) {
        provenance.routes.push({
          intent: route.intent,
          included: false,
          reason: `live probe: '${route.route}' returned 404/410 on the storefront — DROPPED`,
        });
      }
      continue;
    }
    kept.push(route);
  }
  manifest.routes = kept;
  return dropped;
}

module.exports = {
  normalizeStoreOrigin,
  isProbeableRoute,
  probeLiveRoutes,
  dropDeadRoutes,
};
