import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScreenContextStore } from '../src/context/screenContextStore';

test('returns the registered text and snapshot', () => {
  const store = createScreenContextStore({ getCurrentRoute: () => '/items' });
  const owner = Symbol('a');
  store.set(owner, {
    kind: 'detail',
    text: 'Current screen: item detail',
    context: { visibleContent: { items: [{ id: '1', kind: 'document', metadata: {} }] } },
  });
  assert.equal(store.getText(), 'Current screen: item detail');
  assert.equal(store.getSnapshot()?.kind, 'detail');
});

test('clear only removes the entry of the same owner', () => {
  const store = createScreenContextStore({ getCurrentRoute: () => null });
  const a = Symbol('a');
  const b = Symbol('b');
  store.set(a, { kind: 'x', text: 'from A' });
  store.set(b, { kind: 'y', text: 'from B' });
  store.clear(a); // B replaced A; clearing A must not remove B's entry
  assert.equal(store.getText(), 'from B');
  store.clear(b);
  assert.equal(store.getSnapshot(), null);
});

test('falls back to the route description when nothing is registered', () => {
  const store = createScreenContextStore({
    getCurrentRoute: () => '/settings',
    routeFallback: (route) => (route === '/settings' ? 'Current screen: settings' : null),
  });
  assert.equal(store.getText(), 'Current screen: settings');
  assert.equal(store.getSnapshot(), null);
});

test('returns null without registration nor fallback', () => {
  const store = createScreenContextStore({ getCurrentRoute: () => '/x' });
  assert.equal(store.getText(), null);
});

test('whitespace-only registered text falls through to the fallback', () => {
  const store = createScreenContextStore({
    getCurrentRoute: () => '/x',
    routeFallback: () => 'route description',
  });
  store.set(Symbol('a'), { kind: 'k', text: '   ' });
  assert.equal(store.getText(), 'route description');
});
