import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../src/bridge/createBridge';
import { createUiRegistry } from '../src/bridge/createUiRegistry';

interface DemoBridge {
  getValue(): number;
}

test('bridge starts unregistered and accepts set/clear', () => {
  const bridge = createBridge<DemoBridge>('demo');
  assert.equal(bridge.get(), null);
  bridge.set({ getValue: () => 42 });
  assert.equal(bridge.get()?.getValue(), 42);
  bridge.set(null);
  assert.equal(bridge.get(), null);
});

test('ui registry registers per-id handlers with safe cleanup', () => {
  const registry = createUiRegistry<{ open(): string }>();
  const cleanupA = registry.register('a', { open: () => 'A' });
  const cleanupB = registry.register('b', { open: () => 'B' });
  assert.equal(registry.get('a')?.open(), 'A');
  assert.equal(registry.get('b')?.open(), 'B');
  assert.equal(registry.get('missing'), null);

  cleanupA();
  assert.equal(registry.get('a'), null);

  // Re-registering the same id: stale cleanup must not delete the new entry.
  const cleanupB2 = registry.register('b', { open: () => 'B2' });
  cleanupB();
  assert.equal(registry.get('b')?.open(), 'B2');
  cleanupB2();
  assert.equal(registry.get('b'), null);
});
