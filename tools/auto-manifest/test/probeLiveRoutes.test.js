'use strict';

const assert = require('assert');
const {
  normalizeStoreOrigin,
  isProbeableRoute,
  probeLiveRoutes,
  dropDeadRoutes,
} = require('../src/probeLiveRoutes');

assert.equal(normalizeStoreOrigin('salubell.com'), 'https://salubell.com');
assert.equal(normalizeStoreOrigin('https://jykmmn-4m.myshopify.com/'), 'https://jykmmn-4m.myshopify.com');
assert.equal(isProbeableRoute('/pages/contact'), true);
assert.equal(isProbeableRoute('BACK'), false);
assert.equal(isProbeableRoute('mailto:a@b.com'), false);

(async () => {
  const statuses = {
    'https://shop.test/': 200,
    'https://shop.test/pages/contact': 200,
    'https://shop.test/pages/contacto': 404,
    'https://shop.test/collections/a': 200,
  };
  const fetchFn = async (url, init) => {
    assert.ok(init.method === 'HEAD' || init.method === 'GET');
    return { status: statuses[url] ?? 200 };
  };
  const { dead, checked } = await probeLiveRoutes({
    store: 'shop.test',
    routes: [
      { intent: 'home', route: '/' },
      { intent: 'contact', route: '/pages/contact' },
      { intent: 'contacto', route: '/pages/contacto' },
      { intent: 'col', route: '/collections/a' },
      { intent: 'back', route: 'BACK' },
    ],
    fetchFn,
  });
  assert.equal(checked, 4);
  assert.deepEqual(dead.map((d) => d.route), ['/pages/contacto']);

  const manifest = {
    routes: [
      { intent: 'contact', route: '/pages/contact' },
      { intent: 'contacto', route: '/pages/contacto' },
    ],
  };
  const provenance = { routes: [] };
  const dropped = dropDeadRoutes(manifest, provenance, dead);
  assert.deepEqual(dropped, ['contacto']);
  assert.equal(manifest.routes.length, 1);
  assert.equal(manifest.routes[0].intent, 'contact');
  console.log('PASS probeLiveRoutes');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
