import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReactNavigationAdapter,
  type ReactNavigationContainerRefLike,
} from '../src/navigation/reactNavigation';

function fakeRef(overrides: Partial<ReactNavigationContainerRefLike> = {}) {
  const calls: Array<{ name: string; params?: object }> = [];
  let wentBack = 0;
  const ref: ReactNavigationContainerRefLike = {
    isReady: () => true,
    navigate: (name, params) => {
      calls.push({ name, params });
    },
    canGoBack: () => false,
    goBack: () => {
      wentBack += 1;
    },
    getCurrentRoute: () => ({ name: 'Home' }),
    ...overrides,
  };
  return { ref, calls, wentBack: () => wentBack };
}

test('navigate maps manifest routes through the explicit mapRoute', () => {
  const { ref, calls } = fakeRef();
  const adapter = createReactNavigationAdapter({
    navigationRef: ref,
    mapRoute: (pathname, params) => ({
      name: pathname === '/settings' ? 'Settings' : 'Unknown',
      params,
    }),
  });
  adapter.navigate('/settings?section=privacy');
  assert.deepEqual(calls, [{ name: 'Settings', params: { section: 'privacy' } }]);
});

test('navigate throws when the container is not ready', () => {
  const { ref } = fakeRef({ isReady: () => false });
  const adapter = createReactNavigationAdapter({
    navigationRef: ref,
    mapRoute: () => ({ name: 'X' }),
  });
  assert.throws(() => adapter.navigate('/x'), /not ready/);
});

test('back uses history when available', () => {
  const { ref, wentBack } = fakeRef({ canGoBack: () => true });
  const adapter = createReactNavigationAdapter({
    navigationRef: ref,
    mapRoute: () => ({ name: 'X' }),
  });
  adapter.back();
  assert.equal(wentBack(), 1);
});

test('back falls back to the configured route when history is empty', () => {
  const { ref, calls } = fakeRef();
  const adapter = createReactNavigationAdapter({
    navigationRef: ref,
    mapRoute: (pathname) => ({ name: pathname === '/home' ? 'Home' : 'Other' }),
    backFallbackRoute: '/home',
  });
  adapter.back();
  assert.deepEqual(calls, [{ name: 'Home', params: undefined }]);
});

test('getCurrentRoute reads the live route name', () => {
  const { ref } = fakeRef();
  const adapter = createReactNavigationAdapter({
    navigationRef: ref,
    mapRoute: () => ({ name: 'X' }),
  });
  assert.equal(adapter.getCurrentRoute(), 'Home');
});
