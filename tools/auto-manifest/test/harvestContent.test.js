'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harvestContentUnits } = require('../src/harvestContent');

// What a site SAYS is not what a site DOES. The manifest is the second one:
// screens and actions. Without the first one the agent can route a visitor to
// a screen and still not know a word of what is written on it — which is how
// "something for X" ends up at an approximate section when the page that says
// X by name is one click away.
//
// This is the generic half (any codebase). It reads the copy that is already
// in the source of each screen the manifest proved, and nothing else.

function files(extra = []) {
  return [
    {
      rel: 'app/vitamins.tsx',
      content: `
        import { View, Text } from 'react-native';
        import { Banner } from '../components/Banner';
        const TRACK = 'analytics-key-do-not-show';
        export default function Vitamins() {
          return (
            <View>
              <Text>Vitamina D en cápsulas</Text>
              <Text>Contribuye al mantenimiento de los huesos.</Text>
              <Banner />
            </View>
          );
        }
      `,
    },
    {
      rel: 'components/Banner.tsx',
      content: `
        export function Banner() {
          return <p>Envío gratis a partir de 40 euros.</p>;
        }
      `,
    },
    ...extra,
  ];
}

function manifest() {
  return {
    routes: [
      { intent: 'vitamins', route: '/vitamins', description: 'Vitaminas' },
    ],
    actions: [],
  };
}

const evidence = { routes: { vitamins: { file: 'app/vitamins.tsx' } } };

test('the words written on a screen become something the agent can be asked about', () => {
  const units = harvestContentUnits({ files: files(), manifest: manifest(), evidence });
  assert.equal(units.length, 1);
  assert.match(units[0].body, /mantenimiento de los huesos/);
});

test('every harvested thing is tied to a screen the manifest already proved', () => {
  const [unit] = harvestContentUnits({ files: files(), manifest: manifest(), evidence });
  assert.equal(unit.unitId, 'route:vitamins');
  assert.equal(unit.url, '/vitamins');
  assert.equal(unit.routeIntent, 'vitamins');
});

test('a screen the manifest never proved is never invented as a destination', () => {
  const withStray = files([
    { rel: 'app/secret.tsx', content: '<Text>Página oculta</Text>' },
  ]);
  const units = harvestContentUnits({ files: withStray, manifest: manifest(), evidence });
  assert.deepEqual(units.map((u) => u.unitId), ['route:vitamins']);
});

test('what the screen shows through its own components counts as the screen saying it', () => {
  const [unit] = harvestContentUnits({ files: files(), manifest: manifest(), evidence });
  assert.match(unit.body, /Envío gratis/);
});

test('the machinery around the copy is not copy', () => {
  const [unit] = harvestContentUnits({ files: files(), manifest: manifest(), evidence });
  assert.doesNotMatch(unit.body, /analytics-key-do-not-show/);
  assert.doesNotMatch(unit.body, /react-native/);
});

test('a screen with nothing written on it is not worth an entry', () => {
  const empty = [
    { rel: 'app/blank.tsx', content: 'export default function Blank() { return <View />; }' },
  ];
  const units = harvestContentUnits({
    files: empty,
    manifest: { routes: [{ intent: 'blank', route: '/blank' }], actions: [] },
    evidence: { routes: { blank: { file: 'app/blank.tsx' } } },
  });
  assert.deepEqual(units, []);
});

test('a screen is found by its path when nothing recorded which file it came from', () => {
  const units = harvestContentUnits({ files: files(), manifest: manifest(), evidence: {} });
  assert.deepEqual(units.map((u) => u.unitId), ['route:vitamins']);
});

test('markup outside a component is copy too', () => {
  const units = harvestContentUnits({
    files: [
      {
        rel: 'pages/envios.liquid',
        content: '<h1>Envíos</h1><p>Entregamos en 24 horas en península.</p>',
      },
    ],
    manifest: { routes: [{ intent: 'shipping', route: '/pages/envios' }], actions: [] },
    evidence: { routes: { shipping: { file: 'pages/envios.liquid' } } },
  });
  assert.equal(units.length, 1);
  assert.match(units[0].body, /24 horas/);
});

test('the same site harvested twice reads the same, or a re-analysis is a rewrite', () => {
  const once = harvestContentUnits({ files: files(), manifest: manifest(), evidence });
  const twice = harvestContentUnits({ files: files(), manifest: manifest(), evidence });
  assert.deepEqual(once, twice);
});
