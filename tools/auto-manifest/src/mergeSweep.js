'use strict';

/**
 * MERGE of a multi-pass sweep into the manifest the analysis proposed.
 *
 * A sweep reads code no earlier pass ever saw, so it can return whole screens as
 * well as actions — and it only has the previous passes' findings as a LIST, not
 * as the manifest itself. That makes the merge, not the model, the last line of
 * defence: a duplicated intent, a second route on the same URL or a repeated
 * capability would ship a manifest where the orb offers the same thing twice (or
 * navigates to a path another screen already owns).
 *
 * Kept pure and separate from the CLI flow so these invariants are testable:
 *  - never add an intent that already exists (screen or action),
 *  - never add a second route for a URL that is already covered,
 *  - never add an action whose handler+params signature is already there,
 *  - carry each accepted entry's evidence/wiring, so verification can still drop
 *    it (nothing is wired blind just because a sweep proposed it).
 */

/** Identity of an action beyond its name: same code + same params = same thing. */
function actionSignature(action) {
  const handler = String((action && action.handler) || '').trim();
  const params = Object.keys((action && action.parameters) || {}).sort().join(',');
  return `${handler}|${params}`;
}

/**
 * Fold one sweep pass into `proposed` (mutated in place, like the rest of the
 * analysis pipeline expects).
 *
 * @param {object} args
 * @param {object} args.proposed  manifest under construction ({routes, actions})
 * @param {object} args.evidence  evidence map ({routes:{}, actions:{}})
 * @param {object} args.wiring    wiring map keyed by intent
 * @param {object} args.sweep     one sweep result ({routes, actions, evidence, wiring})
 * @returns {{routes: number, actions: number, skipped: string[]}}
 */
function mergeSweepResults({ proposed, evidence, wiring, sweep }) {
  proposed.routes = Array.isArray(proposed.routes) ? proposed.routes : [];
  proposed.actions = Array.isArray(proposed.actions) ? proposed.actions : [];
  evidence.routes = evidence.routes || {};
  evidence.actions = evidence.actions || {};

  const seenIntents = new Set([
    ...proposed.routes.map((r) => r.intent),
    ...proposed.actions.map((a) => a.intent),
  ]);
  const seenPaths = new Set(
    proposed.routes.map((r) => String((r && r.route) || '').trim()).filter(Boolean),
  );
  const seenSigs = new Set(proposed.actions.map(actionSignature));

  const skipped = [];
  let routes = 0;
  let actions = 0;

  for (const route of Array.isArray(sweep && sweep.routes) ? sweep.routes : []) {
    const intent = route && route.intent;
    const routePath = String((route && route.route) || '').trim();
    if (!intent) continue;
    // A screen with no path cannot be navigated to, and a duplicate path would
    // give two screens the same URL: the orb would pick one at random.
    if (seenIntents.has(intent) || !routePath || seenPaths.has(routePath)) {
      skipped.push(intent);
      continue;
    }
    proposed.routes.push(route);
    seenIntents.add(intent);
    seenPaths.add(routePath);
    if (sweep.evidence && sweep.evidence.routes && sweep.evidence.routes[intent]) {
      evidence.routes[intent] = sweep.evidence.routes[intent];
    }
    routes += 1;
  }

  for (const action of Array.isArray(sweep && sweep.actions) ? sweep.actions : []) {
    const intent = action && action.intent;
    if (!intent) continue;
    if (seenIntents.has(intent) || seenSigs.has(actionSignature(action))) {
      skipped.push(intent);
      continue;
    }
    proposed.actions.push(action);
    seenIntents.add(intent);
    seenSigs.add(actionSignature(action));
    if (sweep.evidence && sweep.evidence.actions && sweep.evidence.actions[intent]) {
      evidence.actions[intent] = sweep.evidence.actions[intent];
    }
    if (sweep.wiring && sweep.wiring[intent]) wiring[intent] = sweep.wiring[intent];
    actions += 1;
  }

  return { routes, actions, skipped };
}

module.exports = { mergeSweepResults, actionSignature };
