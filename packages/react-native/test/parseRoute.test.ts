import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePathname, parseRouteString } from '../src/navigation/parseRoute';

test('parses a plain route', () => {
  assert.deepEqual(parseRouteString('/items/recent'), {
    pathname: '/items/recent',
    params: {},
  });
});

test('parses query params with decoding', () => {
  assert.deepEqual(parseRouteString('/search?q=hello%20world&tab=top'), {
    pathname: '/search',
    params: { q: 'hello world', tab: 'top' },
  });
});

test('handles empty values and stray separators', () => {
  assert.deepEqual(parseRouteString('/a?x=&&y=1'), {
    pathname: '/a',
    params: { x: '', y: '1' },
  });
});

test('normalizePathname strips query and trailing slash', () => {
  assert.equal(normalizePathname('/a/b/?x=1'), '/a/b');
  assert.equal(normalizePathname('/'), '/');
  assert.equal(normalizePathname(null), '');
  assert.equal(normalizePathname(undefined), '');
});
