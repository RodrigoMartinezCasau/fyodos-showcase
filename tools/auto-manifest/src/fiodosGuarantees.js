/**
 * Platform-guaranteed contact_fiodos — INTERNAL orbs only.
 * Mirrors backend/clients/fiodos_guarantees.py.
 */
'use strict';

const CONTACT_FIODOS_INTENT = 'contact_fiodos';
const CONTACT_FIODOS_HANDLER = 'fiodosContactFiodos';

const CANONICAL = {
  intent: CONTACT_FIODOS_INTENT,
  kind: 'function',
  category: 'support',
  handler: CONTACT_FIODOS_HANDLER,
  label: 'Contact Fiodos',
  labels: { es: 'Contactar con Fiodos', en: 'Contact Fiodos' },
  description:
    'Send a message from the end user to the Fiodos team — the company that builds this assistant.',
  examples: [
    'quiero contactar con Fiodos',
    'contact Fiodos',
    'háblame con Fiodos',
    'I want to contact Fiodos',
    'pásale esto a Fiodos',
    'send this to Fiodos',
    'mensaje para Fiodos',
    'talk to the Fiodos team',
  ],
  parameters: {
    message: {
      type: 'string',
      required: true,
      description:
        'Message to send to the Fiodos team, distilled from the conversation.',
    },
  },
  requireConfirmation: true,
  confirmationMessageTemplate: 'Send this message to Fiodos?\n\n{message}',
};

function isInternalOrbProfile(orbProfile) {
  return String(orbProfile || '').trim().toLowerCase() === 'internal';
}

function stripContactFiodosAction(manifest) {
  if (!manifest || typeof manifest !== 'object') return manifest;
  const actions = Array.isArray(manifest.actions) ? manifest.actions : [];
  const kept = actions.filter(
    (a) => !(a && typeof a === 'object' && String(a.intent || '').trim() === CONTACT_FIODOS_INTENT),
  );
  if (kept.length === actions.length) return manifest;
  return { ...manifest, actions: kept };
}

/**
 * @param {object} manifest
 * @param {{ orbProfile?: string }} [options]
 */
function ensureContactFiodosAction(manifest, options = {}) {
  if (!isInternalOrbProfile(options.orbProfile)) {
    return stripContactFiodosAction(manifest);
  }
  if (!manifest || typeof manifest !== 'object') return manifest;
  const actions = Array.isArray(manifest.actions) ? manifest.actions.slice() : [];
  const idx = actions.findIndex(
    (a) => a && typeof a === 'object' && String(a.intent || '').trim() === CONTACT_FIODOS_INTENT,
  );
  if (idx >= 0) {
    const existing = actions[idx];
    const ok =
      String(existing.handler || '').trim() === CONTACT_FIODOS_HANDLER &&
      existing.kind !== 'link' &&
      existing.requireConfirmation === true &&
      existing.parameters &&
      typeof existing.parameters === 'object' &&
      'message' in existing.parameters;
    if (ok) return manifest;
    actions[idx] = { ...CANONICAL, ...existing, ...CANONICAL, labels: { ...CANONICAL.labels, ...(existing.labels || {}) } };
    return { ...manifest, actions };
  }
  return { ...manifest, actions: [...actions, { ...CANONICAL }] };
}

module.exports = {
  CONTACT_FIODOS_INTENT,
  CONTACT_FIODOS_HANDLER,
  isInternalOrbProfile,
  stripContactFiodosAction,
  ensureContactFiodosAction,
};
