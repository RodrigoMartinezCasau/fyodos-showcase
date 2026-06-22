/**
 * writeEnv — optional, consent-based convenience that ties the app's RUNTIME
 * key/URL to the SAME key/URL the CLI just published with.
 *
 * The #1 silent-failure cause is a mismatch: you publish with key A against
 * production, but your app runs with key B against localhost, so the orb fetches
 * its manifest from the wrong place, finds nothing, and renders invisibly. This
 * removes the second manual copy of the key by offering to write it into the
 * correct env file for the detected framework.
 *
 * SAFEGUARDS (mirrors the handler-wiring philosophy — never act blindly):
 *  - Never overwrites silently: if the var exists and DIFFERS, it warns and asks.
 *  - Always asks for consent (unless --yes), showing the exact file/var/value.
 *  - Warns to keep the key out of git (suggests .gitignore) for committed files.
 *  - On unknown framework / no package.json / Angular (no .env convention), it
 *    does NOT write — it prints manual instructions instead.
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
 * Decide which env file + variable names the detected framework uses. Returns
 * null when there is no safe .env convention to write (Angular, or unknown).
 */
function resolveEnvPlan(appRoot) {
  const pkg = readJsonSafe(path.join(appRoot, 'package.json'));
  const has = (rel) => fs.existsSync(path.join(appRoot, rel));
  if (!pkg && !has('angular.json')) {
    return { framework: null, file: null, keyVar: null, urlVar: null };
  }
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};

  if (deps.next) {
    return { framework: 'next', file: '.env.local', keyVar: 'NEXT_PUBLIC_FYODOS_API_KEY', urlVar: 'NEXT_PUBLIC_FYODOS_API_URL' };
  }
  if (deps['@angular/core'] || has('angular.json')) {
    // Angular has no .env convention (values live in environment.ts), so we
    // never write a file blindly — the caller prints manual guidance instead.
    return { framework: 'angular', file: null, keyVar: null, urlVar: null };
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
    return { framework: 'vite', file: '.env', keyVar: 'VITE_FYODOS_API_KEY', urlVar: 'VITE_FYODOS_API_URL' };
  }
  return { framework: null, file: null, keyVar: null, urlVar: null };
}

/** Find the value of VAR in the parsed lines, or undefined if not present. */
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

/** Upsert VAR=value: replace the existing line, or append a new one. */
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
 * Offer to write key/URL to the app's env file. `log` is the branded logUser.
 * Returns a short status string for the final report.
 */
async function offerWriteEnv({ appRoot, apiKey, apiUrl, defaultApiUrl, assumeYes, log }) {
  if (!apiKey) return 'skipped (no API key)';

  const plan = resolveEnvPlan(appRoot);
  if (!plan.file) {
    if (plan.framework === 'angular') {
      log(
        'Angular does not use .env: put these values in src/environments/environment.ts → ' +
          `fyodosApiKey: '${maskKey(apiKey)}', fyodosApiUrl: '${apiUrl}'`,
      );
      return 'manual (angular)';
    }
    log(
      'Could not identify the framework with confidence; add by hand to your .env: ' +
        `(NEXT_PUBLIC_/VITE_)FYODOS_API_KEY=${maskKey(apiKey)} and the API URL ${apiUrl}`,
    );
    return 'manual (unknown framework)';
  }

  const filePath = path.join(appRoot, plan.file);
  const exists = fs.existsSync(filePath);
  const raw = exists ? fs.readFileSync(filePath, 'utf8') : '';
  const lines = raw.length ? raw.replace(/\n$/, '').split('\n') : [];

  const currentKey = readEnvVar(lines, plan.keyVar);
  const currentUrl = readEnvVar(lines, plan.urlVar);

  // Only write a URL var when it differs from the public default (the SDK
  // already defaults to production). But if a STALE url var exists and differs
  // from what we published against, we must offer to fix it — that is exactly
  // the localhost-vs-production mismatch that hides the orb.
  const wantUrl = apiUrl && apiUrl !== defaultApiUrl ? apiUrl : null;
  const urlNeedsFix = currentUrl !== undefined && currentUrl !== apiUrl;

  const keyMatches = currentKey === apiKey;
  const urlOk = !urlNeedsFix && (wantUrl ? currentUrl === wantUrl : true);
  if (keyMatches && urlOk) {
    log(`✓ Your ${plan.file} already uses the same key/URL as the publication. Nothing to change.`);
    return 'already aligned';
  }

  // Build the change description.
  const changes = [];
  if (!keyMatches) {
    changes.push(
      currentKey === undefined
        ? `add ${plan.keyVar}=${maskKey(apiKey)}`
        : `update ${plan.keyVar} (was ${maskKey(currentKey)}) → ${maskKey(apiKey)}`,
    );
  }
  if (wantUrl && currentUrl !== wantUrl) {
    changes.push(
      currentUrl === undefined
        ? `add ${plan.urlVar}=${wantUrl}`
        : `update ${plan.urlVar} (was ${currentUrl}) → ${wantUrl}`,
    );
  } else if (urlNeedsFix && !wantUrl) {
    // The app points somewhere (e.g. localhost) but we published against the
    // public default; the var is misleading. Offer to align it explicitly.
    changes.push(`update ${plan.urlVar} (was ${currentUrl}) → ${apiUrl}`);
  }

  if (!changes.length) {
    log(`✓ Your ${plan.file} is already aligned.`);
    return 'already aligned';
  }

  // Loud warning when we are about to CHANGE an existing, different value.
  const isOverwrite = (currentKey !== undefined && !keyMatches) || urlNeedsFix;
  log(
    `${isOverwrite ? '⚠︎ ' : ''}For the orb to find its manifest, your app should use the SAME ` +
      `key/URL you just published with. Proposed in ${plan.file}: ${changes.join('; ')}.`,
  );

  let proceed = assumeYes;
  if (!proceed) {
    proceed = await askYesNo(
      `◉ Fiodos · Write/update ${plan.file} with the published key/URL? [yes/no] `,
    );
  }
  if (!proceed) {
    log(`Left your ${plan.file} untouched. Do it by hand: ${changes.join('; ')}.`);
    return 'declined by user';
  }

  let out = lines.slice();
  if (!keyMatches) out = upsertEnvVar(out, plan.keyVar, apiKey);
  if (wantUrl) {
    out = upsertEnvVar(out, plan.urlVar, wantUrl);
  } else if (urlNeedsFix) {
    out = upsertEnvVar(out, plan.urlVar, apiUrl);
  }
  fs.writeFileSync(filePath, `${out.join('\n')}\n`);
  log(`✓ ${plan.file} updated (${changes.join('; ')}).`);

  if (!isGitIgnored(appRoot, plan.file)) {
    log(`Reminder: add ${plan.file} to .gitignore so you don't commit your API key.`);
  }
  return 'written';
}

module.exports = { offerWriteEnv, resolveEnvPlan };
