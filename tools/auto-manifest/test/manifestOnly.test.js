'use strict';

/**
 * Analysing an app Fiodos will never edit.
 *
 * A panel behind a VPN, a repo whose owner declines the wiring: we can read its
 * source and publish what it can do, but no generated handler registry will
 * ever exist there. An action that only names a function is dead on arrival —
 * the SDK registers nothing for it and drops it before the turn. What CAN run
 * is a call template that travels inside the manifest and is executed by the
 * embedded orb, in the user's own already-authenticated session. That is the
 * contract Shopify has always had; this fixes it to every unwired install.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyManifest } = require('../src/verify.js');

const SOURCE = [
  {
    rel: 'src/api/invoices.ts',
    content: 'export async function deleteInvoice(id: string) { /* ... */ }',
  },
];

const EVIDENCE = {
  routes: {},
  actions: {
    delete_invoice: { file: 'src/api/invoices.ts', symbol: 'deleteInvoice' },
    export_report: { file: 'src/api/invoices.ts', symbol: 'deleteInvoice' },
  },
};

function actionWithTemplate() {
  return {
    intent: 'delete_invoice',
    kind: 'function',
    handler: 'deleteInvoice',
    parameters: { id: { type: 'string', required: true } },
    execution: {
      kind: 'http',
      method: 'DELETE',
      url: '{baseUrl}/api/invoices/{id}',
    },
  };
}

function actionWithoutTemplate() {
  return {
    intent: 'export_report',
    kind: 'function',
    handler: 'deleteInvoice',
    parameters: {},
  };
}

function manifest(actions) {
  return { routes: [{ intent: 'home', route: '/' }], actions };
}

test('a call template is kept: it is the thing that can actually run', () => {
  const { manifest: out, provenance } = verifyManifest(
    manifest([actionWithTemplate()]),
    EVIDENCE,
    SOURCE,
    [],
    { verifyRoutes: false, platform: 'web', declarativeOnly: true },
  );

  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].intent, 'delete_invoice');
  assert.match(
    provenance.actions.find((a) => a.intent === 'delete_invoice').verification,
    /declarative execution/,
  );
});

test('an action that only names a function is dropped, not published to die on click', () => {
  const { manifest: out, provenance } = verifyManifest(
    manifest([actionWithoutTemplate()]),
    EVIDENCE,
    SOURCE,
    [],
    { verifyRoutes: false, platform: 'web', declarativeOnly: true },
  );

  assert.equal(out.actions.length, 0);
  assert.match(
    provenance.actions.find((a) => a.intent === 'export_report').reason,
    /nothing could ever run it/,
  );
});

test('navigation survives: a link needs no handler anywhere', () => {
  // Still proven the way every link is proven — the address must appear
  // verbatim in the code. Unwired only removes the handler requirement.
  const source = SOURCE.concat([
    { rel: 'src/Nav.tsx', content: '<a href="https://docs.example">Docs</a>' },
  ]);

  const { manifest: out } = verifyManifest(
    manifest([{ intent: 'open_docs', kind: 'link', navTarget: 'https://docs.example' }]),
    { routes: {}, actions: { open_docs: { file: 'src/Nav.tsx', symbol: 'Nav' } } },
    source,
    [],
    { verifyRoutes: false, platform: 'web', declarativeOnly: true },
  );

  assert.equal(out.actions.length, 1);
});

test('a broken template is dropped instead of shipping a request that cannot be built', () => {
  const bad = actionWithTemplate();
  bad.execution.url = '{baseUrl}/api/invoices/{invoiceId}'; // never declared

  const { manifest: out, provenance } = verifyManifest(
    manifest([bad]),
    EVIDENCE,
    SOURCE,
    [],
    { verifyRoutes: false, platform: 'web', declarativeOnly: true },
  );

  assert.equal(out.actions.length, 0);
  assert.match(
    provenance.actions.find((a) => a.intent === 'delete_invoice').reason,
    /undeclared parameter/,
  );
});

test('a normal wiring install is untouched: its function actions verify against code', () => {
  const { manifest: out } = verifyManifest(
    manifest([actionWithoutTemplate()]),
    EVIDENCE,
    SOURCE,
    [],
    { verifyRoutes: false, platform: 'web' },
  );

  assert.equal(out.actions.length, 1, 'the wired path still verifies against real source');
});
