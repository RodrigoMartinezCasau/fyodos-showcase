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
  const plan = computeEnvWritePlan(dir, KEY, 'https://api.fyodos.com', 'https://api.fyodos.com');
  assert.strictEqual(plan.kind, 'writable');
  assert.strictEqual(plan.framework, 'vite');
  assert.strictEqual(plan.keyVar, 'VITE_FYODOS_API_KEY');
  assert.ok(plan.envLines.some((l) => l === `VITE_FYODOS_API_KEY=${KEY}`));
  console.log('PASS computeEnvWritePlan (vite) carries framework + keyVar');
}

// ── deployReminderLines content ───────────────────────────────────────────────
function testDeployReminderLines() {
  const vercel = deployReminderLines({ provider: 'vercel', keyVar: 'VITE_FYODOS_API_KEY', apiKey: KEY }).join('\n');
  assert.ok(/PUBLISHABLE client key/.test(vercel));
  assert.ok(/BUILD time/.test(vercel));
  assert.ok(/vercel env add VITE_FYODOS_API_KEY production/.test(vercel));
  assert.ok(vercel.includes(KEY));

  const unknown = deployReminderLines({ provider: null, keyVar: 'VITE_FYODOS_API_KEY', apiKey: KEY }).join('\n');
  assert.ok(/deploy provider/i.test(unknown));
  assert.ok(unknown.includes(`VITE_FYODOS_API_KEY=${KEY}`));
  console.log('PASS deployReminderLines explains publishable + build-time + provider steps');
}

// ── offerWriteEnv writes, gitignores, and queues a deploy reminder (no vercel) ─
async function testOfferWriteEnvWritesAndIgnores() {
  const dir = mkapp({ 'package.json': JSON.stringify({ dependencies: { vite: '^5', react: '^18' } }) });
  const res = await offerWriteEnv({
    appRoot: dir,
    apiKey: KEY,
    apiUrl: 'https://api.fyodos.com',
    defaultApiUrl: 'https://api.fyodos.com',
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
    apiUrl: 'https://api.fyodos.com',
    defaultApiUrl: 'https://api.fyodos.com',
    assumeYes: true,
    log: noop,
    logDev: noop,
  });
  assert.strictEqual(res.status, 'written');
  assert.ok(read(dir, '.env.local').includes(`NEXT_PUBLIC_FYODOS_API_KEY=${KEY}`));
  assert.ok(gitignoreCovers(read(dir, '.gitignore'), '.env.local'));
  console.log('PASS offerWriteEnv (next) writes .env.local and ensures it is git-ignored');
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
  console.log('ALL writeEnv tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
