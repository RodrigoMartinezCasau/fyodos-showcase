import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUiMessages, BUILT_IN_UI_CATALOGS } from '../src/i18n/resolve';
import { uiEn, uiEs } from '../src/i18n/catalogs';
import type { AgentUiMessages } from '../src/i18n/types';

test('resolves built-in en and es catalogs', () => {
  assert.equal(resolveUiMessages('en'), uiEn);
  assert.equal(resolveUiMessages('es'), uiEs);
});

test('regional locales resolve to base language', () => {
  assert.equal(resolveUiMessages('es-MX'), uiEs);
  assert.equal(resolveUiMessages('en-GB'), uiEn);
});

test('unknown locale throws instead of silently falling back', () => {
  assert.throws(() => resolveUiMessages('fr'), /No UI message catalog/);
});

test('external catalog can register a new locale', () => {
  const fr = { ...uiEn, errorTitle: 'Assistant vocal' } as AgentUiMessages;
  const resolved = resolveUiMessages('fr-FR', { catalogs: { fr } });
  assert.equal(resolved.errorTitle, 'Assistant vocal');
});

test('overrides apply on top of the resolved catalog', () => {
  const resolved = resolveUiMessages('en', { overrides: { errorTitle: 'My Agent' } });
  assert.equal(resolved.errorTitle, 'My Agent');
  assert.equal(resolved.confirmLabel, uiEn.confirmLabel);
});

test('en and es catalogs cover exactly the same keys', () => {
  assert.deepEqual(Object.keys(uiEn).sort(), Object.keys(uiEs).sort());
});

test('no built-in catalog references any concrete app or provider', () => {
  for (const [locale, catalog] of Object.entries(BUILT_IN_UI_CATALOGS)) {
    for (const [key, value] of Object.entries(catalog)) {
      assert.doesNotMatch(
        value,
        /\bevo\b|\bclan\b|\bopenai\b|reflexi|philosoph|filosof/i,
        `${locale}.${key} leaks a domain/provider term`,
      );
    }
  }
});
