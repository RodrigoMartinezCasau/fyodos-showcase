/**
 * writeEnv — consent-based handling of the orb's environment variables.
 *
 * The orb must read the SAME key/URL the CLI published with. We always ASK before
 * writing (independent of --yes, which only skips orb/handler prompts). Sensitive
 * values follow ONE consistent flow:
 *
 *   1. Local env file  — "add it automatically, or add it yourself?" (yes/no).
 *      · yes → written to the framework's env file, which we ALSO ensure is in
 *              .gitignore so the secret never reaches GitHub.
 *      · no  → a copy-paste reminder is shown at the very END of the run.
 *   2. Deploy provider — the SAME yes/no flow for the build-time public key
 *      (VITE_/NEXT_PUBLIC_), because that value is inlined at BUILD time: if it is
 *      only in the (gitignored, never-pushed) local env and NOT in the provider,
 *      the production build ships WITHOUT it and the orb never appears. We detect
 *      a linked Vercel project and offer to push it automatically; otherwise we
 *      warn clearly and print exactly what to add where.
 *
 * SECURITY: no secret is ever hardcoded into committed source. The orb key
 * (`fyd_…`) is a PUBLISHABLE client key (safe inside the frontend bundle), but it
 * still must exist in the build environment — which is why it goes through env
 * vars and the deploy-provider step, never into the repo.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Decide which env files + variable names the detected framework uses.
 */
function resolveEnvPlan(appRoot) {
  const pkg = readJsonSafe(path.join(appRoot, 'package.json'));
  const has = (rel) => fs.existsSync(path.join(appRoot, rel));
  if (!pkg && !has('angular.json')) {
    return { framework: null, file: null, candidates: [], keyVar: null, urlVar: null };
  }
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};

  if (deps.next) {
    return {
      framework: 'next',
      file: '.env.local',
      candidates: ['.env.development.local', '.env.local', '.env.development', '.env'],
      keyVar: 'NEXT_PUBLIC_FYODOS_API_KEY',
      urlVar: 'NEXT_PUBLIC_FYODOS_API_URL',
    };
  }
  if (deps['@angular/core'] || has('angular.json')) {
    return { framework: 'angular', file: null, candidates: [], keyVar: null, urlVar: null };
  }
  if (
    deps['@sveltejs/kit'] ||
    deps.svelte ||
    deps.vue ||
    deps['@vitejs/plugin-vue'] ||
    deps.vite ||
    deps['@vitejs/plugin-react'] ||
    deps['react-scripts']
  ) {
    return {
      framework: 'vite',
      file: '.env',
      candidates: ['.env.development.local', '.env.development', '.env.local', '.env'],
      keyVar: 'VITE_FYODOS_API_KEY',
      urlVar: 'VITE_FYODOS_API_URL',
    };
  }
  return { framework: null, file: null, candidates: [], keyVar: null, urlVar: null };
}

/** Frameworks whose public env vars are INLINED at build time (need provider env). */
function isBuildTimePublicFramework(framework) {
  return framework === 'vite' || framework === 'next';
}

function findEffectiveVar(appRoot, candidates, name) {
  for (const rel of candidates) {
    const filePath = path.join(appRoot, rel);
    if (!fs.existsSync(filePath)) continue;
    const lines = fs.readFileSync(filePath, 'utf8').replace(/\n$/, '').split('\n');
    const value = readEnvVar(lines, name);
    if (value !== undefined) return { file: rel, value };
  }
  return null;
}

function readEnvVar(lines, name) {
  const re = new RegExp(`^\\s*${name}\\s*=(.*)$`);
  for (const line of lines) {
    const m = line.match(re);
    if (m) return stripQuotes(m[1].trim());
  }
  return undefined;
}

function stripQuotes(v) {
  return v.replace(/^['"]/, '').replace(/['"]$/, '');
}

function upsertEnvVar(lines, name, value) {
  const re = new RegExp(`^\\s*${name}\\s*=`);
  const idx = lines.findIndex((l) => re.test(l));
  if (idx >= 0) {
    lines[idx] = `${name}=${value}`;
    return lines;
  }
  lines.push(`${name}=${value}`);
  return lines;
}

function maskKey(key) {
  if (!key) return '';
  return key.length <= 14 ? key : `${key.slice(0, 12)}…`;
}

function askYesNo(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(false);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^(y|yes|s|si|sí)/i.test((answer || '').trim()));
    });
  });
}

/** True if `.gitignore` already keeps `fileName` (or a glob covering it) out of git. */
function isGitIgnored(appRoot, fileName) {
  const gi = path.join(appRoot, '.gitignore');
  if (!fs.existsSync(gi)) return false;
  try {
    const content = fs.readFileSync(gi, 'utf8');
    return gitignoreCovers(content, fileName);
  } catch {
    return false;
  }
}

/** Pure: does this .gitignore content keep `fileName` out of git? */
function gitignoreCovers(content, fileName) {
  const patterns = content.split('\n').map((l) => l.trim());
  const glob = fileName.endsWith('.local') ? '*.local' : '.env*';
  return patterns.some(
    (p) =>
      p === fileName ||
      p === `/${fileName}` ||
      p === '.env*' ||
      p === '.env.*' ||
      p === '*.local' ||
      p === glob ||
      p === fileName.replace(/^\.env/, '.env*'),
  );
}

/**
 * Guarantee the secret-bearing env file is git-ignored (never pushed to GitHub).
 * Appends a covering pattern to `.gitignore` (creating it when absent) when the
 * file is not already ignored. Idempotent. Returns what happened.
 */
function ensureEnvGitIgnored(appRoot, fileName) {
  const gi = path.join(appRoot, '.gitignore');
  const exists = fs.existsSync(gi);
  let content = '';
  try {
    content = exists ? fs.readFileSync(gi, 'utf8') : '';
  } catch {
    content = '';
  }
  if (exists && gitignoreCovers(content, fileName)) {
    return { changed: false, created: false, alreadyIgnored: true, pattern: null };
  }
  const pattern = fileName.endsWith('.local') ? '*.local' : fileName;
  const header = '# Fiodos: keep local secrets out of git';
  const prefix = content.length === 0 ? '' : content.endsWith('\n') ? '' : '\n';
  const block = `${prefix}${content.length ? '\n' : ''}${header}\n${pattern}\n`;
  try {
    fs.writeFileSync(gi, content + block);
    return { changed: true, created: !exists, alreadyIgnored: false, pattern };
  } catch {
    return { changed: false, created: false, alreadyIgnored: false, pattern, error: true };
  }
}

/** Detect a deploy provider (and whether a Vercel project is already linked). */
function detectDeployProvider(appRoot) {
  const has = (rel) => fs.existsSync(path.join(appRoot, rel));
  if (has('.vercel/project.json') || has('vercel.json')) {
    return { provider: 'vercel', linked: has('.vercel/project.json') };
  }
  if (has('netlify.toml') || has('.netlify')) {
    return { provider: 'netlify', linked: false };
  }
  if (has('wrangler.toml')) {
    return { provider: 'cloudflare', linked: false };
  }
  return { provider: null, linked: false };
}

function commandExists(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort push of a single var to a LINKED Vercel project, non-interactively,
 * across the given environments. Never hangs: only runs when the project is
 * already linked and the CLI resolves, each call bounded by a timeout. Returns a
 * per-environment result; failures (incl. "already exists") fall back to the
 * manual reminder.
 */
function attemptVercelEnvAdd(appRoot, name, value, environments) {
  if (!fs.existsSync(path.join(appRoot, '.vercel', 'project.json'))) {
    return { attempted: false, reason: 'not-linked' };
  }
  let bin = null;
  let pre = [];
  if (commandExists('vercel')) {
    bin = 'vercel';
  } else if (commandExists('npx')) {
    bin = 'npx';
    pre = ['--no-install', 'vercel'];
  } else {
    return { attempted: false, reason: 'no-cli' };
  }
  const results = [];
  for (const env of environments) {
    try {
      execFileSync(bin, [...pre, 'env', 'add', name, env], {
        cwd: appRoot,
        input: `${value}\n`,
        stdio: ['pipe', 'ignore', 'pipe'],
        timeout: 60_000,
      });
      results.push({ env, ok: true });
    } catch (e) {
      const msg = String((e && (e.stderr || e.message)) || '').split('\n')[0];
      results.push({ env, ok: false, msg });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return { attempted: true, ok: okCount > 0, okCount, results };
}

/**
 * Compute where the key/URL would go and what would change — no writes, no prompts.
 * @returns {object|null} null when there is nothing to do (already aligned / no key).
 */
function computeEnvWritePlan(appRoot, apiKey, apiUrl, defaultApiUrl) {
  if (!apiKey) return null;

  const plan = resolveEnvPlan(appRoot);
  if (!plan.file && plan.framework !== 'angular') {
    return {
      kind: 'manual-unknown',
      framework: plan.framework,
      keyVar: 'NEXT_PUBLIC_FYODOS_API_KEY or VITE_FYODOS_API_KEY',
      urlVar: 'NEXT_PUBLIC_FYODOS_API_URL or VITE_FYODOS_API_URL',
      apiKey,
      apiUrl,
    };
  }
  if (plan.framework === 'angular') {
    return {
      kind: 'manual-angular',
      file: 'src/environments/environment.ts',
      apiKey,
      apiUrl,
    };
  }

  const candidates = plan.candidates && plan.candidates.length ? plan.candidates : [plan.file];
  const effectiveKey = findEffectiveVar(appRoot, candidates, plan.keyVar);
  const effectiveUrl = findEffectiveVar(appRoot, candidates, plan.urlVar);
  const currentKey = effectiveKey ? effectiveKey.value : undefined;
  const currentUrl = effectiveUrl ? effectiveUrl.value : undefined;
  const targetRel = (effectiveKey && effectiveKey.file) || (effectiveUrl && effectiveUrl.file) || plan.file;
  const wantUrl = apiUrl && apiUrl !== defaultApiUrl ? apiUrl : null;
  const urlNeedsFix = currentUrl !== undefined && currentUrl !== apiUrl;
  const keyMatches = currentKey === apiKey;
  const urlOk = !urlNeedsFix && (wantUrl ? currentUrl === wantUrl : true);

  if (keyMatches && urlOk) {
    return { kind: 'aligned', targetRel, plan, framework: plan.framework, keyVar: plan.keyVar, apiKey };
  }

  const envLines = [`${plan.keyVar}=${apiKey}`];
  if (wantUrl) envLines.push(`${plan.urlVar}=${wantUrl}`);
  else if (urlNeedsFix) envLines.push(`${plan.urlVar}=${apiUrl}`);

  return {
    kind: 'writable',
    plan,
    framework: plan.framework,
    keyVar: plan.keyVar,
    urlVar: plan.urlVar,
    targetRel,
    absPath: path.join(appRoot, targetRel),
    envLines,
    keyMatches,
    urlOk,
    wantUrl,
    urlNeedsFix,
    currentKey,
    currentUrl,
    apiKey,
    apiUrl,
  };
}

/** Lines explaining how to set the build-time public key in the deploy provider. */
function deployReminderLines(deploy) {
  const { keyVar, apiKey, provider } = deploy;
  const lines = [];
  lines.push(
    `${keyVar} is a PUBLISHABLE client key (safe in your frontend bundle), but it is`,
  );
  lines.push(
    "read at BUILD time — it must also live in your deploy provider's env, or the",
  );
  lines.push('production build ships without it and the orb will NOT appear.');
  lines.push('');
  if (provider === 'vercel') {
    lines.push('Vercel — add it to Production, Preview and Development:');
    lines.push(`    vercel env add ${keyVar} production`);
    lines.push(`    vercel env add ${keyVar} preview`);
    lines.push(`    vercel env add ${keyVar} development`);
    lines.push(`  (value: ${apiKey})`);
    lines.push('  …or Project → Settings → Environment Variables in the dashboard,');
    lines.push('  then redeploy.');
  } else if (provider === 'netlify') {
    lines.push('Netlify — Site settings → Environment variables, then redeploy:');
    lines.push(`    ${keyVar}=${apiKey}`);
  } else if (provider === 'cloudflare') {
    lines.push('Cloudflare Pages — Settings → Environment variables, then redeploy:');
    lines.push(`    ${keyVar}=${apiKey}`);
  } else {
    lines.push('Your deploy provider (Vercel / Netlify / Cloudflare / …) — add it in');
    lines.push('its Environment Variables panel and redeploy:');
    lines.push(`    ${keyVar}=${apiKey}`);
  }
  return lines;
}

/** Branded reminder shown at the END (declined local write and/or deploy step). */
function printEnvManualReminder(result, { logUser, logDev }) {
  if (!result) return;
  const writePlan = result.writePlan || (result.kind ? result : null);
  const deploy = result.deploy || null;
  const declinedLocal =
    result.status === 'declined by user' || result.status === 'manual';

  if (writePlan && writePlan.kind !== 'aligned' && declinedLocal) {
    logUser('Add your API key to your environment file (last step)');

    if (writePlan.kind === 'manual-angular') {
      console.log(`  Angular: open ${writePlan.file} and set fyodosApiKey / fyodosApiUrl:`);
      console.log(`    fyodosApiKey: '${writePlan.apiKey}'`);
      console.log(`    fyodosApiUrl: '${writePlan.apiUrl}'`);
    } else if (writePlan.kind === 'manual-unknown') {
      console.log('  Add to your project .env (use NEXT_PUBLIC_ for Next, VITE_ for Vite):');
      console.log(`    ${writePlan.keyVar}=${writePlan.apiKey}`);
      if (writePlan.apiUrl && writePlan.apiUrl !== 'https://api.fyodos.com') {
        console.log(`    ${writePlan.urlVar}=${writePlan.apiUrl}`);
      }
    } else {
      console.log(`  File: ${writePlan.absPath}`);
      console.log('  Add these lines:');
      for (const line of writePlan.envLines) console.log(`    ${line}`);
    }
    if (logDev) logDev(`[write-env] manual reminder for ${writePlan.targetRel || writePlan.file || 'env'}`);
  }

  if (deploy && deploy.reminder) {
    logUser('Set the orb key in your deploy provider (or the orb is invisible in production)');
    for (const line of deployReminderLines(deploy)) console.log(line ? `  ${line}` : '');
    if (logDev) logDev(`[write-env] deploy reminder for provider=${deploy.provider || 'unknown'}`);
  }
}

/**
 * Ask consent and optionally write. Returns { status, writePlan, deploy }.
 * `assumeYes` comes from --write-env-yes only (NOT global --yes).
 */
async function offerWriteEnv({ appRoot, apiKey, apiUrl, defaultApiUrl, assumeYes, log, logDev: devLog }) {
  const writePlan = computeEnvWritePlan(appRoot, apiKey, apiUrl, defaultApiUrl);
  if (!writePlan) return { status: 'skipped (no API key)', writePlan: null, deploy: null };
  if (writePlan.kind === 'aligned') {
    log(`Your environment already uses the same API key as this project. Nothing to change.`);
    // Even when the local env is aligned, production may still be missing the key.
    const deploy = await offerDeployEnv({ appRoot, writePlan, assumeYes, log, devLog });
    return { status: 'already aligned', writePlan, deploy };
  }

  const targetLabel =
    writePlan.kind === 'manual-angular'
      ? writePlan.file
      : writePlan.kind === 'manual-unknown'
        ? 'your .env file'
        : writePlan.targetRel;

  let proceed = assumeYes;
  if (!proceed) {
    proceed = await askYesNo(`◉ Fiodos · Add your API key to ${targetLabel}? [yes/no] `);
  }

  if (!proceed) {
    const deploy = await offerDeployEnv({ appRoot, writePlan, assumeYes, log, devLog });
    return { status: 'declined by user', writePlan, deploy };
  }

  if (writePlan.kind === 'manual-angular' || writePlan.kind === 'manual-unknown') {
    log('Could not write automatically for this framework — see the reminder at the end.');
    const deploy = await offerDeployEnv({ appRoot, writePlan, assumeYes, log, devLog });
    return { status: 'manual', writePlan, deploy };
  }

  const { plan, targetRel, keyMatches, wantUrl, urlNeedsFix, apiKey: key, apiUrl: url } = writePlan;
  const filePath = writePlan.absPath;
  const exists = fs.existsSync(filePath);
  const raw = exists ? fs.readFileSync(filePath, 'utf8') : '';
  const lines = raw.length ? raw.replace(/\n$/, '').split('\n') : [];

  let out = lines.slice();
  if (!keyMatches) out = upsertEnvVar(out, plan.keyVar, key);
  if (wantUrl) {
    out = upsertEnvVar(out, plan.urlVar, wantUrl);
  } else if (urlNeedsFix) {
    out = upsertEnvVar(out, plan.urlVar, url);
  }
  fs.writeFileSync(filePath, `${out.join('\n')}\n`);
  log(`API key saved to ${targetRel}.`);

  // SECURITY: guarantee the secret-bearing file is git-ignored (never pushed).
  const gi = ensureEnvGitIgnored(appRoot, targetRel);
  if (gi.changed) {
    log(`Added ${gi.pattern} to .gitignore so your key is never pushed to GitHub.`);
  } else if (gi.alreadyIgnored) {
    if (devLog) devLog(`[write-env] ${targetRel} already covered by .gitignore`);
  } else if (gi.error) {
    log(`Heads up: could not update .gitignore — make sure ${targetRel} is git-ignored.`);
  }

  const deploy = await offerDeployEnv({ appRoot, writePlan, assumeYes, log, devLog });
  return { status: 'written', writePlan, deploy };
}

/**
 * Deploy-provider step for the build-time PUBLIC key (VITE_/NEXT_PUBLIC_). Same
 * yes/no flow as the local write. When a linked Vercel project is detected and
 * the user consents, the key is pushed automatically; otherwise (declined, no
 * provider, non-TTY, or failure) a clear reminder is queued for the end.
 */
async function offerDeployEnv({ appRoot, writePlan, assumeYes, log, devLog }) {
  const framework = writePlan.framework;
  const keyVar = writePlan.keyVar;
  const apiKey = writePlan.apiKey;
  if (!apiKey || !keyVar || !isBuildTimePublicFramework(framework)) {
    return null; // Angular / unknown handle their own manual reminders.
  }
  const det = detectDeployProvider(appRoot);
  const base = { provider: det.provider, linked: det.linked, keyVar, apiKey };

  // Only Vercel can be automated here, and only when the project is already
  // linked (so the CLI never blocks on an interactive link/login).
  if (det.provider === 'vercel' && det.linked) {
    let proceed = assumeYes;
    if (!proceed) {
      proceed = await askYesNo(
        `◉ Fiodos · Add ${keyVar} to your linked Vercel project (production, preview, development) now? [yes/no] `,
      );
    }
    if (proceed) {
      const res = attemptVercelEnvAdd(appRoot, keyVar, apiKey, [
        'production',
        'preview',
        'development',
      ]);
      if (res.attempted && res.ok) {
        log(`Pushed ${keyVar} to Vercel (${res.okCount}/3 environments). Redeploy to apply.`);
        if (res.okCount < 3) {
          if (devLog) devLog('[write-env] some Vercel envs failed (often already set) — reminder kept');
          return { ...base, reminder: true, partial: true };
        }
        return { ...base, reminder: false, automated: true };
      }
      if (devLog) devLog(`[write-env] vercel automation failed: ${res.reason || 'cli-error'}`);
      log('Could not push to Vercel automatically — see the reminder at the end.');
      return { ...base, reminder: true };
    }
    return { ...base, reminder: true };
  }

  // Any other provider / not linked / non-TTY: warn clearly at the end.
  return { ...base, reminder: true };
}

module.exports = {
  offerWriteEnv,
  resolveEnvPlan,
  computeEnvWritePlan,
  printEnvManualReminder,
  ensureEnvGitIgnored,
  gitignoreCovers,
  detectDeployProvider,
  isBuildTimePublicFramework,
  deployReminderLines,
};
