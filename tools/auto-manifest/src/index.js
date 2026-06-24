#!/usr/bin/env node
/**
 * Fiodos auto-manifest engine v3 — AI-FIRST.
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
 *   5. gate    — @fiodos/core validateManifest
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
 *   After analysis, a web target is OFFERED automatic wiring of <FiodosAgent/>
 *   into the app's root layout. It asks before editing your code; on "no" (or a
 *   non-interactive shell) it prints the ready-to-paste snippet instead.
 *     --yes          accept orb/handler wiring without prompts (CI / express)
 *     --write-env-yes write the API key to .env without asking (CI only)
 *     --no-wire      skip wiring entirely (analysis/publish unaffected)
 *     --no-write-env skip the offer to align the app's .env with the published
 *                    key/URL (see below)
 *
 * Avoiding the silent "orb fetches the wrong backend" failure:
 *   After --publish the CLI (1) re-fetches the manifest with the SAME key+URL to
 *   confirm the orb will find it, printing the exact key/URL your app must use,
 *   and (2) on web, ASKS at the END whether to write that key/URL into the
 *   app's env file (.env.local for Next, .env for Vite). If you say yes it
 *   writes; if you say no it prints the exact file path and lines to add.
 *   Independent of --yes (which only skips orb/handler prompts). CI: --write-env-yes.
 *   Disable entirely with --no-write-env.
 *
 * AI key — HYBRID model:
 *   DEFAULT (hosted): the AI analysis runs on the Fiodos backend with FIODOS'S
 *     key; you need no AI key of your own and the cost is part of the plan.
 *     In this mode your source code travels to the Fiodos backend on its way to
 *     the AI provider (see PRIVACY).
 *   --own-ai-key: the AI call runs locally with YOUR provider key — the source
 *     code goes straight from this machine to the AI and never reaches Fiodos.
 *       ANTHROPIC_API_KEY — own-key analysis default (Claude); your key, your cost
 *       OPENAI_API_KEY    — own-key analysis if you pass --model gpt-5 / gpt-4o / …
 *   --no-llm: static-only pass (routes, no actions); no code leaves this machine.
 *
 * Env (auto-loaded from tools/auto-manifest/.env and fyodos/backend/.env;
 * shell exports take precedence):
 *   FYODOS_API_KEY      — project key for hosted analysis + --publish (or the
 *                         analyzed app's EXPO_PUBLIC_FYODOS_API_KEY, which wins)
 *
 * PRIVACY (honest, per mode):
 *   - The PUBLISH step only ever POSTs the resulting manifest.json + small
 *     metadata to the Fiodos backend — never source code.
 *   - The ANALYSIS (AI) step differs by mode:
 *       · default (hosted/proxy): your source code IS sent to the Fiodos
 *         backend, which relays it to the AI provider with Fiodos's key. Held
 *         in memory for the call only; never stored or logged.
 *       · --own-ai-key: your source code is sent to the AI provider directly
 *         from this machine and never touches the Fiodos backend.
 *       · --no-llm: no source code is sent anywhere (static routes only).
 *
 * Output:
 *   manifest.json     — AppManifest (schema of @fiodos/core), verified
 *   provenance.json   — per route/action: verification result or drop reason
 *   evidence.json     — model's claimed evidence + declared uncertainties
 *   usage.json        — REAL token usage + cost in USD for this analysis
 *   files-sent.json   — exactly which files were included in the prompt
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEnv, loadAppEnv } = require('./loadEnv');
loadEnv();

const { scanRoutes } = require('./routes');
const { collectFiles } = require('./collect');
const { resolveAnalysisRoot } = require('./resolveAnalysisRoot');
const { analyzeWithAI, correctActionWiring, DEFAULT_MODEL, resolveModel } = require('./aiAnalyze');
const { verifyManifest } = require('./verify');
const { wireWebOrb, reportWireResult } = require('./wireWeb');
const { wireHandlers, reportHandlerResult } = require('./wireHandlers');
const { offerWriteEnv, printEnvManualReminder } = require('./writeEnv');
const { scoreSurface, computeSurface } = require('./scoreSurface');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
}

// Flags that consume the following token as their value. Used by the
// positional parser so a value like the path in `--out <dir>` is not mistaken
// for the target app root.
const VALUE_FLAGS = new Set([
  '--out', '--model', '--max-input-tokens', '--platform', '--api-key', '--api-url',
]);

/**
 * Positional (non-flag) arguments, skipping flags and their values. Lets the
 * CLI accept BOTH `fiodos analyze <dir> [flags]` (the form the dashboard prints)
 * and the bare `fiodos <dir> [flags]`. Without this, the literal word "analyze"
 * was read as the target directory (the published-CLI bug this fixes).
 */
function positionalArgs() {
  const rest = process.argv.slice(2);
  const out = [];
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (tok.startsWith('-')) {
      if (VALUE_FLAGS.has(tok) && i + 1 < rest.length && !rest[i + 1].startsWith('-')) {
        i += 1; // consume the flag's value
      }
      continue;
    }
    out.push(tok);
  }
  return out;
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
  return process.argv.includes('--verbose') || process.argv.includes('-v') || process.argv.includes('--debug');
}

function logDev(...args) {
  if (isVerbose()) console.log(...args);
}

/** Branded one-liner for the developer running the CLI (not internal ops). */
function logUser(line) {
  const { blue, cyan, reset } = fyodosTermColors();
  console.log(`${cyan}◉${reset} ${blue}Fiodos${reset} · ${line}`);
}

/** Spinner copy: "website" for web targets, "app" for mobile/native. */
function surfaceNoun(platform) {
  return platform === 'web' ? 'website' : 'app';
}

function orbMountSpinnerLabel(platform) {
  return `Mounting the orb on your ${surfaceNoun(platform)}`;
}

function wiringSpinnerLabel(platform) {
  return `Wiring actions to your ${surfaceNoun(platform)}`;
}

/** Branded terminal spinner (Fiodos orb + colors when stderr is a TTY). */
async function withSpinner(label, work) {
  const orbFrames = ['◴', '◷', '◶', '◵'];
  const brailleFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const { blue, cyan, dim, reset } = fyodosTermColors();
  let currentLabel = label;
  let frame = 0;
  let id = null;
  const start = Date.now();

  const render = () => {
    const sec = Math.floor((Date.now() - start) / 1000);
    const orb = orbFrames[frame % orbFrames.length];
    const tail = brailleFrames[frame % brailleFrames.length];
    const line =
      `${cyan}${orb}${reset} ${blue}Fiodos${reset} ${dim}${tail}${reset}  ${currentLabel}… ${dim}${sec}s${reset}`;
    process.stderr.write(`\r\x1b[K${line}`);
    frame += 1;
  };

  const clearLine = () => process.stderr.write('\r\x1b[K');

  const startSpinner = () => {
    render();
    id = setInterval(render, 140);
  };

  const pause = () => {
    if (id) {
      clearInterval(id);
      id = null;
      clearLine();
    }
  };

  const resume = () => {
    if (!id) startSpinner();
  };

  const setLabel = (next) => {
    currentLabel = next;
  };

  startSpinner();
  try {
    return await work({ setLabel, pause, resume });
  } finally {
    pause();
  }
}

async function main() {
  // Accept an optional leading `analyze` subcommand: `fiodos analyze <dir>`.
  let positionals = positionalArgs();
  if (positionals[0] === 'analyze') positionals = positionals.slice(1);
  const appRoot = positionals[0] || '.';
  // Default output dir lives in the OS temp dir, NOT inside the installed
  // package (when run via npx, __dirname is under node_modules and writing
  // there pollutes the package). Operators can still override with --out.
  const inputRoot = path.resolve(appRoot);
  const safeName = path.basename(inputRoot).replace(/[^a-z0-9_-]/gi, '_') || 'app';
  const outDir = arg('--out', path.join(os.tmpdir(), 'fiodos', 'analysis', safeName));
  // Model precedence: explicit --model (operator override) > backend plan model
  // (resolved below from the analysis-quota pre-check) > DEFAULT_MODEL fallback.
  const explicitModel = arg('--model', '');
  let model = resolveModel(explicitModel || DEFAULT_MODEL);
  const maxInputTokens = Number(arg('--max-input-tokens', '150000'));
  const useLLM = !process.argv.includes('--no-llm');
  fs.mkdirSync(outDir, { recursive: true });

  const platformArg = (arg('--platform', '') || '').toLowerCase();
  const KNOWN_PLATFORMS = ['web', 'mobile', 'flutter', 'ios', 'android'];
  const forcedPlatform = KNOWN_PLATFORMS.includes(platformArg) ? platformArg : null;

  // ── 1. Static route scan (cheap facts; also the route verifier's ground truth)
  // Platform: auto-detected from package.json / native manifests, or forced with
  // --platform. Web apps have no static route ground truth, so the AI proposes
  // routes and we keep them unverified (honest flag).
  const { appDir, routes: scannedRoutes } = scanRoutes(inputRoot);
  const platform = forcedPlatform ?? detectPlatform(inputRoot, appDir);

  // Monorepos: scope analysis to the sub-app for this platform (e.g. frontend/
  // for Next, mobile/ for Expo) so the web orb never inherits mobile actions.
  const explicitAnalysisRoot = arg('--analysis-root', '');
  const scope = explicitAnalysisRoot
    ? { root: path.resolve(explicitAnalysisRoot), scoped: true, reason: '--analysis-root' }
    : resolveAnalysisRoot(inputRoot, platform);
  const analysisRoot = scope.root;
  if (scope.scoped) {
    const rel = path.relative(inputRoot, analysisRoot) || '.';
    logDev(
      `Scoped to ${rel} (${platform} app) — analyzing this folder only, not the whole repo.`,
    );
    logDev(`[scope] input=${inputRoot} analysis=${analysisRoot} reason=${scope.reason}`);
  }

  const { appDir: scopedAppDir, routes: scopedRoutes } = scanRoutes(analysisRoot);
  // The expo-router filesystem scan ONLY describes a mobile app. A Next.js App
  // Router web app also has an app/ dir, so the scan would otherwise produce
  // bogus "routes" and misclassify the project; for web we ignore it and let
  // the AI propose routes (the documented web contract).
  // Only Expo/RN ('mobile') has a static route ground truth. Web AND the native
  // platforms (flutter/ios/android) have the AI infer routes (kept unverified).
  const routes = platform === 'mobile' ? scopedRoutes : [];
  const verifyRoutes = platform === 'mobile' && routes.length > 0;
  const appMeta = readAppMeta(analysisRoot);
  logDev(`[static] platform=${platform} routes=${routes.length}` +
    (platform === 'web' ? ' (web: routes inferred by AI, not statically verified)' : ''));

  // ── 2. Collect source files (rule-based, budget-aware) ────────────────────
  const { included, omitted, estimatedTokens } = collectFiles(analysisRoot, { maxInputTokens, platform });
  fs.writeFileSync(path.join(outDir, 'files-sent.json'), JSON.stringify({
    included: included.map((f) => f.rel),
    omitted,
  }, null, 2));
  logDev(`[collect] files=${included.length} (~${estimatedTokens} tokens)` +
    (omitted.length ? ` omitted=${omitted.length} (over budget)` : ''));

  // ── 2c. Reachability surface (web) — computed BEFORE the AI call so it can
  // GUIDE detection, not just clean up afterwards. It tells the model which
  // files are the live product (reachable from the home) vs secondary code, and
  // hands it the concrete link elements on those pages (download/contact/social/
  // anchors) so landing-page actions stop being invisible. Reused after verify
  // for scoring (no recompute). Best-effort: never blocks analysis.
  let surface = null;
  try {
    surface = computeSurface({ included, analysisRoot, platform });
    logDev(`[surface] pre-analysis applied=${surface.applied} reason=${surface.reason} ` +
      `reachable=${surface.reached.size} links=${surface.productLinks.length}`);
  } catch (e) {
    logDev(`[surface] pre-analysis skipped: ${e.message}`);
  }

  let manifest;
  let provenance;
  let evidence = {};
  let wiring = {};
  let analysisMeta = { engine: 'auto-manifest-v3-ai-first', model: null, costUSD: 0 };
  // Signed proof returned by the hosted-analysis proxy: it tells the publish
  // step the quota was already consumed at /v1/developer/analyze (no double
  // count). Null in own-key / --no-llm mode.
  let analysisToken = null;

  if (!useLLM) {
    // Static-only fallback: routes with mechanical naming, no actions.
    // Useful as a free smoke pass or when sending code to an AI provider
    // is not acceptable for this app.
    ({ manifest, provenance } = routesOnlyManifest(appMeta, routes));
    logDev('[no-llm] static-only manifest (routes only, no actions)');
    logUser('Static analysis complete');
  } else {
    // Hybrid AI-key model. DEFAULT: hosted analysis via the Fiodos backend
    // proxy (Fiodos's AI key, no key needed by the developer). With
    // --own-ai-key the analysis runs locally against the developer's own
    // provider key (privacy path: source code goes straight to the AI and
    // never reaches Fiodos). --no-llm (handled above) sends no code anywhere.
    loadAppEnv(analysisRoot);
    const { apiKey, apiUrl } = resolveApiTarget();
    const useProxy = !process.argv.includes('--own-ai-key');

    // ── 2b. Plan quota pre-check (before spending any AI tokens) ─────────────
    // Ask the backend whether this project's plan still allows an analysis. The
    // Free plan includes exactly one; paid plans allow several. Both the proxy
    // and the publish step re-check server-side, so this is a courtesy to fail
    // fast (and, in own-key mode, to avoid wasting the developer's tokens).
    if (apiKey) {
      const quota = await fetchAnalysisQuota({ apiKey, apiUrl });
      if (quota && quota.allowed === false) {
        printQuotaBlocked(quota);
        return;
      }
      // Tier-based model: the backend tells us which model this plan is
      // entitled to. The user never sees or sets it. An explicit --model
      // (operator override) always wins. In proxy mode the server forces the
      // model regardless; this only matters for the own-key path.
      if (!explicitModel && quota && quota.model) {
        model = resolveModel(quota.model);
      }
    }

    // ── 3. AI reads the code ────────────────────────────────────────────────
    const { parsed, usage, costUSD, elapsedMs, promptChars, model: usedModel, analysisToken: token } =
      await withSpinner(
        'Analyzing your project — may take 1–2 min',
        () => analyzeWithAI({
          appMeta, files: included, omitted, staticRoutes: routes, model, platform,
          useProxy, apiKey, apiUrl, surface,
        }),
      );
    if (usedModel) model = usedModel;
    analysisToken = token || null;
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
    logUser('Analysis complete');

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

  // ── 4c. Product-surface scoring (conservative, default-OFF for clear noise).
  // Existence is already proven; this asks the SEPARATE question "is this part
  // of the live product surface the orb should expose by default?". Routes/
  // actions whose screens are UNREACHABLE by navigation from the deployed entry
  // (orphans / dead code / a secondary app mirrored in the repo) AND not behind
  // auth are annotated low-confidence and published DISABLED-by-default — never
  // dropped (no new hallucination risk) and never empties an auth-gated app.
  // Anything uncertain stays ACTIVE (fail towards including). The on/off lives
  // in the workspace's disabled-intent sets (reused infra); the developer flips
  // it in the dashboard. Web-first; other platforms are not scored yet.
  let surfaceScore = { disabledRouteIntents: [], disabledActionIntents: [], stats: { applied: false } };
  try {
    surfaceScore = scoreSurface({ manifest, evidence, included, analysisRoot, platform, surface });
    for (const r of manifest.routes) {
      const s = surfaceScore.routes && surfaceScore.routes[r.intent];
      if (s) { r.surfaceConfidence = s.confidence; r.surfaceReason = s.reason; }
    }
    for (const a of manifest.actions) {
      const s = surfaceScore.actions && surfaceScore.actions[a.intent];
      if (s) { a.surfaceConfidence = s.confidence; a.surfaceReason = s.reason; }
    }
    logDev(`[surface] ${JSON.stringify(surfaceScore.stats)}`);
  } catch (e) {
    // Scoring is best-effort: a failure must never block publishing. Fail OPEN
    // (everything stays active) — consistent with the "fail towards including".
    logDev(`[surface] skipped: ${e.message}`);
  }

  // ── 5. Final gate: the real @fiodos/core validator ─────────────────────────
  // Loaded as a package dependency (not a monorepo path) so it resolves when
  // the CLI is installed from npm.
  try {
    const { validateManifest } = require('@fiodos/core');
    const validation = validateManifest(manifest);
    provenance.coreValidation = validation;
    logDev(`[validate] @fiodos/core validateManifest → valid=${validation.valid}` +
      (validation.errors?.length ? ` errors=${JSON.stringify(validation.errors)}` : ''));
  } catch (e) {
    provenance.coreValidation = { skipped: `@fiodos/core validateManifest unavailable: ${e.message}` };
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, 'provenance.json'), JSON.stringify(provenance, null, 2));
  logDev(`[done] manifest: ${manifest.routes.length} routes, ${manifest.actions.length} actions`);
  logDev(`[done] output → ${outDir}`);

  const publishing = process.argv.includes('--publish');
  const publishMeta = {
    ...analysisMeta,
    generatedAt: new Date().toISOString(),
    routesIncluded: manifest.routes.length,
    actionsIncluded: manifest.actions.length,
    // Conservative default-OFF set for low-confidence (orphan) routes/actions.
    // The backend applies these to the workspace's disabled-intent sets ONLY on
    // the first publish / when the developer has not customized scope (no
    // clobbering manual choices). Empty when scoring did not apply.
    scopeDefaults: {
      disabledRouteIntents: surfaceScore.disabledRouteIntents || [],
      disabledActionIntents: surfaceScore.disabledActionIntents || [],
    },
  };

  // Informative, non-blocking summary (the dashboard is where scope is managed).
  const offR = (surfaceScore.disabledRouteIntents || []).length;
  const offA = (surfaceScore.disabledActionIntents || []).length;
  if (surfaceScore.stats && surfaceScore.stats.applied && (offR || offA)) {
    const onR = manifest.routes.length - offR;
    const onA = manifest.actions.length - offA;
    logUser(`Main surface (active): ${onR} route(s), ${onA} action(s)`);
    logUser(
      `Detected but off by default: ${offR} route(s), ${offA} action(s) — ` +
      `not reachable from your app's home (likely internal/secondary screens)`,
    );
    logUser('Review or re-enable any of them in your dashboard → Agent configuration');
  }

  // ── 6. Web: offer to wire the orb into the app (consent-based) ─────────────
  // The same command the developer already runs also drops <FiodosAgent/> into
  // their app, so the onboarding never needs a separate manual step. Mobile is
  // wired by its own installer and is intentionally left untouched here.
  if (platform === 'web') {
    const { apiKey, apiUrl } = resolveApiTarget();
    const assumeYes = process.argv.includes('--yes') || process.argv.includes('--wire-yes');
    const noWire = process.argv.includes('--no-wire');
    let envWriteResult = null;
    const { runPostWireTest } = require('./postWireTest');
    const selfCorrect = !process.argv.includes('--no-self-correct');
    const corrector = selfCorrect
      ? async (args) => {
          const { wiring: fixed } = await correctActionWiring({ ...args, model, platform });
          return fixed;
        }
      : null;
    const handlerOpts = {
      manifest,
      evidence,
      wiring,
      appName: manifest.appName,
      colors: fyodosTermColors(),
      assumeYes,
      noWire,
      quiet: !isVerbose(),
      runTest: !process.argv.includes('--no-wire-test'),
      revertOnFailure: true,
      testRunner: runPostWireTest,
      corrector,
      files: included,
      maxAttempts: Number(process.env.FYODOS_WIRE_MAX_ATTEMPTS || 3),
    };

    const runWebWire = async ({ setLabel, pause, resume }) => {
      // Emit a report on its OWN clean line: pause the live spinner (clears its
      // line), print, then resume. Without this, a log written while the spinner
      // is ticking gets glued onto the spinner line ("…10sFiodos · …").
      const report = (fn) => { pause(); fn(); resume(); };

      // --no-orb-wire skips ONLY the orb mount (useful to test handler wiring in
      // isolation without modifying the app's entrypoint / package.json).
      if (!process.argv.includes('--no-orb-wire')) {
        setLabel(orbMountSpinnerLabel(platform));
        if (!assumeYes) pause();
        const result = await wireWebOrb(analysisRoot, {
          apiUrl,
          colors: fyodosTermColors(),
          assumeYes,
          noWire,
          runTest: !process.argv.includes('--no-wire-test'),
        });
        if (!assumeYes) resume();
        report(() => reportWireResult(result, fyodosTermColors(), { quiet: !isVerbose() }));
        if (
          publishing &&
          apiKey &&
          (result.status === 'added' || result.status === 'already')
        ) {
          // Records the install proof so the dashboard onboarding orb check can
          // complete without booting the app. If the backend can't record it
          // (e.g. an outdated deployment without the endpoint), keep it as a
          // dev-only trace — it is not actionable noise for the end developer.
          const proof = await postOrbWired({ apiKey, apiUrl, file: result.file || '' });
          if (proof && proof.ok === false && proof.reason !== 'no-api-key') {
            logDev(`[orb-wired] install proof not recorded (status=${proof.status || proof.reason}); dashboard check will rely on a runtime ping`);
          }
        }
      }

      setLabel(wiringSpinnerLabel(platform));
      if (!assumeYes) pause();
      const handlerResult = await wireHandlers(analysisRoot, handlerOpts);
      if (!assumeYes) resume();
      report(() => reportHandlerResult(handlerResult, fyodosTermColors(), { quiet: !isVerbose() }));
    };

    if (publishing) {
      loadAppEnv(analysisRoot);
      await withSpinner('Publishing to your project', async (spinner) => {
        await publishManifest(manifest, publishMeta, analysisToken, { skipSuccessLog: true });
        await runWebWire(spinner);
      });
      logUser('Published to your project');
    } else {
      await withSpinner(orbMountSpinnerLabel(platform), runWebWire);
    }

    // ── 8. API key in environment (LAST step — always asks; independent of --yes)
    // --yes only skips orb/handler prompts. --write-env-yes skips this one (CI).
    // If the developer declines, we show a copy-paste reminder here at the end.
    if (publishing && !process.argv.includes('--no-write-env')) {
      try {
        envWriteResult = await offerWriteEnv({
          appRoot: analysisRoot,
          apiKey,
          apiUrl,
          defaultApiUrl: DEFAULT_API_URL,
          assumeYes: process.argv.includes('--write-env-yes'),
          log: logUser,
          logDev,
        });
        if (
          envWriteResult &&
          (envWriteResult.status === 'declined by user' || envWriteResult.status === 'manual')
        ) {
          printEnvManualReminder(envWriteResult.writePlan, { logUser, logDev });
        }
      } catch (e) {
        logDev(`[write-env] skipped: ${e.message}`);
      }
    }
  } else if (publishing) {
    loadAppEnv(analysisRoot);
    await withSpinner('Publishing to your project', () =>
      publishManifest(manifest, publishMeta, analysisToken, { skipSuccessLog: true }),
    );
    logUser('Published to your project');
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
 * developer's Fiodos project. Authenticated with the project API key shown in
 * the dashboard. Never sends source files, evidence or usage logs.
 */
// Production Fiodos backend. The published CLI defaults here so the dashboard's
// `npx @fiodos/cli analyze . --publish --api-key …` (no --api-url) reaches prod.
// Local dev overrides with --api-url http://localhost:8000 or FYODOS_API_URL
// (or the analyzed app's VITE/NEXT/EXPO_PUBLIC_FYODOS_API_URL via loadAppEnv).
const DEFAULT_API_URL = 'https://api.fyodos.com';

/** Resolve the Fiodos backend target (project API key + URL) from flags/env. */
function resolveApiTarget() {
  const apiKey = arg('--api-key', process.env.FYODOS_API_KEY || '');
  const apiUrl = (arg('--api-url', process.env.FYODOS_API_URL || DEFAULT_API_URL) || '').replace(/\/$/, '');
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

async function publishManifest(manifest, meta, analysisToken = null, opts = {}) {
  const { apiKey, apiUrl } = resolveApiTarget();
  if (!apiKey) {
    console.error(
      '[publish] missing project API key — add FYODOS_API_KEY or FYODOS_CLIENT_KEYS to backend/.env, or pass --api-key',
    );
    process.exit(1);
  }
  logDev(`[publish] POST ${apiUrl}/v1/developer/manifest (manifest + metadata only — no source code)`);
  logDev(`[publish] project API key: ${apiKey.slice(0, 12)}…`);
  // In proxy mode, forward the signed analysis token so the backend knows the
  // quota was already consumed at the analyze step (no double count). Stripped
  // server-side before the meta is persisted.
  const payloadMeta = analysisToken ? { ...meta, analysisToken } : meta;
  const res = await fetch(`${apiUrl}/v1/developer/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ manifest, meta: payloadMeta }),
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
  if (!opts.skipSuccessLog) {
    logUser('Published to your project');
  }
  logDev(`[publish] OK — ${body.routes} routes, ${body.actions} actions received at ${body.receivedAt}`);

  // Self-check: confirm the orb will find this manifest (silent unless --verbose).
  await verifyOrbCanFetch({ apiKey, apiUrl });
}

/**
 * Verify the just-published manifest is retrievable through the public client
 * endpoint with the same credentials, and tell the developer EXACTLY which key
 * and URL their running app must use. Never hard-fails the publish (the publish
 * already succeeded); a failed re-fetch is surfaced as an actionable warning.
 */
async function postOrbWired({ apiKey, apiUrl, file }) {
  if (!apiKey) return { ok: false, reason: 'no-api-key' };
  try {
    const res = await fetch(`${apiUrl}/v1/developer/orb-wired`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ file: file || '', platform: 'web' }),
    });
    if (res.ok) {
      logDev(`[orb-wired] install proof recorded (${file || 'web'})`);
      return { ok: true };
    }
    logDev(`[orb-wired] could not record install proof: HTTP ${res.status}`);
    return { ok: false, status: res.status };
  } catch (e) {
    logDev(`[orb-wired] skipped: ${e.message || e}`);
    return { ok: false, reason: e.message || String(e) };
  }
}
async function verifyOrbCanFetch({ apiKey, apiUrl }) {
  try {
    const res = await fetch(`${apiUrl}/v1/client/manifest`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data && data.manifest) {
        logDev(
          `[verify] manifest reachable with key ${apiKey.slice(0, 12)}… against ${apiUrl}`,
        );
        return true;
      }
    }
    logDev(`[verify] published but re-fetch failed: HTTP ${res.status}`);
  } catch (e) {
    logDev(`[verify] re-fetch failed: ${e.message}`);
  }
  return false;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
