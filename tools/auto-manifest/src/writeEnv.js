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
 *   2. Deploy provider — for the build-time public key (VITE_/NEXT_PUBLIC_),
 *      which is inlined at BUILD time: if it is only in the (gitignored,
 *      never-pushed) local env and NOT in the provider, the production build
 *      ships WITHOUT it and the orb never appears. A CLI cannot (and must not)
 *      authenticate into the user's hosting account, so we do NOT prompt and we
 *      do NOT touch their provider. Instead we DETECT the stack and print a
 *      clear, numbered step-by-step at the END (copy key → paste in the
 *      provider's env panel → redeploy) so they do it themselves, safely.
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
  // Expo / React Native: the orb reads EXPO_PUBLIC_* (Expo inlines these at
  // build time and exposes them via process.env). A plain `.env` at the app root
  // is the convention; we still ensure it is git-ignored like any secret file.
  if (deps.expo || deps['expo-router'] || deps['react-native']) {
    return {
      framework: 'expo',
      file: '.env',
      candidates: ['.env.local', '.env.development.local', '.env.development', '.env'],
      keyVar: 'EXPO_PUBLIC_FYODOS_API_KEY',
      urlVar: 'EXPO_PUBLIC_FYODOS_API_URL',
    };
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

/**
 * Compute where the key/URL would go and what would change — no writes, no prompts.
 * @returns {object|null} null when there is nothing to do (already aligned / no key).
 */
function computeEnvWritePlan(appRoot, apiKey, apiUrl) {
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
  // Always pin the URL, even when it equals the CLI's default. Omitting it left
  // the app on whichever default was compiled into the SDK version it happens to
  // have installed, so a stale pin silently pointed the orb at the wrong host.
  const wantUrl = apiUrl || null;
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

/** Where, per provider, the Environment Variables panel lives + how to redeploy. */
function providerEnvHint(provider) {
  if (provider === 'vercel') {
    return {
      label: 'Vercel',
      where: 'Project → Settings → Environment Variables (tick Production, Preview, Development)',
      redeploy: 'Deployments → ⋯ → Redeploy (or push a new commit)',
    };
  }
  if (provider === 'netlify') {
    return {
      label: 'Netlify',
      where: 'Site configuration → Environment variables → Add a variable',
      redeploy: 'Deploys → Trigger deploy → Deploy site',
    };
  }
  if (provider === 'cloudflare') {
    return {
      label: 'Cloudflare Pages',
      where: 'Workers & Pages → your project → Settings → Variables and Secrets',
      redeploy: 'Deployments → Retry deployment (or push a new commit)',
    };
  }
  return null;
}

/**
 * Clear, numbered step-by-step for setting the build-time public key in the
 * deploy provider. Step 2 always speaks generically ("your hosting provider");
 * when we detect a provider we append an optional tip in parentheses — we never
 * assume the user's host is Vercel/Netlify/etc.
 */
function deployReminderLines(deploy) {
  const { keyVar, apiKey, provider } = deploy;
  const hint = providerEnvHint(provider);
  const lines = [];
  lines.push('  Step 1 — Copy your orb key (this exact value):');
  lines.push(`            ${apiKey}`);
  lines.push('');
  lines.push('  Step 2 — In your hosting provider, open Environment Variables and add:');
  lines.push(`            Name:  ${keyVar}`);
  lines.push(`            Value: ${apiKey}`);
  if (hint) {
    lines.push(`            (e.g. ${hint.label}: ${hint.where})`);
  } else {
    lines.push('            (usually Project or Site → Settings → Environment Variables)');
  }
  lines.push('');
  lines.push('  Step 3 — Redeploy so the variable is built in:');
  lines.push(`            ${hint ? hint.redeploy : 'Trigger a new deploy (or push a commit)'}`);
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
      if (writePlan.apiUrl) console.log(`    ${writePlan.urlVar}=${writePlan.apiUrl}`);
    } else {
      console.log(`  File: ${writePlan.absPath}`);
      console.log('  Add these lines:');
      for (const line of writePlan.envLines) console.log(`    ${line}`);
    }
    if (logDev) logDev(`[write-env] manual reminder for ${writePlan.targetRel || writePlan.file || 'env'}`);
  }

  if (deploy && deploy.reminder) {
    logUser('Make the orb appear in PRODUCTION — add the key to your host (3 steps)');
    for (const line of deployReminderLines(deploy)) console.log(line ? `  ${line}` : '');
    if (logDev) logDev(`[write-env] deploy reminder for provider=${deploy.provider || 'unknown'}`);
  }
}

/**
 * Ask consent and optionally write. Returns { status, writePlan, deploy }.
 * `assumeYes` comes from --write-env-yes only (NOT global --yes).
 */
async function offerWriteEnv({ appRoot, apiKey, apiUrl, assumeYes, log, logDev: devLog }) {
  const writePlan = computeEnvWritePlan(appRoot, apiKey, apiUrl);
  if (!writePlan) return { status: 'skipped (no API key)', writePlan: null, deploy: null };
  if (writePlan.kind === 'aligned') {
    log(`Your environment already uses the same API key as this project. Nothing to change.`);
    // Even when the local env is aligned, production may still be missing the key.
    const deploy = planDeployReminder(appRoot, writePlan);
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
    const deploy = planDeployReminder(appRoot, writePlan);
    return { status: 'declined by user', writePlan, deploy };
  }

  if (writePlan.kind === 'manual-angular' || writePlan.kind === 'manual-unknown') {
    log('Could not write automatically for this framework — see the reminder at the end.');
    const deploy = planDeployReminder(appRoot, writePlan);
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

  const deploy = planDeployReminder(appRoot, writePlan);
  return { status: 'written', writePlan, deploy };
}

/**
 * Plan the deploy-provider reminder for the build-time PUBLIC key
 * (VITE_/NEXT_PUBLIC_). We do NOT prompt and we do NOT touch the user's hosting
 * provider — a CLI cannot safely authenticate into someone's Vercel/Netlify
 * account, and we never want to access a production provider on their behalf.
 *
 * Instead we DETECT the stack (provider + var name) and queue a clear, numbered
 * step-by-step that is printed at the very end of the run (see
 * `deployReminderLines`). The developer copies the key and pastes it into their
 * provider's Environment Variables panel themselves, then redeploys.
 */
function planDeployReminder(appRoot, writePlan) {
  const framework = writePlan.framework;
  const keyVar = writePlan.keyVar;
  const apiKey = writePlan.apiKey;
  if (!apiKey || !keyVar || !isBuildTimePublicFramework(framework)) {
    return null; // Angular / unknown handle their own manual reminders.
  }
  const det = detectDeployProvider(appRoot);
  return { provider: det.provider, linked: det.linked, keyVar, apiKey, reminder: true };
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
