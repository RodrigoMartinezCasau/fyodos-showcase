'use strict';

/**
 * Deterministic tests for the env / secrets flow: .gitignore enforcement,
 * deploy-provider detection, the build-time-public classification, the write
 * plan, the deploy reminder text, and the end-to-end offerWriteEnv write (with
 * --write-env-yes). No network, no real Vercel CLI, no npm.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert');
const readline = require('readline');

const {
  offerWriteEnv,
  computeEnvWritePlan,
  ensureEnvGitIgnored,
  gitignoreCovers,
  detectDeployProvider,
  isBuildTimePublicFramework,
  deployReminderLines,
} = require('../src/writeEnv');

function mkapp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiodos-env-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const has = (dir, rel) => fs.existsSync(path.join(dir, rel));
const noop = () => {};
const silent = { log: noop, logDev: noop };

const KEY = 'fyd_TESTtoken_abcdefghijklmnopqrstuvwx';

// ── gitignoreCovers (pure) ────────────────────────────────────────────────────
function testGitignoreCovers() {
  assert.strictEqual(gitignoreCovers('.env\nnode_modules\n', '.env'), true);
  assert.strictEqual(gitignoreCovers('.env*\n', '.env'), true);
  assert.strictEqual(gitignoreCovers('*.local\n', '.env.local'), true);
  assert.strictEqual(gitignoreCovers('node_modules\ndist\n', '.env'), false);
  assert.strictEqual(gitignoreCovers('', '.env'), false);
  console.log('PASS gitignoreCovers recognizes common patterns');
}

// ── ensureEnvGitIgnored ───────────────────────────────────────────────────────
function testEnsureGitIgnoredCreates() {
  const dir = mkapp({ 'package.json': '{}' });
  const r = ensureEnvGitIgnored(dir, '.env');
  assert.strictEqual(r.created, true);
  assert.strictEqual(r.changed, true);
  assert.ok(read(dir, '.gitignore').includes('.env'));
  // Idempotent: a second run changes nothing.
  const r2 = ensureEnvGitIgnored(dir, '.env');
  assert.strictEqual(r2.changed, false);
  assert.strictEqual(r2.alreadyIgnored, true);
  console.log('PASS ensureEnvGitIgnored creates .gitignore and is idempotent');
}

function testEnsureGitIgnoredAppends() {
  const dir = mkapp({ 'package.json': '{}', '.gitignore': 'node_modules\ndist\n' });
  const r = ensureEnvGitIgnored(dir, '.env');
  assert.strictEqual(r.created, false);
  assert.strictEqual(r.changed, true);
  const gi = read(dir, '.gitignore');
  assert.ok(gi.includes('node_modules')); // preserved
  assert.ok(gitignoreCovers(gi, '.env')); // now covered
  console.log('PASS ensureEnvGitIgnored appends without clobbering existing rules');
}

function testEnsureGitIgnoredNoopWhenCovered() {
  const dir = mkapp({ 'package.json': '{}', '.gitignore': '.env*\n' });
  const r = ensureEnvGitIgnored(dir, '.env');
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.alreadyIgnored, true);
  console.log('PASS ensureEnvGitIgnored is a no-op when already covered');
}

// ── detectDeployProvider ──────────────────────────────────────────────────────
function testDetectProvider() {
  const vlinked = mkapp({ 'package.json': '{}', '.vercel/project.json': '{"projectId":"x"}' });
  assert.deepStrictEqual(detectDeployProvider(vlinked), { provider: 'vercel', linked: true });

  const vcfg = mkapp({ 'package.json': '{}', 'vercel.json': '{}' });
  assert.deepStrictEqual(detectDeployProvider(vcfg), { provider: 'vercel', linked: false });

  const net = mkapp({ 'package.json': '{}', 'netlify.toml': '' });
  assert.strictEqual(detectDeployProvider(net).provider, 'netlify');

  const none = mkapp({ 'package.json': '{}' });
  assert.strictEqual(detectDeployProvider(none).provider, null);
  console.log('PASS detectDeployProvider identifies vercel(linked/cfg)/netlify/none');
}

// ── isBuildTimePublicFramework ────────────────────────────────────────────────
function testBuildTimePublic() {
  assert.strictEqual(isBuildTimePublicFramework('vite'), true);
  assert.strictEqual(isBuildTimePublicFramework('next'), true);
  assert.strictEqual(isBuildTimePublicFramework('angular'), false);
  assert.strictEqual(isBuildTimePublicFramework(null), false);
  console.log('PASS isBuildTimePublicFramework: vite/next yes, angular/none no');
}

// ── computeEnvWritePlan carries framework + keyVar ────────────────────────────
function testWritePlan() {
  const dir = mkapp({ 'package.json': JSON.stringify({ dependencies: { vite: '^5', vue: '^3' } }) });
  const plan = computeEnvWritePlan(dir, KEY, 'https://api.fiodos.com');
  assert.strictEqual(plan.kind, 'writable');
  assert.strictEqual(plan.framework, 'vite');
  assert.strictEqual(plan.keyVar, 'VITE_FYODOS_API_KEY');
  assert.ok(plan.envLines.some((l) => l === `VITE_FYODOS_API_KEY=${KEY}`));
  console.log('PASS computeEnvWritePlan (vite) carries framework + keyVar');
}

// ── deployReminderLines content (numbered, stack-aware step-by-step) ──────────
function testDeployReminderLines() {
  const vercel = deployReminderLines({ provider: 'vercel', keyVar: 'VITE_FYODOS_API_KEY', apiKey: KEY }).join('\n');
  // Numbered recipe: copy → paste in provider env panel → redeploy.
  assert.ok(/Step 1/.test(vercel), 'has Step 1');
  assert.ok(/Step 2/.test(vercel), 'has Step 2');
  assert.ok(/Step 3/.test(vercel), 'has Step 3');
  // Step 2 is generic — never assumes the host is Vercel.
  assert.ok(/your hosting provider/i.test(vercel), 'Step 2 is provider-agnostic');
  assert.ok(!/Step 2 — In Vercel/.test(vercel), 'Step 2 does not lead with a provider name');
  // Detected provider may appear only as an optional e.g. tip.
  assert.ok(/\(e\.g\. Vercel:/.test(vercel), 'detected provider is an optional tip');
  assert.ok(new RegExp(`Name:\\s+VITE_FYODOS_API_KEY`).test(vercel), 'shows the var name');
  assert.ok(vercel.includes(KEY), 'shows the key value to copy');
  assert.ok(!/vercel env add/.test(vercel), 'does NOT instruct a CLI command we cannot run');

  const unknown = deployReminderLines({ provider: null, keyVar: 'VITE_FYODOS_API_KEY', apiKey: KEY }).join('\n');
  assert.ok(/Step 1/.test(unknown) && /Step 3/.test(unknown), 'generic provider still numbered');
  assert.ok(/your hosting provider/i.test(unknown), 'generic provider phrasing');
  assert.ok(!/\(e\.g\./.test(unknown), 'no provider tip when none detected');
  assert.ok(unknown.includes(KEY), 'generic provider shows the key');
  console.log('PASS deployReminderLines is a numbered, provider-agnostic step-by-step (no CLI cmd)');
}

// ── offerWriteEnv writes, gitignores, and queues a deploy reminder (no vercel) ─
async function testOfferWriteEnvWritesAndIgnores() {
  const dir = mkapp({ 'package.json': JSON.stringify({ dependencies: { vite: '^5', react: '^18' } }) });
  const res = await offerWriteEnv({
    appRoot: dir,
    apiKey: KEY,
    apiUrl: 'https://api.fiodos.com',
    assumeYes: true,
    log: noop,
    logDev: noop,
  });
  assert.strictEqual(res.status, 'written');
  // Secret written to the env file…
  assert.ok(has(dir, '.env'));
  assert.ok(read(dir, '.env').includes(`VITE_FYODOS_API_KEY=${KEY}`));
  // …and the env file is now git-ignored.
  assert.ok(has(dir, '.gitignore'));
  assert.ok(gitignoreCovers(read(dir, '.gitignore'), '.env'));
  // No deploy provider → a clear reminder is queued (orb-invisible-in-prod guard).
  assert.ok(res.deploy && res.deploy.reminder === true);
  assert.strictEqual(res.deploy.provider, null);
  console.log('PASS offerWriteEnv writes secret, enforces .gitignore, queues deploy reminder');
}

// ── offerWriteEnv never leaves the key un-ignored even if .gitignore lacked it ─
async function testOfferWriteEnvAddsToExistingGitignore() {
  const dir = mkapp({
    'package.json': JSON.stringify({ dependencies: { next: '^14', react: '^18' } }),
    '.gitignore': 'node_modules\n',
  });
  const res = await offerWriteEnv({
    appRoot: dir,
    apiKey: KEY,
    apiUrl: 'https://api.fiodos.com',
    assumeYes: true,
    log: noop,
    logDev: noop,
  });
  assert.strictEqual(res.status, 'written');
  assert.ok(read(dir, '.env.local').includes(`NEXT_PUBLIC_FYODOS_API_KEY=${KEY}`));
  assert.ok(gitignoreCovers(read(dir, '.gitignore'), '.env.local'));
  console.log('PASS offerWriteEnv (next) writes .env.local and ensures it is git-ignored');
}

// ── Expo / React Native: EXPO_PUBLIC_* in .env, git-ignored, no deploy step ───
async function testOfferWriteEnvExpo() {
  const dir = mkapp({
    'package.json': JSON.stringify({ dependencies: { expo: '~54.0.0', 'expo-router': '~6.0.0', 'react-native': '0.81.5' } }),
  });
  const plan = computeEnvWritePlan(dir, KEY, 'https://api.fiodos.com');
  assert.strictEqual(plan.framework, 'expo');
  assert.strictEqual(plan.keyVar, 'EXPO_PUBLIC_FYODOS_API_KEY');

  const res = await offerWriteEnv({
    appRoot: dir,
    apiKey: KEY,
    apiUrl: 'https://api.fiodos.com',
    assumeYes: true,
    log: noop,
    logDev: noop,
  });
  assert.strictEqual(res.status, 'written');
  assert.ok(read(dir, '.env').includes(`EXPO_PUBLIC_FYODOS_API_KEY=${KEY}`), 'EXPO_PUBLIC key written to .env');
  assert.ok(gitignoreCovers(read(dir, '.gitignore'), '.env'), '.env git-ignored');
  // EAS production step is printed by the CLI, not via the web deploy reminder.
  assert.strictEqual(res.deploy, null, 'expo uses the CLI EAS reminder, not the web provider one');
  console.log('PASS offerWriteEnv (expo) writes EXPO_PUBLIC key, git-ignores .env, no web deploy reminder');
}

/**
 * Drive offerWriteEnv through a SIMULATED TTY with scripted answers, capturing
 * every prompt question.
 */
async function withScriptedPrompts(answers, fn) {
  const asked = [];
  const realCreate = readline.createInterface;
  const realTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  let i = 0;
  try {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    readline.createInterface = () => ({
      question: (q, cb) => {
        asked.push(q);
        cb(answers[i++] ?? 'no');
      },
      close: () => {},
    });
    const result = await fn();
    return { asked, result };
  } finally {
    readline.createInterface = realCreate;
    if (realTTY) Object.defineProperty(process.stdin, 'isTTY', realTTY);
  }
}

// The provider key is NEVER prompted and NEVER auto-pushed: only the local .env
// is asked about; the provider step is a printed reminder at the end.
async function testNoDeployPromptOnlyReminder() {
  const dir = mkapp({ 'package.json': JSON.stringify({ dependencies: { vite: '^5', react: '^18' } }) });
  const { asked, result } = await withScriptedPrompts(['yes'], () =>
    offerWriteEnv({
      appRoot: dir,
      apiKey: KEY,
      apiUrl: 'https://api.fiodos.com',
      assumeYes: false,
      log: noop,
      logDev: noop,
    }),
  );
  // Exactly ONE prompt — the local .env key. No deploy-provider prompt.
  assert.strictEqual(asked.length, 1, `expected 1 prompt, got ${asked.length}`);
  assert.ok(/Add your API key to/.test(asked[0]), 'the only prompt is the local .env key');
  // Reminder still queued so the orb is not invisible in production…
  assert.strictEqual(result.status, 'written');
  assert.ok(result.deploy && result.deploy.reminder === true);
  // …and we never claim to have touched the provider.
  assert.ok(!result.deploy.automated, 'never reports auto-pushing to the provider');
  assert.ok(!result.deploy.wantedAuto, 'no auto-attempt state lingers');
  console.log('PASS provider key is reminder-only — never prompted, never auto-pushed');
}

(async () => {
  testGitignoreCovers();
  testEnsureGitIgnoredCreates();
  testEnsureGitIgnoredAppends();
  testEnsureGitIgnoredNoopWhenCovered();
  testDetectProvider();
  testBuildTimePublic();
  testWritePlan();
  testDeployReminderLines();
  await testOfferWriteEnvWritesAndIgnores();
  await testOfferWriteEnvAddsToExistingGitignore();
  await testOfferWriteEnvExpo();
  await testNoDeployPromptOnlyReminder();
  console.log('ALL writeEnv tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
