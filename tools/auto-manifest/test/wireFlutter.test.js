/**
 * wireFlutter — Flutter orb auto-mount (mirrors wireReactNative.test.js).
 *
 * The same publish command wraps the app's home: widget with the SDK's one-line
 * FiodosAgent (key read from --dart-define, never hardcoded) and writes the
 * git-ignored dart-define env file. Guards idempotency, the snippet fallback for
 * complex layouts, and that we never touch a main.dart we cannot safely wrap.
 *
 * Usage: node test/wireFlutter.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  wireFlutterOrb,
  writeFlutterEnv,
  buildWiredMain,
  findMainDart,
} = require('../src/wireFlutter');
const { gitignoreCovers } = require('../src/writeEnv');

const NO_COLORS = { blue: '', cyan: '', dim: '', reset: '' };
const KEY = 'fyd_TESTtoken_abcdefghijklmnop';

function mkApp(mainSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fyo-fl-'));
  fs.writeFileSync(path.join(root, 'pubspec.yaml'), 'name: demo\n');
  const abs = path.join(root, 'lib', 'main.dart');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (mainSource != null) fs.writeFileSync(abs, mainSource);
  return { root, abs };
}

function quietly(fn) {
  const orig = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = orig;
  }
}

// ── 1. Standard MaterialApp with home: const Widget() → auto-wrapped ──────────
{
  const main = `import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Demo',
      home: const TodoListScreen(),
    );
  }
}
`;
  const { root, abs } = mkApp(main);
  const res = wireFlutterOrb(root, { colors: NO_COLORS });
  assert.strictEqual(res.status, 'added', `expected added, got ${res.status} (${res.reason})`);

  const out = fs.readFileSync(abs, 'utf8');
  assert.ok(out.includes("import 'package:fiodos_flutter/fiodos_flutter.dart';"), 'SDK import added');
  assert.ok(out.includes('home: FiodosAgent('), 'home wrapped with FiodosAgent');
  assert.ok(out.includes("apiKey: const String.fromEnvironment('FYODOS_API_KEY')"), 'key read from dart-define, not hardcoded');
  assert.ok(out.includes('child: const TodoListScreen(),'), 'original home widget preserved as child (const kept)');
  assert.ok(!out.includes(KEY), 'secret never written into source');
  assert.strictEqual((out.match(/FiodosAgent\(/g) || []).length, 1, 'exactly one wrap');

  // Idempotent.
  const res2 = wireFlutterOrb(root, { colors: NO_COLORS });
  assert.strictEqual(res2.status, 'already', `expected already, got ${res2.status}`);
  console.log('ok 1 — standard MaterialApp home: auto-wrapped + idempotent');
}

// ── 2. home: with constructor args (no nested parens) → wrapped, args kept ────
{
  const main = `import 'package:flutter/material.dart';
class App extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return MaterialApp(home: MyHomePage(title: 'Hi'));
  }
}
`;
  const { root, abs } = mkApp(main);
  const res = wireFlutterOrb(root, { colors: NO_COLORS });
  assert.strictEqual(res.status, 'added');
  const out = fs.readFileSync(abs, 'utf8');
  assert.ok(out.includes("child: MyHomePage(title: 'Hi'),"), 'home widget with args preserved');
  console.log('ok 2 — home: with simple args is wrapped, args preserved');
}

// ── 3. Complex home: (nested parens) → snippet, file untouched ────────────────
{
  const main = `import 'package:flutter/material.dart';
class App extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Builder(builder: (context) => const Home()),
    );
  }
}
`;
  const { root, abs } = mkApp(main);
  const before = fs.readFileSync(abs, 'utf8');
  const res = quietly(() => wireFlutterOrb(root, { colors: NO_COLORS }));
  assert.strictEqual(res.status, 'printed', `expected printed, got ${res.status}`);
  assert.strictEqual(fs.readFileSync(abs, 'utf8'), before, 'complex layout left untouched');
  console.log('ok 3 — complex home: prints snippet, leaves file untouched');
}

// ── 4. No main.dart → printed/no-main ─────────────────────────────────────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fyo-fl-'));
  fs.writeFileSync(path.join(root, 'pubspec.yaml'), 'name: x\n');
  const res = quietly(() => wireFlutterOrb(root, { colors: NO_COLORS }));
  assert.strictEqual(res.status, 'printed');
  assert.strictEqual(res.reason, 'no-main');
  assert.strictEqual(findMainDart(root), null);
  console.log('ok 4 — no main.dart → snippet with no-main reason');
}

// ── 5. writeFlutterEnv writes a git-ignored dart-define file ──────────────────
{
  const { root } = mkApp("void main() {}\n");
  const r = writeFlutterEnv(root, { apiKey: KEY, apiUrl: 'http://127.0.0.1:8000' });
  assert.strictEqual(r.written, true);
  const json = JSON.parse(fs.readFileSync(path.join(root, 'fyodos.env.json'), 'utf8'));
  assert.strictEqual(json.FYODOS_API_KEY, KEY);
  assert.strictEqual(json.FYODOS_API_URL, 'http://127.0.0.1:8000', 'non-default URL persisted');
  assert.ok(gitignoreCovers(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), 'fyodos.env.json'), 'env file git-ignored');
  console.log('ok 5 — writeFlutterEnv writes git-ignored dart-define JSON');
}

// ── 6. buildWiredMain is a pure transform ─────────────────────────────────────
{
  const src = `import 'a';\nWidget build() => MaterialApp(home: const H());\n`;
  const wired = buildWiredMain(src);
  assert.ok(wired && wired.includes('home: FiodosAgent('), 'wrapped');
  assert.ok(wired.indexOf('FiodosAgent(') < wired.indexOf('child: const H()'), 'wrapper outside the home widget');
  console.log('ok 6 — buildWiredMain wraps the home widget purely');
}

console.log('\nwireFlutter: all tests passed');
