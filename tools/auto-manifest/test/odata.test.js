'use strict';
/**
 * Tests for the OData/CSDL connector (closed-software analysis mode).
 * Fixture: a reduced Dataverse-style $metadata with bound/unbound actions,
 * functions and entity sets.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseCsdl, buildManifestFromCsdl } = require('../src/odata');

const xml = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'dataverse-metadata-sample.xml'),
  'utf8',
);

describe('parseCsdl', () => {
  it('extracts namespace, entity types, sets, actions and functions', () => {
    const model = parseCsdl(xml);
    assert.equal(model.namespace, 'Microsoft.Dynamics.CRM');
    assert.ok(model.entityTypes.account);
    assert.deepEqual(model.entityTypes.account.keys, ['accountid']);
    assert.equal(model.entitySets.length, 2);
    assert.equal(model.actions.length, 4);
    assert.equal(model.functions.length, 3);
    const win = model.actions.find((a) => a.name === 'WinOpportunity');
    assert.equal(win.isBound, true);
    assert.equal(win.parameters.length, 3);
  });

  it('returns null for non-CSDL input', () => {
    assert.equal(parseCsdl('<html><body>nope</body></html>'), null);
  });
});

describe('buildManifestFromCsdl', () => {
  const { manifest, provenance } = buildManifestFromCsdl(xml, {
    appId: 'odata.test',
    appName: 'Test Dynamics',
    authRef: 'dataverse',
    entities: ['accounts', 'ghosts'],
  });
  const byIntent = Object.fromEntries(manifest.actions.map((a) => [a.intent, a]));

  it('generates a bound action with the entity-set URL and a targetId parameter', () => {
    const win = byIntent.win_opportunity;
    assert.ok(win, 'win_opportunity generated');
    assert.equal(win.execution.method, 'POST');
    assert.equal(
      win.execution.url,
      '{baseUrl}/opportunities({targetId})/Microsoft.Dynamics.CRM.WinOpportunity',
    );
    assert.equal(win.parameters.targetId.required, true);
    // Non-binding primitive params travel in the body with typed placeholders.
    assert.deepEqual(win.execution.body, { Status: '{Status}', Description: '{Description}' });
    assert.equal(win.parameters.Status.type, 'number');
    // OData Actions change data → always confirm.
    assert.equal(win.requireConfirmation, true);
    assert.equal(win.execution.authRef, 'dataverse');
  });

  it('generates an unbound action at the service root', () => {
    const send = byIntent.send_email_reminder;
    assert.equal(send.execution.url, '{baseUrl}/SendEmailReminder');
    assert.equal(send.requireConfirmation, true);
  });

  it('marks destructive-sounding actions as strict double confirmation', () => {
    const del = byIntent.delete_audit_data;
    assert.equal(del.doubleConfirmation, true);
    assert.equal(del.voiceConfirmation, 'strict');
  });

  it('skips bound actions with non-resolvable binding and records why', () => {
    // AddToQueue binds to mscrm.queue, which has no EntitySet in the fixture.
    assert.equal(byIntent.add_to_queue, undefined);
    assert.ok(
      provenance.skipped.some((s) => s.name === 'AddToQueue' && /no EntitySet/.test(s.reason)),
    );
  });

  it('generates GET actions for unbound functions (no confirmation, OData literal syntax)', () => {
    const who = byIntent.who_am_i;
    assert.equal(who.execution.method, 'GET');
    assert.equal(who.execution.url, '{baseUrl}/WhoAmI()');
    assert.equal(who.requireConfirmation, false);

    const tz = byIntent.get_time_zone_code_by_localized_name;
    assert.equal(
      tz.execution.url,
      "{baseUrl}/GetTimeZoneCodeByLocalizedName(LocalizedStandardName='{LocalizedStandardName}',LocaleId={LocaleId})",
    );
  });

  it('skips bound functions and records them for curation', () => {
    assert.equal(byIntent.retrieve_version, undefined);
    assert.ok(provenance.skipped.some((s) => s.name === 'RetrieveVersion'));
  });

  it('generates CRUD skeletons only for requested entity sets', () => {
    assert.ok(byIntent.create_account);
    assert.ok(byIntent.update_account);
    assert.ok(byIntent.delete_account);
    assert.ok(byIntent.get_account);
    // opportunities was NOT requested → no CRUD for it.
    assert.equal(byIntent.create_opportunity, undefined);
    // delete is destructive: strict + double confirmation.
    assert.equal(byIntent.delete_account.doubleConfirmation, true);
    assert.equal(byIntent.delete_account.execution.method, 'DELETE');
    assert.equal(byIntent.delete_account.execution.url, '{baseUrl}/accounts({id})');
    // create excludes the key and underscore-prefixed lookup columns.
    assert.equal(byIntent.create_account.parameters.accountid, undefined);
    assert.equal(byIntent.create_account.parameters._ownerid_value, undefined);
    assert.equal(byIntent.create_account.parameters.name.required, true);
  });

  it('records unknown --entities requests instead of guessing', () => {
    assert.ok(provenance.skipped.some((s) => s.name === 'ghosts'));
  });

  it('produces a draft that passes the real @fiodos/core validator', () => {
    const { validateManifest } = require('@fiodos/core');
    const result = validateManifest(manifest);
    assert.equal(result.valid, true, result.errors.join('; '));
  });
});
