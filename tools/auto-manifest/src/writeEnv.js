/**
 * writeEnv — consent-based API key / URL alignment for the app's environment.
 *
 * The orb must read the SAME key/URL the CLI published with. We always ASK
 * before writing (independent of --yes, which only skips orb/handler prompts).
 * If the developer declines, a copy-paste reminder is shown at the very END of
 * the run — after analysis, publish, orb mount and handler wiring are done.
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

function isGitIgnored(appRoot, fileName) {
  const gi = path.join(appRoot, '.gitignore');
  if (!fs.existsSync(gi)) return false;
  try {
    const content = fs.readFileSync(gi, 'utf8');
    const patterns = content.split('\n').map((l) => l.trim());
    return patterns.some(
      (p) => p === fileName || p === `/${fileName}` || p === '.env*' || p === '*.local' || p === '.env.local',
    );
  } catch {
    return false;
  }
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
    return { kind: 'aligned', targetRel, plan };
  }

  const envLines = [`${plan.keyVar}=${apiKey}`];
  if (wantUrl) envLines.push(`${plan.urlVar}=${wantUrl}`);
  else if (urlNeedsFix) envLines.push(`${plan.urlVar}=${apiUrl}`);

  return {
    kind: 'writable',
    plan,
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

/** Branded reminder shown at the END when the developer declined the write. */
function printEnvManualReminder(writePlan, { logUser, logDev }) {
  if (!writePlan || writePlan.kind === 'aligned') return;

  logUser('Add your API key to your environment file (last step)');

  if (writePlan.kind === 'manual-angular') {
    console.log(
      `  Angular: open ${writePlan.file} and set fyodosApiKey / fyodosApiUrl:`,
    );
    console.log(`    fyodosApiKey: '${writePlan.apiKey}'`);
    console.log(`    fyodosApiUrl: '${writePlan.apiUrl}'`);
    return;
  }

  if (writePlan.kind === 'manual-unknown') {
    console.log('  Add to your project .env (use NEXT_PUBLIC_ for Next, VITE_ for Vite):');
    console.log(`    ${writePlan.keyVar}=${writePlan.apiKey}`);
    if (writePlan.apiUrl && writePlan.apiUrl !== 'https://api.fyodos.com') {
      console.log(`    ${writePlan.urlVar}=${writePlan.apiUrl}`);
    }
    return;
  }

  const rel = writePlan.targetRel;
  const displayPath = writePlan.absPath;
  console.log(`  File: ${displayPath}`);
  console.log('  Add these lines:');
  for (const line of writePlan.envLines) {
    console.log(`    ${line}`);
  }
  logDev(`[write-env] manual reminder for ${rel}`);
}

/**
 * Ask consent and optionally write. Returns { status, writePlan }.
 * `assumeYes` comes from --write-env-yes only (NOT global --yes).
 */
async function offerWriteEnv({ appRoot, apiKey, apiUrl, defaultApiUrl, assumeYes, log, logDev: devLog }) {
  const writePlan = computeEnvWritePlan(appRoot, apiKey, apiUrl, defaultApiUrl);
  if (!writePlan) return { status: 'skipped (no API key)', writePlan: null };
  if (writePlan.kind === 'aligned') {
    log(`Your environment already uses the same API key as this project. Nothing to change.`);
    return { status: 'already aligned', writePlan };
  }

  const targetLabel =
    writePlan.kind === 'manual-angular'
      ? writePlan.file
      : writePlan.kind === 'manual-unknown'
        ? 'your .env file'
        : writePlan.targetRel;

  let proceed = assumeYes;
  if (!proceed) {
    proceed = await askYesNo(
      `◉ Fiodos · Add your API key to ${targetLabel}? [yes/no] `,
    );
  }

  if (!proceed) {
    return { status: 'declined by user', writePlan };
  }

  if (writePlan.kind === 'manual-angular' || writePlan.kind === 'manual-unknown') {
    log('Could not write automatically for this framework — see the reminder at the end.');
    return { status: 'manual', writePlan };
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

  if (!isGitIgnored(appRoot, targetRel)) {
    devLog(`Reminder: add ${targetRel} to .gitignore so you don't commit your API key.`);
  }
  return { status: 'written', writePlan };
}

module.exports = {
  offerWriteEnv,
  resolveEnvPlan,
  computeEnvWritePlan,
  printEnvManualReminder,
};
