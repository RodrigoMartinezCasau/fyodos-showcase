/**
 * wireFlutter — auto-mount the Fiodos orb in a Flutter app, mirroring the web
 * and React Native orb auto-mounts (wireWeb.js / wireReactNative.js) adapted to
 * Dart / Flutter.
 *
 * The Flutter SDK already exposes a true one-line drop-in, FiodosAgent, that
 * self-fetches the published manifest by API key, fetches the dashboard orb
 * theme, posts the orb-seen heartbeat, and renders the themed orb. So there is
 * no manifest file to write (unlike RN): we only
 *   1. add `import 'package:fiodos_flutter/fiodos_flutter.dart';`, and
 *   2. wrap the app's `home:` widget with FiodosAgent (reading the key from a
 *      compile-time --dart-define, never hardcoding the secret in source).
 *
 * Edits are idempotent and reversible (FYODOS:ORB markers). The orb must live
 * INSIDE MaterialApp/CupertinoApp (it needs a Directionality/Material ancestor),
 * which is exactly where `home:` is — so we wrap there, not at runApp(). When the
 * `home:` value is not a simple widget expression we DON'T touch the file: we
 * print a short snippet instead (like the web/RN paths), and the caller then
 * skips the install proof so the dashboard waits for the runtime heartbeat.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { ensureEnvGitIgnored } = require('./writeEnv');

const IMPORT_START = '// FYODOS:ORB:START (auto-generated — safe to remove)';
const IMPORT_END = '// FYODOS:ORB:END';
const SDK_IMPORT = "import 'package:fiodos_flutter/fiodos_flutter.dart';";

const MAIN_CANDIDATES = ['lib/main.dart'];

function findMainDart(appRoot) {
  for (const rel of MAIN_CANDIDATES) {
    const abs = path.join(appRoot, rel);
    if (fs.existsSync(abs)) return { abs, rel };
  }
  return null;
}

function insertImportAfterLastImport(source, block) {
  const lines = source.split('\n');
  let lastImport = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*import\s+['"]/.test(lines[i])) lastImport = i;
  }
  if (lastImport === -1) return `${block}\n${source}`;
  lines.splice(lastImport + 1, 0, block);
  return lines.join('\n');
}

/**
 * Match the `home:` value when it is a single, simple widget constructor — the
 * common case (e.g. `home: const TodoListScreen()`, `home: MyHomePage(title: 'x')`).
 * We deliberately do NOT try to parse arbitrarily nested expressions: a complex
 * home (Builder, ternaries, nested constructors with parens) falls back to the
 * snippet, never to a risky edit. Group 1 = the whole widget expr (with const).
 */
const HOME_RE = /home:\s*((?:const\s+)?[A-Za-z_][\w.]*\([^()]*\))/;

/** Build the wired main.dart, or null when home: is not a simple widget. */
function buildWiredMain(source) {
  if (!HOME_RE.test(source)) return null;
  const wrapped = source.replace(HOME_RE, (full, widget) =>
    'home: FiodosAgent(\n' +
    "        apiKey: const String.fromEnvironment('FYODOS_API_KEY'),\n" +
    "        baseUrl: const String.fromEnvironment('FYODOS_API_URL', defaultValue: kFiodosDefaultApiUrl),\n" +
    `        child: ${widget},\n` +
    '      )',
  );
  const importBlock = `${IMPORT_START}\n${SDK_IMPORT}\n${IMPORT_END}`;
  return insertImportAfterLastImport(wrapped, importBlock);
}

/** Copy-paste snippet shown when we cannot safely auto-wrap. */
function mountSnippet() {
  return (
    `${SDK_IMPORT}\n\n` +
    `// Wrap your app's home widget (inside MaterialApp) with FiodosAgent:\n` +
    `home: FiodosAgent(\n` +
    `  apiKey: const String.fromEnvironment('FYODOS_API_KEY'),\n` +
    `  child: const MyHomePage(),\n` +
    `),`
  );
}

function printSnippet(colors, rel, reason) {
  const { blue, cyan, dim, reset } = colors;
  console.error(`\n${cyan}◉${reset} ${blue}Fiodos${reset} · ${dim}add the orb to ${rel || 'lib/main.dart'}${reason ? ` (${reason})` : ''}:${reset}`);
  console.error(mountSnippet());
  console.error(`${dim}Then re-run analyze — the mount becomes automatic once home: is a simple widget.${reset}\n`);
}

/**
 * Auto-mount the orb into a Flutter app.
 * @returns {{status:'added'|'already'|'printed'|'skipped', file?:string, reason?:string}}
 */
function wireFlutterOrb(appRoot, { colors = {}, noWire = false } = {}) {
  const main = findMainDart(appRoot);
  if (!main) {
    printSnippet(colors, null, 'no lib/main.dart found');
    return { status: 'printed', reason: 'no-main' };
  }

  let source;
  try {
    source = fs.readFileSync(main.abs, 'utf8');
  } catch (e) {
    return { status: 'skipped', reason: `read-failed: ${e.message}` };
  }

  if (source.includes('FiodosAgent(') || source.includes('FYODOS:ORB')) {
    return { status: 'already', file: main.rel };
  }

  if (noWire) return { status: 'skipped', reason: 'no-wire' };

  const wired = buildWiredMain(source);
  if (!wired) {
    printSnippet(colors, main.rel, 'home: is not a simple widget');
    return { status: 'printed', file: main.rel, reason: 'unrecognized-home' };
  }

  try {
    fs.writeFileSync(main.abs, wired);
  } catch (e) {
    return { status: 'skipped', reason: `write-failed: ${e.message}` };
  }
  return { status: 'added', file: main.rel };
}

/**
 * Flutter env: there is no auto-loaded `.env`. The compile-time keys are passed
 * with --dart-define; the convention for a checked-in run command is a
 * dart-define-from-file JSON. We write a git-ignored `fyodos.env.json` holding
 * the publishable key + URL so `flutter run --dart-define-from-file=fyodos.env.json`
 * works locally, and the secret never lands in committed source.
 * @returns {{file:string, written:boolean, gitignore:object}}
 */
function writeFlutterEnv(appRoot, { apiKey, apiUrl, defaultApiUrl }) {
  if (!apiKey) return { file: null, written: false, gitignore: null };
  const rel = 'fyodos.env.json';
  const abs = path.join(appRoot, rel);
  const payload = { FYODOS_API_KEY: apiKey };
  if (apiUrl && apiUrl !== defaultApiUrl) payload.FYODOS_API_URL = apiUrl;
  fs.writeFileSync(abs, `${JSON.stringify(payload, null, 2)}\n`);
  const gitignore = ensureEnvGitIgnored(appRoot, rel);
  return { file: rel, written: true, gitignore };
}

function reportFlutterWire(result, colors = {}, { quiet = false } = {}) {
  const { blue, cyan, dim, reset } = colors;
  if (!result) return;
  if (result.status === 'added') {
    console.error(`\n${cyan}◉${reset} ${blue}Fiodos${reset} · orb mounted in ${result.file}`);
  } else if (result.status === 'already' && !quiet) {
    console.error(`\n${cyan}◉${reset} ${blue}Fiodos${reset} · ${dim}orb already mounted in ${result.file}${reset}`);
  }
}

module.exports = {
  wireFlutterOrb,
  writeFlutterEnv,
  reportFlutterWire,
  // exported for tests
  buildWiredMain,
  findMainDart,
  HOME_RE,
};
