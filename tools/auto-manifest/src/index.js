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
 *       [--model gpt-5] [--max-input-tokens 150000] [--no-llm] \
 *       [--publish [--api-key <fyodos-project-api-key>] [--api-url <backend-url>]]
 *
 * Env (auto-loaded from tools/auto-manifest/.env and fyodos/backend/.env;
 * shell exports take precedence):
 *   OPENAI_API_KEY      — AI analysis (your key, your cost)
 *   FYODOS_API_KEY      — project key for --publish (or the analyzed app's
 *                         EXPO_PUBLIC_FYODOS_API_KEY, which wins)
 *
 * PRIVACY:
 *   - The analysis runs on THIS machine. With --publish, only the resulting
 *     manifest.json + small metadata are POSTed to the Fyodos backend.
 *     Source files NEVER reach the Fyodos backend.
 *   - The AI step sends the collected source files to the AI provider
 *     (OpenAI API) using the developer's own key. Use --no-llm for a
 *     static-only pass (routes, no actions) if that is not acceptable.
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
const { analyzeWithAI, DEFAULT_MODEL } = require('./aiAnalyze');
const { verifyManifest } = require('./verify');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  const appRoot = process.argv[2];
  if (!appRoot) {
    console.error('Usage: node src/index.js <target-app-root> --out <dir> [--model gpt-5] [--no-llm] [--publish]');
    process.exit(1);
  }
  const outDir = arg('--out', path.join(__dirname, '../output', path.basename(appRoot)));
  const model = arg('--model', DEFAULT_MODEL);
  const maxInputTokens = Number(arg('--max-input-tokens', '150000'));
  const useLLM = !process.argv.includes('--no-llm');
  fs.mkdirSync(outDir, { recursive: true });

  // ── 1. Static route scan (cheap facts; also the route verifier's ground truth)
  const { routes } = scanRoutes(appRoot);
  const appMeta = readAppMeta(appRoot);
  console.log(`[static] routes=${routes.length}`);

  // ── 2. Collect source files (rule-based, budget-aware) ────────────────────
  const { included, omitted, estimatedTokens } = collectFiles(appRoot, { maxInputTokens });
  fs.writeFileSync(path.join(outDir, 'files-sent.json'), JSON.stringify({
    included: included.map((f) => f.rel),
    omitted,
  }, null, 2));
  console.log(`[collect] files=${included.length} (~${estimatedTokens} tokens)` +
    (omitted.length ? ` omitted=${omitted.length} (over budget)` : ''));

  let manifest;
  let provenance;
  let analysisMeta = { engine: 'auto-manifest-v3-ai-first', model: null, costUSD: 0 };

  if (!useLLM) {
    // Static-only fallback: routes with mechanical naming, no actions.
    // Useful as a free smoke pass or when sending code to an AI provider
    // is not acceptable for this app.
    ({ manifest, provenance } = routesOnlyManifest(appMeta, routes));
    console.log('[no-llm] static-only manifest (routes only, no actions)');
  } else {
    // ── 3. AI reads the code ────────────────────────────────────────────────
    const { parsed, usage, costUSD, elapsedMs, promptChars } = await analyzeWithAI({
      appMeta, files: included, omitted, staticRoutes: routes, model,
    });
    const proposed = parsed.manifest || {};
    const evidence = parsed.evidence || {};
    console.log(`[ai] model=${model} proposed routes=${(proposed.routes || []).length} ` +
      `actions=${(proposed.actions || []).length} in ${(elapsedMs / 1000).toFixed(1)}s`);
    console.log(`[ai] tokens in=${usage.prompt_tokens} out=${usage.completion_tokens} cost=$${costUSD.toFixed(4)}`);

    // ── 4. Mechanical verification of the AI's claims ───────────────────────
    ({ manifest, provenance } = verifyManifest(proposed, evidence, included, routes));
    ensureBackRoute(manifest, provenance);
    const droppedActions = provenance.actions.filter((a) => !a.included).length;
    const droppedRoutes = provenance.routes.filter((r) => !r.included).length;
    console.log(`[verify] kept routes=${manifest.routes.length} actions=${manifest.actions.length}` +
      ` | dropped: ${droppedRoutes} routes, ${droppedActions} actions (unproven evidence)`);

    fs.writeFileSync(path.join(outDir, 'evidence.json'), JSON.stringify({
      evidence, uncertain: parsed.uncertain || [],
    }, null, 2));
    fs.writeFileSync(path.join(outDir, 'usage.json'), JSON.stringify({
      model, elapsedMs, usage,
      costUSD: Number(costUSD.toFixed(4)),
      promptChars, filesSent: included.length, filesOmitted: omitted.length,
    }, null, 2));

    analysisMeta = {
      engine: 'auto-manifest-v3-ai-first',
      model,
      appKind: parsed.appKind || 'unknown',
      costUSD: Number(costUSD.toFixed(4)),
      droppedActions,
      droppedRoutes,
    };
  }

  // ── 5. Final gate: the real @fyodos/core validator ─────────────────────────
  try {
    const { validateManifest } = require(path.join(__dirname, '../../../packages/core/dist/manifest/validate.js'));
    const validation = validateManifest(manifest);
    provenance.coreValidation = validation;
    console.log(`[validate] @fyodos/core validateManifest → valid=${validation.valid}` +
      (validation.errors?.length ? ` errors=${JSON.stringify(validation.errors)}` : ''));
  } catch {
    provenance.coreValidation = { skipped: 'core dist not built' };
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, 'provenance.json'), JSON.stringify(provenance, null, 2));
  console.log(`\n[done] manifest: ${manifest.routes.length} routes, ${manifest.actions.length} actions`);
  console.log(`[done] output → ${outDir}`);

  if (process.argv.includes('--publish')) {
    loadAppEnv(path.resolve(appRoot));
    await publishManifest(manifest, {
      ...analysisMeta,
      generatedAt: new Date().toISOString(),
      routesIncluded: manifest.routes.length,
      actionsIncluded: manifest.actions.length,
    });
  }
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

/**
 * POST the resulting manifest (and only the manifest + small metadata) to the
 * developer's Fyodos project. Authenticated with the project API key shown in
 * the dashboard. Never sends source files, evidence or usage logs.
 */
async function publishManifest(manifest, meta) {
  const apiKey = arg('--api-key', process.env.FYODOS_API_KEY || '');
  const apiUrl = (arg('--api-url', process.env.FYODOS_API_URL || 'http://localhost:8000') || '').replace(/\/$/, '');
  if (!apiKey) {
    console.error(
      '[publish] missing project API key — add FYODOS_API_KEY or FYODOS_CLIENT_KEYS to backend/.env, or pass --api-key',
    );
    process.exit(1);
  }
  console.log(`[publish] POST ${apiUrl}/v1/developer/manifest (manifest + metadata only — no source code)`);
  console.log(`[publish] project API key: ${apiKey.slice(0, 12)}…`);
  const res = await fetch(`${apiUrl}/v1/developer/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ manifest, meta }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[publish] FAILED ${res.status}: ${text || res.statusText}`);
    process.exit(1);
  }
  const body = await res.json();
  console.log(`[publish] OK — ${body.routes} routes, ${body.actions} actions received at ${body.receivedAt}`);
  console.log('[publish] open the dashboard → Configuración del agente → "Recargar análisis" to review the draft');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
