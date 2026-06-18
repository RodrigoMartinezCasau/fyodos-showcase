#!/usr/bin/env node
/**
 * Fyodos auto-manifest engine v3 — AI-FIRST.
 *
 * The model reads the app's SOURCE CODE directly and proposes the manifest;
 * the mechanical layer verifies its output afterwards. Inverted from v2,
 * where a static candidate-detector gated what the model was allowed to see
 * (and a 0-candidate scan blinded the whole analysis).
 *
 * Pipeline:
 *   1. static  — expo-router route scan (cheap existence facts, reused from v2)
 *   2. collect — rule-based file selection with input budget (not analysis)
 *   3. AI      — ONE call: model reads the code, proposes manifest + evidence
 *   4. verify  — mechanical output check: file + symbol + route must exist;
 *                unproven claims are dropped, never published
 *   5. gate    — @fyodos/core validateManifest
 *
 * Usage:
 *   node src/index.js <target-app-root> --out <output-dir> \
 *       [--model claude-opus-4-8] [--max-input-tokens 150000] [--no-llm] \
 *       [--publish [--api-key <fyodos-project-api-key>] [--api-url <backend-url>]] \
 *       [--no-wire | --yes]
 *       [--verbose]
 *
 * Output verbosity:
 *   By default the CLI shows only developer-facing progress (no token counts,
 *   cost, model id, API key prefix, or internal file paths). Pass --verbose
 *   for the full diagnostic log (for Fiodos operators debugging locally).
 *
 * Web orb wiring (web targets only):
 *   After analysis, a web target is OFFERED automatic wiring of <FyodosAgent/>
 *   into the app's root layout. It asks before editing your code; on "no" (or a
 *   non-interactive shell) it prints the ready-to-paste snippet instead.
 *     --yes      accept the wiring without the prompt (CI / express installer)
 *     --no-wire  skip wiring entirely (analysis/publish unaffected)
 *
 * Env (auto-loaded from tools/auto-manifest/.env and fyodos/backend/.env;
 * shell exports take precedence):
 *   ANTHROPIC_API_KEY   — AI analysis default (Claude Opus; your key, your cost)
 *   OPENAI_API_KEY      — only if you pass --model gpt-5 / gpt-4o / …
 *   FYODOS_API_KEY      — project key for --publish (or the analyzed app's
 *                         EXPO_PUBLIC_FYODOS_API_KEY, which wins)
 *
 * PRIVACY:
 *   - The analysis runs on THIS machine. With --publish, only the resulting
 *     manifest.json + small metadata are POSTed to the Fyodos backend.
 *     Source files NEVER reach the Fyodos backend.
 *   - The AI step sends the collected source files to the AI provider
 *     (Anthropic Claude Opus by default) using the developer's own key.
 *     Use --no-llm for a static-only pass (routes, no actions) if that is not acceptable.
 *
 * Output:
 *   manifest.json     — AppManifest (schema of @fyodos/core), verified
 *   provenance.json   — per route/action: verification result or drop reason
 *   evidence.json     — model's claimed evidence + declared uncertainties
 *   usage.json        — REAL token usage + cost in USD for this analysis
 *   files-sent.json   — exactly which files were included in the prompt
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { loadEnv, loadAppEnv } = require('./loadEnv');
loadEnv();

const { scanRoutes } = require('./routes');
const { collectFiles } = require('./collect');
const { analyzeWithAI, correctActionWiring, DEFAULT_MODEL, resolveModel } = require('./aiAnalyze');
const { verifyManifest } = require('./verify');
const { wireWebOrb, reportWireResult } = require('./wireWeb');
const { wireHandlers, reportHandlerResult } = require('./wireHandlers');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function fyodosTermColors() {
  const on = Boolean(process.stderr.isTTY);
  return {
    blue: on ? '\x1b[38;5;75m' : '',
    cyan: on ? '\x1b[38;5;117m' : '',
    dim: on ? '\x1b[2m' : '',
    reset: on ? '\x1b[0m' : '',
  };
}

/** Internal diagnostics (tokens, cost, paths…) — only with --verbose. */
function isVerbose() {
  return process.argv.includes('--verbose') || process.argv.includes('-v');
}

function logDev(...args) {
  if (isVerbose()) console.log(...args);
}

/** Branded one-liner for the developer running the CLI (not internal ops). */
function logUser(line) {
  const { blue, cyan, reset } = fyodosTermColors();
  console.log(`${cyan}◉${reset} ${blue}Fiodos${reset} · ${line}`);
}

/** Branded terminal spinner (Fyodos orb + colors when stderr is a TTY). */
async function withSpinner(label, work) {
  const orbFrames = ['◴', '◷', '◶', '◵'];
  const brailleFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const { blue, cyan, dim, reset } = fyodosTermColors();
  let frame = 0;
  const start = Date.now();
  const tick = () => {
    const sec = Math.floor((Date.now() - start) / 1000);
    const orb = orbFrames[frame % orbFrames.length];
    const tail = brailleFrames[frame % brailleFrames.length];
    const line =
      `${cyan}${orb}${reset} ${blue}Fiodos${reset} ${dim}${tail}${reset}  ${label}… ${dim}${sec}s${reset}`;
    process.stderr.write(`\r\x1b[K${line}`);
    frame += 1;
  };
  tick();
  const id = setInterval(tick, 140);
  try {
    return await work();
  } finally {
    clearInterval(id);
    process.stderr.write('\r\x1b[K');
  }
}

async function main() {
  const appRoot = process.argv[2];
  if (!appRoot) {
    console.error('Usage: node src/index.js <target-app-root> --out <dir> [--model claude-opus-4-8] [--no-llm] [--publish]');
    process.exit(1);
  }
  const outDir = arg('--out', path.join(__dirname, '../output', path.basename(appRoot)));
  // Model precedence: explicit --model (operator override) > backend plan model
  // (resolved below from the analysis-quota pre-check) > DEFAULT_MODEL fallback.
  const explicitModel = arg('--model', '');
  let model = resolveModel(explicitModel || DEFAULT_MODEL);
  const maxInputTokens = Number(arg('--max-input-tokens', '150000'));
  const useLLM = !process.argv.includes('--no-llm');
  fs.mkdirSync(outDir, { recursive: true });

  // ── 1. Static route scan (cheap facts; also the route verifier's ground truth)
  // Platform: auto-detected from the presence of an expo-router app/ dir, or
  // forced with --platform web|mobile. Web apps have no static route ground
  // truth, so the AI proposes routes and we keep them unverified (honest flag).
  const { appDir, routes: scannedRoutes } = scanRoutes(appRoot);
  const platformArg = (arg('--platform', '') || '').toLowerCase();
  const KNOWN_PLATFORMS = ['web', 'mobile', 'flutter', 'ios', 'android'];
  const platform = KNOWN_PLATFORMS.includes(platformArg)
    ? platformArg
    : detectPlatform(appRoot, appDir);
  // The expo-router filesystem scan ONLY describes a mobile app. A Next.js App
  // Router web app also has an app/ dir, so the scan would otherwise produce
  // bogus "routes" and misclassify the project; for web we ignore it and let
  // the AI propose routes (the documented web contract).
  // Only Expo/RN ('mobile') has a static route ground truth. Web AND the native
  // platforms (flutter/ios/android) have the AI infer routes (kept unverified).
  const routes = platform === 'mobile' ? scannedRoutes : [];
  const verifyRoutes = platform === 'mobile' && routes.length > 0;
  const appMeta = readAppMeta(appRoot);
  logDev(`[static] platform=${platform} routes=${routes.length}` +
    (platform === 'web' ? ' (web: routes inferred by AI, not statically verified)' : ''));

  // ── 2. Collect source files (rule-based, budget-aware) ────────────────────
  const { included, omitted, estimatedTokens } = collectFiles(appRoot, { maxInputTokens, platform });
  fs.writeFileSync(path.join(outDir, 'files-sent.json'), JSON.stringify({
    included: included.map((f) => f.rel),
    omitted,
  }, null, 2));
  logDev(`[collect] files=${included.length} (~${estimatedTokens} tokens)` +
    (omitted.length ? ` omitted=${omitted.length} (over budget)` : ''));

  let manifest;
  let provenance;
  let evidence = {};
  let wiring = {};
  let analysisMeta = { engine: 'auto-manifest-v3-ai-first', model: null, costUSD: 0 };

  if (!useLLM) {
    // Static-only fallback: routes with mechanical naming, no actions.
    // Useful as a free smoke pass or when sending code to an AI provider
    // is not acceptable for this app.
    ({ manifest, provenance } = routesOnlyManifest(appMeta, routes));
    logDev('[no-llm] static-only manifest (routes only, no actions)');
    logUser(`Static analysis complete — ${manifest.routes.length} routes`);
  } else {
    // ── 2b. Plan quota pre-check (before spending any AI tokens) ─────────────
    // When publishing, ask the backend whether this project's plan still allows
    // an analysis. The Free plan includes exactly one (the initial onboarding
    // analysis); paid plans allow several. The publish step re-checks server-
    // side, so this is only a courtesy to avoid wasting AI tokens.
    if (process.argv.includes('--publish')) {
      loadAppEnv(path.resolve(appRoot));
      const quota = await fetchAnalysisQuota(resolveApiTarget());
      if (quota && quota.allowed === false) {
        printQuotaBlocked(quota);
        return;
      }
      // Tier-based model: the backend tells us which model this plan is
      // entitled to. The user never sees or sets it. An explicit --model
      // (operator override) always wins.
      if (!explicitModel && quota && quota.model) {
        model = resolveModel(quota.model);
      }
    }

    // ── 3. AI reads the code ────────────────────────────────────────────────
    logUser('Analyzing your project — may take 1–2 min');
    const { parsed, usage, costUSD, elapsedMs, promptChars } = await withSpinner(
      'Analyzing your project with AI',
      () => analyzeWithAI({
        appMeta, files: included, omitted, staticRoutes: routes, model, platform,
      }),
    );
    const proposed = parsed.manifest || {};
    evidence = parsed.evidence || {};
    wiring = parsed.wiring || {};
    logDev(`[ai] model=${model} proposed routes=${(proposed.routes || []).length} ` +
      `actions=${(proposed.actions || []).length} in ${(elapsedMs / 1000).toFixed(1)}s`);
    logDev(`[ai] tokens in=${usage.prompt_tokens} out=${usage.completion_tokens} cost=$${costUSD.toFixed(4)}`);

    // ── 4. Mechanical verification of the AI's claims ───────────────────────
    // Actions are always verified against real code. Routes are verified only
    // when there is filesystem ground truth (mobile); for web they are kept as
    // AI-proposed and flagged unverified in provenance.
    ({ manifest, provenance } = verifyManifest(proposed, evidence, included, routes, { verifyRoutes }));
    ensureBackRoute(manifest, provenance);
    const droppedActions = provenance.actions.filter((a) => !a.included).length;
    const droppedRoutes = provenance.routes.filter((r) => !r.included).length;
    logDev(`[verify] kept routes=${manifest.routes.length} actions=${manifest.actions.length}` +
      ` | dropped: ${droppedRoutes} routes, ${droppedActions} actions (unproven evidence)`);
    logUser(`Analysis complete — ${manifest.routes.length} routes, ${manifest.actions.length} actions`);

    fs.writeFileSync(path.join(outDir, 'evidence.json'), JSON.stringify({
      evidence, wiring, uncertain: parsed.uncertain || [],
    }, null, 2));
    fs.writeFileSync(path.join(outDir, 'usage.json'), JSON.stringify({
      model, elapsedMs, usage,
      costUSD: Number(costUSD.toFixed(4)),
      promptChars, filesSent: included.length, filesOmitted: omitted.length,
    }, null, 2));

    analysisMeta = {
      engine: 'auto-manifest-v3-ai-first',
      model,
      platform,
      routeVerification: verifyRoutes ? 'filesystem' : 'ai-proposed',
      appKind: parsed.appKind || 'unknown',
      costUSD: Number(costUSD.toFixed(4)),
      droppedActions,
      droppedRoutes,
    };
  }

  // ── 4b. Agent-to-agent: suggest which actions to restrict for EXTERNAL agents.
  // Advisory only (the developer decides in the dashboard; nothing is gated by
  // this). Sensitive/irreversible actions — those requiring confirmation, or
  // whose label/intent reads as destructive/financial — are flagged 'restrict';
  // the rest 'allow'. Closed-by-default still applies regardless of this hint.
  annotateExternalAgentRecommendations(manifest);

  // ── 5. Final gate: the real @fyodos/core validator ─────────────────────────
  try {
    const { validateManifest } = require(path.join(__dirname, '../../../packages/core/dist/manifest/validate.js'));
    const validation = validateManifest(manifest);
    provenance.coreValidation = validation;
    logDev(`[validate] @fyodos/core validateManifest → valid=${validation.valid}` +
      (validation.errors?.length ? ` errors=${JSON.stringify(validation.errors)}` : ''));
  } catch {
    provenance.coreValidation = { skipped: 'core dist not built' };
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, 'provenance.json'), JSON.stringify(provenance, null, 2));
  logDev(`[done] manifest: ${manifest.routes.length} routes, ${manifest.actions.length} actions`);
  logDev(`[done] output → ${outDir}`);

  if (process.argv.includes('--publish')) {
    loadAppEnv(path.resolve(appRoot));
    await publishManifest(manifest, {
      ...analysisMeta,
      generatedAt: new Date().toISOString(),
      routesIncluded: manifest.routes.length,
      actionsIncluded: manifest.actions.length,
    });
  }

  // ── 6. Web: offer to wire the orb into the app (consent-based) ─────────────
  // The same command the developer already runs also drops <FyodosAgent/> into
  // their app, so the onboarding never needs a separate manual step. Mobile is
  // wired by its own installer and is intentionally left untouched here.
  if (platform === 'web') {
    const { apiUrl } = resolveApiTarget();
    const assumeYes = process.argv.includes('--yes') || process.argv.includes('--wire-yes');
    const noWire = process.argv.includes('--no-wire');
    // --no-orb-wire skips ONLY the orb mount (useful to test handler wiring in
    // isolation without modifying the app's entrypoint / package.json).
    if (!process.argv.includes('--no-orb-wire')) {
      const result = await wireWebOrb(path.resolve(appRoot), {
        apiUrl,
        colors: fyodosTermColors(),
        assumeYes,
        noWire,
      });
      reportWireResult(result, fyodosTermColors());
    }

    // ── 7. Web: SECOND consent — connect detected actions to real app functions.
    // The orb is mounted but the agent cannot DO anything until each manifest
    // action is bridged to the function that performs it. We prepare that wiring,
    // write a readable document into the project's Fyodos folder, and ask a
    // separate, informed [yes/no] before touching anything. Security is enforced
    // upstream by the engine, so generated handlers can never skip a confirmation.
    const { runPostWireTest } = require('./postWireTest');
    // Corrector: when a wired action fails install-time verification, re-prompt the
    // AI with the concrete error to fix THAT action. Disable with --no-self-correct.
    const selfCorrect = !process.argv.includes('--no-self-correct');
    const corrector = selfCorrect
      ? async (args) => {
          const { wiring: fixed } = await correctActionWiring({ ...args, model, platform });
          return fixed;
        }
      : null;
    const handlerResult = await wireHandlers(path.resolve(appRoot), {
      manifest,
      evidence,
      wiring,
      appName: manifest.appName,
      colors: fyodosTermColors(),
      assumeYes,
      noWire,
      runTest: !process.argv.includes('--no-wire-test'),
      revertOnFailure: true,
      testRunner: runPostWireTest,
      corrector,
      files: included,
      maxAttempts: Number(process.env.FYODOS_WIRE_MAX_ATTEMPTS || 3),
    });
    reportHandlerResult(handlerResult, fyodosTermColors());
  }
}

/**
 * Resolve the target platform from package.json dependencies — the only signal
 * that reliably tells a Next.js App Router web app (which has an app/ dir) apart
 * from an expo-router mobile app (which also has an app/ dir). Falls back to the
 * old app/-dir heuristic only when no framework dependency is recognizable.
 */
function detectPlatform(appRoot, appDir) {
  // Native projects are recognized by their build manifests (no package.json).
  const has = (rel) => fs.existsSync(path.join(appRoot, rel));
  const hasAnyExt = (ext) => {
    // Shallow check: any source of this extension within a few levels.
    let found = false;
    const walk = (dir, depth) => {
      if (found || depth > 12) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (found) return;
        if (e.isDirectory()) {
          if (!['node_modules', '.git', 'build', '.gradle', '.dart_tool', '.build', 'Pods'].includes(e.name)) {
            walk(path.join(dir, e.name), depth + 1);
          }
        } else if (e.name.endsWith(ext)) {
          found = true;
        }
      }
    };
    walk(appRoot, 0);
    return found;
  };

  if (has('pubspec.yaml')) return 'flutter';
  if (has('Package.swift') || hasAnyExt('.xcodeproj') || (has('Sources') && hasAnyExt('.swift'))) return 'ios';
  if ((has('settings.gradle.kts') || has('settings.gradle') || has('build.gradle.kts') || has('build.gradle')) && hasAnyExt('.kt')) {
    return 'android';
  }

  let deps = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
    deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  } catch {
    /* no package.json → fall through to the directory heuristic */
  }
  if (deps.expo || deps['expo-router'] || deps['react-native']) return 'mobile';
  if (
    deps.next || deps.vite || deps['@vitejs/plugin-react'] || deps['react-scripts'] ||
    deps['@angular/core'] || deps['@angular-devkit/build-angular'] ||
    deps['@sveltejs/kit'] || deps.svelte || deps.vue || deps['@vue/cli-service']
  ) {
    return 'web';
  }
  return appDir ? 'mobile' : 'web';
}

function readAppMeta(appRoot) {
  const meta = { name: path.basename(appRoot), description: '', dependencies: [] };
  const pkgPath = path.join(appRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    meta.name = pkg.name || meta.name;
    meta.description = pkg.description || '';
    meta.dependencies = Object.keys(pkg.dependencies || {});
  }
  for (const cfg of ['app.json', 'app.config.ts', 'app.config.js']) {
    const p = path.join(appRoot, cfg);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    const nameMatch = text.match(/APP_NAME\s*=\s*["']([^"']+)["']/) || text.match(/"name"\s*:\s*"([^"]+)"/);
    if (nameMatch) meta.name = nameMatch[1];
    const bundleMatch = text.match(/BUNDLE_IDENTIFIER\s*=\s*["']([^"']+)["']/) || text.match(/"bundleIdentifier"\s*:\s*"([^"]+)"/);
    if (bundleMatch) meta.bundleId = bundleMatch[1];
  }
  // Native projects have no package.json — read their own manifests for a name.
  const pubspec = path.join(appRoot, 'pubspec.yaml');
  if (fs.existsSync(pubspec)) {
    const text = fs.readFileSync(pubspec, 'utf8');
    const n = text.match(/^name:\s*([A-Za-z0-9_\-]+)/m);
    const d = text.match(/^description:\s*["']?([^"'\n]+)/m);
    if (n) meta.name = n[1];
    if (d && !meta.description) meta.description = d[1].trim().slice(0, 300);
  }
  const pkgSwift = path.join(appRoot, 'Package.swift');
  if (fs.existsSync(pkgSwift)) {
    const n = fs.readFileSync(pkgSwift, 'utf8').match(/name:\s*"([^"]+)"/);
    if (n) meta.name = n[1];
  }

  const readme = path.join(appRoot, 'README.md');
  if (!meta.description && fs.existsSync(readme)) {
    const lines = fs.readFileSync(readme, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    meta.description = (lines[0] || '').replace(/^[*\-\s]+/, '').slice(0, 300);
  }
  return meta;
}

/** --no-llm: routes from the filesystem scan with mechanical naming. */
function routesOnlyManifest(appMeta, routes) {
  const provenance = { engine: 'auto-manifest-v3-ai-first (static-only)', routes: [], actions: [], notes: [] };
  const manifestRoutes = [];
  const seen = new Set();
  for (const r of routes) {
    if (r.isDynamic) continue;
    const slug = (r.urlPath === '/' ? 'home' : r.urlPath.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '_')).toLowerCase();
    const intent = `open_${slug}`;
    if (seen.has(intent)) continue;
    seen.add(intent);
    const label = slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    manifestRoutes.push({
      intent, label, route: r.routePath,
      examples: [`open ${label.toLowerCase()}`, `go to ${label.toLowerCase()}`, `show ${label.toLowerCase()}`],
    });
    provenance.routes.push({ intent, included: true, verification: 'static (filesystem scan, mechanical naming)' });
  }
  const manifest = {
    appId: appMeta.bundleId || `auto.${appMeta.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`,
    appName: appMeta.name,
    appDescription: appMeta.description || 'auto-detected app (static-only pass)',
    version: '0.1.0-auto-v3',
    routes: manifestRoutes,
    actions: [],
    policies: { requireConfirmationForDestructive: true, allowedWithoutAuth: [], contextRetentionTurns: 5 },
  };
  ensureBackRoute(manifest, provenance);
  return { manifest, provenance };
}

function ensureBackRoute(manifest, provenance) {
  if (!manifest.routes.some((r) => r.route === 'BACK')) {
    manifest.routes.push({
      intent: 'back', label: 'Back', route: 'BACK',
      examples: ['go back', 'back', 'previous screen'],
    });
    provenance.routes.push({ intent: 'back', included: true, verification: 'static (SDK convention, added mechanically)' });
  }
}

// Words that, in an action label/intent, signal a sensitive or irreversible
// operation worth keeping human-only by default (agent-to-agent).
const RESTRICT_HINTS = [
  'delete', 'remove', 'cancel', 'pay', 'payment', 'purchase', 'buy', 'order',
  'checkout', 'transfer', 'withdraw', 'refund', 'logout', 'sign out', 'deactivate',
  'close account', 'address', 'password', 'subscribe', 'unsubscribe', 'send money',
  'borrar', 'eliminar', 'cancelar', 'pagar', 'pago', 'comprar', 'pedido',
  'transferir', 'retirar', 'reembolso', 'cerrar sesión', 'dirección', 'contraseña',
];

/**
 * Annotate each action with `externalAgentRecommendation` ('restrict' | 'allow').
 * Advisory only: the dashboard surfaces it as a suggestion and the developer
 * decides. An action that requires confirmation, or whose label/intent matches a
 * sensitive keyword, is recommended for restriction.
 */
function annotateExternalAgentRecommendations(manifest) {
  for (const action of manifest.actions || []) {
    const haystack = `${action.intent || ''} ${action.label || ''}`.toLowerCase();
    const looksSensitive =
      action.requireConfirmation === true ||
      RESTRICT_HINTS.some((w) => haystack.includes(w));
    action.externalAgentRecommendation = looksSensitive ? 'restrict' : 'allow';
  }
}

/**
 * POST the resulting manifest (and only the manifest + small metadata) to the
 * developer's Fyodos project. Authenticated with the project API key shown in
 * the dashboard. Never sends source files, evidence or usage logs.
 */
/** Resolve the Fiodos backend target (project API key + URL) from flags/env. */
function resolveApiTarget() {
  const apiKey = arg('--api-key', process.env.FYODOS_API_KEY || '');
  const apiUrl = (arg('--api-url', process.env.FYODOS_API_URL || 'http://localhost:8000') || '').replace(/\/$/, '');
  return { apiKey, apiUrl };
}

/**
 * Ask the backend, BEFORE calling the AI, for this project's analysis quota and
 * the model its plan is entitled to. Returns the full quota object, or null on
 * missing key / unreachable backend (the publish step is the real gate, so we
 * never hard-fail the analysis on a transient pre-check error). The caller reads
 * `allowed` (to stop early when the quota is exhausted) and `model` (tier-based
 * cost control: free→Haiku, pro→Sonnet, advanced/enterprise→Opus).
 */
async function fetchAnalysisQuota({ apiKey, apiUrl }) {
  if (!apiKey) return null;
  try {
    const res = await fetch(`${apiUrl}/v1/developer/analysis/quota`, {
      headers: { 'x-api-key': apiKey },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Branded message shown when the plan's analysis quota is exhausted. */
function printQuotaBlocked(quota) {
  const { blue, cyan, dim, reset } = fyodosTermColors();
  const limit = quota.limit == null ? '∞' : quota.limit;
  console.error(`\n${cyan}◉${reset} ${blue}Fiodos${reset} · analysis unavailable`);
  console.error(
    `${dim}Your plan (${quota.planId}) includes ${limit} analysis run(s) and you have already used them ` +
    `(${quota.used}/${limit}).${reset}`,
  );
  console.error(
    `${dim}Upgrade your plan in the Fiodos dashboard to analyze again. ` +
    `No AI analysis was consumed.${reset}\n`,
  );
}

async function publishManifest(manifest, meta) {
  const { apiKey, apiUrl } = resolveApiTarget();
  if (!apiKey) {
    console.error(
      '[publish] missing project API key — add FYODOS_API_KEY or FYODOS_CLIENT_KEYS to backend/.env, or pass --api-key',
    );
    process.exit(1);
  }
  logDev(`[publish] POST ${apiUrl}/v1/developer/manifest (manifest + metadata only — no source code)`);
  logDev(`[publish] project API key: ${apiKey.slice(0, 12)}…`);
  const res = await fetch(`${apiUrl}/v1/developer/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ manifest, meta }),
  });
  if (!res.ok) {
    if (res.status === 429) {
      const detail = await res.json().catch(() => null);
      const q = detail && detail.detail ? detail.detail : detail;
      if (q && q.planId) {
        printQuotaBlocked({ planId: q.planId, used: q.used, limit: q.limit });
        process.exit(1);
      }
    }
    const text = await res.text().catch(() => '');
    console.error(`[publish] FAILED ${res.status}: ${text || res.statusText}`);
    process.exit(1);
  }
  const body = await res.json();
  logUser(`Published to your project — ${body.routes} routes, ${body.actions} actions`);
  logDev(`[publish] OK — ${body.routes} routes, ${body.actions} actions received at ${body.receivedAt}`);
  logUser('Open the dashboard → Agent settings → "Reload analysis" to review');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
