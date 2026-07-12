/**
 * Output verifier — the mechanical layer in its NEW role.
 *
 * The AI reads the code and proposes; this module confirms. It can only drop
 * an individual unproven claim — it can never blind the analysis (the old
 * candidate-gatekeeper failure mode).
 *
 * Checks per action:
 *   1. evidence file exists among the files sent to the model
 *   2. the handler (and evidence symbol) appears as a real identifier in that
 *      file — word-boundary match, so 'addToCart' can't pass via 'addToCartX'
 * Checks per route:
 *   3. the route href maps to a statically-scanned expo-router screen
 *      (or BACK, the SDK convention)
 *
 * Anything that fails is REMOVED from the manifest and recorded in
 * provenance as dropped. A hallucinated action that ships is worse than a
 * missed one.
 */
'use strict';

/** Extract candidate identifiers from an evidence symbol string.
 *  e.g. "useAuthStore (signOut action)" → ['useAuthStore', 'signOut'] */
function identifiersIn(text) {
  return String(text || '').match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || [];
}

function fileHasIdentifier(content, identifier) {
  if (!identifier) return false;
  const re = new RegExp(`(^|[^A-Za-z0-9_$])${identifier}([^A-Za-z0-9_$]|$)`);
  return re.test(content);
}

const EXECUTION_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Structural check of a declarative `execution` block (closed platforms).
 * Mirrors @fiodos/core validateExecution: http kind, known method, non-empty
 * url, and every {placeholder} resolvable (baseUrl or a declared parameter).
 * Returns a problem string, or null when the block is sound.
 */
function validateExecutionShape(action) {
  const exec = action.execution;
  if (!exec || typeof exec !== 'object') return 'missing execution object';
  if (exec.kind !== 'http') return `kind '${exec.kind}' is not 'http'`;
  if (!EXECUTION_METHODS.has(exec.method)) return `invalid method '${exec.method}'`;
  if (typeof exec.url !== 'string' || !exec.url.trim()) return 'empty url';
  if (!String(action.handler || '').trim()) return 'function action has no handler name';
  const declared = new Set(Object.keys(action.parameters || {}));
  const placeholders = new Set();
  const collect = (value) => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) placeholders.add(m[1]);
    } else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) collect(v);
    }
  };
  collect(exec.url);
  collect(exec.body);
  for (const name of placeholders) {
    if (name !== 'baseUrl' && !declared.has(name)) {
      return `execution references undeclared parameter '{${name}}'`;
    }
  }
  return null;
}

/**
 * Upper bound on examples kept per route/action. The enriched prompt asks the
 * model for 5-8 varied phrasings; this cap protects the cacheable system prompt
 * from a runaway list while leaving generous room for real synonyms.
 */
const MAX_EXAMPLES = 10;

/**
 * Sanitize a manifest item's `examples` array WITHOUT ever dropping the item:
 * trims, removes empties, deduplicates case-insensitively (first spelling wins),
 * and caps the count. Fail-open: when the model returned nothing usable, falls
 * back to a single phrase derived from the label/intent so the core validator's
 * "non-empty examples" rule still passes (today's contract, never weakened).
 */
function sanitizeExamples(raw, fallbackLabel) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const cleaned = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const phrase = entry.replace(/\s+/g, ' ').trim();
    if (!phrase) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(phrase);
    if (cleaned.length >= MAX_EXAMPLES) break;
  }
  if (cleaned.length === 0) {
    const fallback = String(fallbackLabel || '').replace(/\s+/g, ' ').trim();
    if (fallback) cleaned.push(fallback);
  }
  return cleaned;
}

/**
 * Max length (chars) of a route's `bubblePrompt` (the short orb CTA). The prompt
 * asks for ~6 words; this is a generous hard cap so a runaway sentence can never
 * bloat the bubble UI or the served manifest.
 */
const MAX_BUBBLE_PROMPT = 80;

/**
 * Sanitize a route's `bubblePrompt` (fail-open, item never dropped): trims,
 * collapses whitespace, strips wrapping quotes, and caps the length. Returns
 * undefined when there is nothing usable (the SDK then derives a fallback from
 * the label/examples), so a bad value never sticks.
 */
function sanitizeBubblePrompt(raw) {
  if (typeof raw !== 'string') return undefined;
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/^["'«»“”]+|["'«»“”]+$/g, '').trim();
  if (!s) return undefined;
  if (s.length > MAX_BUBBLE_PROMPT) s = s.slice(0, MAX_BUBBLE_PROMPT).trim();
  return s || undefined;
}

/** Normalize an expo-router href for comparison: strip (groups), trailing /index. */
function normalizeHref(href) {
  return ('/' + String(href || '')
    .replace(/\([^)]*\)\//g, '')
    .replace(/^\/+/, '')
    .replace(/\/index$/, ''))
    .replace(/\/+$/, '') || '/';
}

/**
 * @param manifest  manifest as the model produced it
 * @param evidence  { routes: {intent: {file, symbol}}, actions: {intent: {file, symbol, whatItDoes}} }
 * @param sentFiles array of { rel, content } that were in the prompt
 * @param staticRoutes array of { routePath, urlPath, relFile } from scanRoutes
 * @param opts.verifyRoutes  when false, AI-proposed routes are kept WITHOUT
 *        filesystem verification (web apps have no expo-router ground truth).
 *        Actions are always verified against real code regardless.
 *        Defaults to true when there is a static route ground truth.
 * @returns { manifest, provenance }
 */
function verifyManifest(manifest, evidence, sentFiles, staticRoutes, opts = {}) {
  const byRel = new Map(sentFiles.map((f) => [f.rel.replace(/\\/g, '/'), f.content]));
  const verifyRoutes = opts.verifyRoutes ?? staticRoutes.length > 0;
  const provenance = {
    engine: 'auto-manifest-v3-ai-first',
    routeVerification: verifyRoutes ? 'filesystem' : 'ai-proposed (no static ground truth)',
    routes: [],
    actions: [],
    notes: [],
  };

  const validHrefs = new Set();
  for (const r of staticRoutes) {
    validHrefs.add(normalizeHref(r.routePath));
    validHrefs.add(normalizeHref(r.urlPath));
  }

  const routes = [];
  for (const route of manifest.routes || []) {
    if (route.route === 'BACK') {
      routes.push(route);
      provenance.routes.push({ intent: route.intent, included: true, verification: 'static (SDK convention)' });
      continue;
    }
    // Web mode: no filesystem route ground truth, so we cannot statically
    // confirm routes. Keep what the AI proposed, but flag it as unverified —
    // honesty over false precision.
    if (!verifyRoutes) {
      routes.push(route);
      provenance.routes.push({
        intent: route.intent, included: true,
        verification: 'ai-proposed (route NOT statically verified — web app)',
        evidence: evidence.routes?.[route.intent] || null,
      });
      continue;
    }
    const ok = validHrefs.has(normalizeHref(route.route));
    if (!ok) {
      provenance.routes.push({
        intent: route.intent, included: false,
        reason: `route '${route.route}' not found in expo-router file scan — DROPPED`,
      });
      continue;
    }
    routes.push(route);
    provenance.routes.push({
      intent: route.intent, included: true,
      verification: 'route exists in filesystem scan',
      evidence: evidence.routes?.[route.intent] || null,
    });
  }

  const isShopify = opts.platform === 'shopify';
  const actions = [];
  for (const action of manifest.actions || []) {
    const ev = evidence.actions?.[action.intent] || {};
    const evFile = String(ev.file || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const content = byRel.get(evFile);

    // Shopify (closed platform): the ground truth for API actions is the
    // platform itself, not app code. An action carrying a declarative
    // `execution` block is verified STRUCTURALLY (http kind + method + url and
    // every {placeholder} declared) — a synthetic handler name can never match
    // an identifier in a .liquid file, and requiring it would drop the whole
    // universal commerce set. The universal "/checkout" link is likewise
    // platform-guaranteed (themes rarely hardcode that href).
    if (isShopify && action.kind !== 'link' && action.execution) {
      const problem = validateExecutionShape(action);
      if (problem) {
        provenance.actions.push({
          intent: action.intent, included: false,
          reason: `invalid execution block — ${problem} — DROPPED`,
        });
        continue;
      }
      actions.push(action);
      provenance.actions.push({
        intent: action.intent, included: true,
        verification: 'declarative execution (Shopify storefront API — platform-guaranteed)',
        evidence: ev,
      });
      continue;
    }
    if (isShopify && action.kind === 'link' && String(action.navTarget || '').trim() === '/checkout') {
      action.handler = '';
      actions.push(action);
      provenance.actions.push({
        intent: action.intent, included: true,
        verification: 'universal Shopify checkout link (platform-guaranteed)',
        evidence: ev,
      });
      continue;
    }

    if (!content) {
      provenance.actions.push({
        intent: action.intent, included: false,
        reason: `evidence file '${ev.file || '(none)'}' was not among the files sent — DROPPED`,
      });
      continue;
    }

    // LINK/navigation actions: no handler. Verify the navTarget appears VERBATIM
    // in the evidence file (the real href/URL/anchor) — concrete, hallucination-
    // proof evidence. No wiring is generated for these.
    if (action.kind === 'link') {
      const target = String(action.navTarget || ev.href || '').trim();
      if (!target) {
        provenance.actions.push({
          intent: action.intent, included: false,
          reason: `link action '${action.intent}' has no navTarget — DROPPED`,
        });
        continue;
      }
      if (!content.includes(target)) {
        provenance.actions.push({
          intent: action.intent, included: false,
          reason: `link action navTarget '${target}' not found verbatim in '${evFile}' — DROPPED`,
        });
        continue;
      }
      // Normalize: link actions carry no handler and never require wiring.
      action.handler = '';
      actions.push(action);
      provenance.actions.push({
        intent: action.intent, included: true,
        verification: `link target '${target}' confirmed in ${evFile}`,
        evidence: ev,
      });
      continue;
    }

    // The handler must be a real identifier in the evidence file. Also accept
    // any identifier from the symbol (covers "store.addItem"-style handlers).
    const candidates = [action.handler, ...identifiersIn(ev.symbol)].filter(Boolean);
    const found = candidates.find((c) => fileHasIdentifier(content, c));
    if (!found) {
      provenance.actions.push({
        intent: action.intent, included: false,
        reason: `neither handler '${action.handler}' nor symbol '${ev.symbol}' found in '${evFile}' — DROPPED`,
      });
      continue;
    }

    actions.push(action);
    provenance.actions.push({
      intent: action.intent, included: true,
      verification: `identifier '${found}' confirmed in ${evFile}`,
      evidence: ev,
    });
  }

  // Intent namespace is shared between routes and actions (core validator).
  const seen = new Set();
  const dedupedRoutes = routes.filter((r) => !seen.has(r.intent) && seen.add(r.intent));
  const dedupedActions = actions.filter((a) => {
    if (seen.has(a.intent)) {
      provenance.notes.push(`duplicate intent '${a.intent}' — kept first occurrence, action dropped`);
      return false;
    }
    seen.add(a.intent);
    return true;
  });

  // Layer 2 — "what you can do here": keep each route's actionIntents fail-open.
  // Only intents that survived action verification stay (a dangling intent
  // pointing at a dropped/hallucinated action is silently removed, deduped).
  // Empty/invalid → the field is removed entirely (Layer 1 still works).
  const keptActionIntents = new Set(dedupedActions.map((a) => a.intent));
  for (const route of dedupedRoutes) {
    if (!Array.isArray(route.actionIntents)) {
      delete route.actionIntents;
      continue;
    }
    const seenIntent = new Set();
    const cleaned = route.actionIntents.filter(
      (i) => typeof i === 'string' && keptActionIntents.has(i) && !seenIntent.has(i) && seenIntent.add(i),
    );
    if (cleaned.length > 0) route.actionIntents = cleaned;
    else delete route.actionIntents;
  }

  // Escort target: keep each action's showcaseRoute fail-open. It must point
  // at a SURVIVING, navigable route intent (never BACK); anything else —
  // hallucinated ids, dropped routes, non-strings — is silently removed so a
  // wrong escort can never ship (a wrong screen is worse than no escort).
  const navigableRouteIntents = new Set(
    dedupedRoutes.filter((r) => r.route !== 'BACK').map((r) => r.intent),
  );
  for (const action of dedupedActions) {
    if (action.showcaseRoute === undefined) continue;
    if (typeof action.showcaseRoute !== 'string' || !navigableRouteIntents.has(action.showcaseRoute)) {
      provenance.notes.push(
        `action '${action.intent}': showcaseRoute '${String(action.showcaseRoute)}' does not match a navigable route — removed`,
      );
      delete action.showcaseRoute;
    }
  }

  // Audience map (fail-open): only the two known values survive; anything else
  // is dropped so an invalid claim can never HIDE a capability from a user.
  // 'public' is the implicit default, so it is normalized away (absent = public).
  // requiredCapabilities become a deduped list of short snake_case names; a
  // malformed list is dropped entirely (a bogus capability must never hide an
  // action behind a flag no session will ever report).
  for (const item of [...dedupedRoutes, ...dedupedActions]) {
    if (item.audience !== undefined && item.audience !== 'authenticated') {
      if (item.audience !== 'public') {
        provenance.notes.push(
          `'${item.intent}': audience '${String(item.audience)}' is not public/authenticated — removed`,
        );
      }
      delete item.audience;
    }
  }
  for (const action of dedupedActions) {
    if (action.requiredCapabilities === undefined) continue;
    const caps = Array.isArray(action.requiredCapabilities)
      ? [
          ...new Set(
            action.requiredCapabilities
              .filter((c) => typeof c === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(c.trim()))
              .map((c) => c.trim()),
          ),
        ].slice(0, 8)
      : [];
    if (caps.length > 0) action.requiredCapabilities = caps;
    else {
      provenance.notes.push(
        `action '${action.intent}': requiredCapabilities had no valid snake_case names — removed`,
      );
      delete action.requiredCapabilities;
    }
  }

  // Examples hygiene (fail-open): trim, dedupe and cap the enriched phrasings on
  // every surviving route and action. Never drops the item; falls back to the
  // label so the core validator's non-empty-examples rule still holds.
  for (const route of dedupedRoutes) {
    if (route.route === 'BACK') continue;
    route.examples = sanitizeExamples(route.examples, route.label || route.intent);
    let bubble = sanitizeBubblePrompt(route.bubblePrompt);
    if (!bubble) {
      try {
        const { deriveBubblePromptFromContext, resolveMessages } = require('@fiodos/core');
        bubble = sanitizeBubblePrompt(
          deriveBubblePromptFromContext(route, resolveMessages('en'), {
            locale: 'en',
            actions: dedupedActions,
          }),
        );
      } catch {
        /* core unavailable — leave bubble unset */
      }
    }
    if (bubble) route.bubblePrompt = bubble;
    else delete route.bubblePrompt;
  }

  // Schema coercion the model sometimes needs (same as the old engine).
  for (const action of dedupedActions) {
    action.examples = sanitizeExamples(action.examples, action.label || action.intent);
    for (const spec of Object.values(action.parameters || {})) {
      if (spec.type === 'integer' || spec.type === 'float') spec.type = 'number';
      else if (!['string', 'number', 'boolean'].includes(spec.type)) spec.type = 'string';
      if (typeof spec.required !== 'boolean') spec.required = false;
      if (typeof spec.description !== 'string' || !spec.description) spec.description = action.label || action.intent;
    }
    if (action.requireConfirmation && !action.confirmationMessageTemplate) {
      action.confirmationMessageTemplate = `Confirm: ${action.label || action.intent}?`;
      provenance.notes.push(`action '${action.intent}': confirmation template filled mechanically`);
    }
  }

  return {
    manifest: { ...manifest, routes: dedupedRoutes, actions: dedupedActions },
    provenance,
  };
}

module.exports = { verifyManifest, normalizeHref, sanitizeExamples, validateExecutionShape, MAX_EXAMPLES };
