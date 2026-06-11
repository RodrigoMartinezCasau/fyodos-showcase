#!/usr/bin/env node
/**
 * Fyodos auto-manifest engine (v2 experiment).
 *
 * Usage:
 *   OPENAI_API_KEY=... node src/index.js <target-app-root> --out <output-dir> \
 *       [--patterns <patterns-dir>] [--no-llm]
 *
 * Pipeline:
 *   Layer 1  static  — expo-router route scan + per-file AST extraction
 *   Layer 2  static  — import graph, store mapping, per-screen action surface
 *   Layer 3  llm     — explicit model calls (curation, naming, examples)
 *   Layer 4  pattern — classify app vs patterns/, gap-fill from the pattern
 *
 * Output:
 *   manifest.json     — AppManifest (schema of @fyodos/core)
 *   provenance.json   — per route/action: static | llm | pattern + evidence
 *   static-facts.json — raw layer 1+2 extraction (auditable)
 *   llm-log.json      — every LLM call made (task, tokens, latency)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { scanRoutes } = require('./routes');
const { buildGraph, mapScreens } = require('./graph');
const llm = require('./llm');
const { loadPatterns } = require('./patterns');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
}

// Plumbing names we never expose (cheap static prefilter before the LLM).
const PLUMBING_RE = /^(on|handle)?(Sheet|Backdrop|Render|Close|Dismiss|Change[A-Z]?|DateChange|TimeChange|SnapPoint)/i;
const PLUMBING_EXACT = new Set([
  'handleSheetChanges', 'handleClose', 'handleDateChange', 'handleTimeChange',
  'renderBackdrop', 'backdropComponent', 'handleCloseBottomSheet',
  'onPress', 'onLayout', 'onChange', 'onChangeText', 'onRefresh', 'onScroll',
]);

async function main() {
  const appRoot = process.argv[2];
  if (!appRoot) {
    console.error('Usage: node src/index.js <target-app-root> --out <dir> [--patterns <dir>] [--no-llm]');
    process.exit(1);
  }
  const outDir = arg('--out', path.join(__dirname, '../output', path.basename(appRoot)));
  const patternsDir = arg('--patterns', path.join(__dirname, '../../../patterns'));
  const useLLM = !process.argv.includes('--no-llm');
  fs.mkdirSync(outDir, { recursive: true });

  // ── Layer 1: routes + AST ─────────────────────────────────────────────────
  const { routes } = scanRoutes(appRoot);
  const graph = buildGraph(appRoot);
  const { screens, stores } = mapScreens(routes, graph);

  // App metadata from app.json / app.config / package.json (static)
  const appMeta = readAppMeta(appRoot);

  const staticFacts = {
    appMeta,
    routeCount: routes.length,
    routes: routes.map((r) => ({ routePath: r.routePath, file: r.relFile, isDynamic: r.isDynamic, params: r.params })),
    stores: stores.map((s) => ({ store: s.storeName, file: s.file, actions: s.actions, stateKeys: s.stateKeys })),
    screens: screens.map((s) => ({
      route: s.route.routePath,
      handlers: s.ownHandlers.map((h) => h.name),
      depHandlers: [...new Set(s.depHandlers.map((h) => h.name))],
      alerts: s.ownAlerts.concat(s.depAlerts).map((a) => ({ title: a.title, destructive: a.destructive, file: a.file })),
      buttons: s.ownButtons.concat(s.depButtons).filter((b) => b.title).map((b) => ({ title: b.title, handler: b.handler, file: b.file })),
      navTargets: [...new Set(s.ownNavCalls.concat(s.depNavCalls).map((n) => n.target).filter(Boolean))],
      textInputs: s.ownTextInputs.map((t) => t.placeholder).filter(Boolean),
      linking: [...new Set(s.ownLinking.concat(s.depLinking).map((l) => l.target))],
      stores: s.usedStores.map((u) => u.storeName),
    })),
  };
  fs.writeFileSync(path.join(outDir, 'static-facts.json'), JSON.stringify(staticFacts, null, 2));
  console.log(`[layer1+2] routes=${routes.length} stores=${stores.length} files=${graph.files.length}`);

  // ── Candidate actions (static assembly) ───────────────────────────────────
  const candidates = buildCandidates(screens, stores);
  console.log(`[layer2] action candidates (after plumbing filter): ${candidates.length}`);

  // ── Layer 4a: pattern classification (needs LLM) ─────────────────────────
  const patterns = loadPatterns(patternsDir);
  let classification = { pattern: 'none', confidence: 0, appKind: 'unknown', reason: 'llm disabled' };
  if (useLLM && patterns.length > 0) {
    classification = await llm.classifyApp(
      {
        appName: appMeta.name,
        routes: staticFacts.routes.map((r) => r.routePath),
        stores: staticFacts.stores.map((s) => ({ store: s.store, actions: s.actions })),
        sampleButtons: staticFacts.screens.flatMap((s) => s.buttons.map((b) => b.title)).slice(0, 25),
      },
      patterns.map((p) => ({ id: p.id, summary: p.summary })),
    );
    console.log(`[layer4] classification: ${JSON.stringify(classification)}`);
  }

  // ── Layer 3: LLM curation ────────────────────────────────────────────────
  let routeMeta = { routes: [] };
  let curated = { actions: [] };
  if (useLLM) {
    routeMeta = await llm.writeRouteMeta(
      classification.appKind,
      staticFacts.routes.map((r) => ({ routePath: r.routePath, file: r.file, isDynamic: r.isDynamic, params: r.params })),
    );
    console.log(`[layer3] route meta for ${routeMeta.routes.length} routes`);
    curated = await llm.curateActions(classification.appKind, candidates);
    console.log(`[layer3] curated ${curated.actions.length} action decisions`);
  }

  // ── Assemble manifest + provenance ───────────────────────────────────────
  const { manifest, provenance } = assemble(appMeta, routes, routeMeta, candidates, curated, classification);

  // ── Layer 4b: pattern gap-fill ───────────────────────────────────────────
  let gapFill = { suggestions: [], patternUseful: false, notes: 'pattern layer skipped (no match or llm disabled)' };
  const matched = patterns.find((p) => p.id === classification.pattern);
  if (useLLM && matched && classification.confidence >= 0.5) {
    gapFill = await llm.patternGapFill(matched.id, matched.text, {
      routes: manifest.routes.map((r) => r.intent),
      actions: manifest.actions.map((a) => ({ intent: a.intent, requireConfirmation: a.requireConfirmation })),
    });
  }
  provenance.patternLayer = {
    catalogSize: patterns.length,
    classification,
    matchedPattern: matched ? matched.id : null,
    gapFill,
  };

  // Final gate: validate against the real @fyodos/core validator if built.
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
  fs.writeFileSync(path.join(outDir, 'llm-log.json'), JSON.stringify(llm.getLog(), null, 2));
  console.log(`\n[done] manifest: ${manifest.routes.length} routes, ${manifest.actions.length} actions`);
  console.log(`[done] output → ${outDir}`);
}

function readAppMeta(appRoot) {
  const meta = { name: path.basename(appRoot), description: '' };
  const pkgPath = path.join(appRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    meta.name = pkg.name || meta.name;
    meta.description = pkg.description || '';
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
  // README first paragraph as description fallback (static text extraction)
  const readme = path.join(appRoot, 'README.md');
  if (!meta.description && fs.existsSync(readme)) {
    const lines = fs.readFileSync(readme, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    meta.description = (lines[0] || '').replace(/^[*\-\s]+/, '').slice(0, 300);
  }
  return meta;
}

/**
 * Static candidate assembly: every screen handler + store action consumed by
 * screens, deduped, with evidence attached (alerts → sensitivity signal,
 * buttons → user-facing label signal, inputs → parameter signal).
 */
function buildCandidates(screens, stores) {
  const byName = new Map();

  function add(name, kind, screenRoute, evidence) {
    if (PLUMBING_EXACT.has(name) || PLUMBING_RE.test(name) && !/^handle[A-Z]/.test(name)) return;
    const key = name;
    if (!byName.has(key)) {
      byName.set(key, { name, kind, screens: new Set(), evidence: { alerts: [], buttons: [], inputsNearby: [], linking: [] } });
    }
    const c = byName.get(key);
    c.screens.add(screenRoute);
    if (evidence) {
      for (const k of ['alerts', 'buttons', 'inputsNearby', 'linking']) {
        if (evidence[k]) c.evidence[k].push(...evidence[k]);
      }
    }
  }

  for (const s of screens) {
    const route = s.route.routePath;
    const alertEvidence = s.ownAlerts.concat(s.depAlerts).map((a) => ({ title: a.title, destructive: a.destructive }));
    const inputEvidence = s.ownTextInputs.map((t) => t.placeholder).filter(Boolean);

    // Functions referenced by buttons that do NOT follow the handle*/on*
    // naming convention (e.g. saveWorkout ← "Complete Workout" button).
    // Without this, central actions hidden behind buttons are lost.
    for (const b of s.ownButtons.concat(s.depButtons)) {
      if (!b.handler || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(b.handler)) continue;
      if (b.handler.startsWith('set') || b.handler === 'router') continue; // state setters / nav plumbing
      const known = s.ownHandlers.concat(s.depHandlers).some((h) => h.name === b.handler);
      if (!known) {
        add(b.handler, 'button-handler', route, {
          alerts: alertEvidence.filter((a) => a.destructive),
          buttons: b.title ? [b.title] : [],
          inputsNearby: [],
          linking: [],
        });
      }
    }

    for (const h of s.ownHandlers) {
      // attach button whose onPress references this handler
      const btns = s.ownButtons.concat(s.depButtons)
        .filter((b) => b.handler && b.handler.includes(h.name))
        .map((b) => b.title)
        .filter(Boolean);
      // attach alerts raised inside same file (approximation: same screen)
      add(h.name, 'handler', route, {
        alerts: alertEvidence.filter((a) => a.destructive || /sign out|delete|remove|reset|cancel/i.test(a.title)),
        buttons: btns,
        inputsNearby: inputEvidence,
        linking: s.ownLinking.map((l) => l.target),
      });
    }
    for (const h of s.depHandlers) {
      const btns = s.ownButtons.concat(s.depButtons)
        .filter((b) => b.handler && b.handler.includes(h.name))
        .map((b) => b.title)
        .filter(Boolean);
      add(h.name, 'handler(dep)', route, { buttons: btns });
    }
    for (const st of s.usedStores) {
      for (const a of st.actions) add(a, `store:${st.storeName}`, route, {});
    }
  }

  return [...byName.values()].map((c) => ({
    name: c.name,
    kind: c.kind,
    screens: [...c.screens],
    evidence: {
      alerts: dedupe(c.evidence.alerts.map((a) => `${a.destructive ? '[destructive] ' : ''}${a.title}`)),
      buttons: dedupe(c.evidence.buttons),
      inputsNearby: dedupe(c.evidence.inputsNearby).slice(0, 5),
      linking: dedupe(c.evidence.linking).slice(0, 5),
    },
  }));
}

function dedupe(arr) {
  return [...new Set(arr)];
}

function assemble(appMeta, routes, routeMeta, candidates, curated, classification) {
  const provenance = { routes: [], actions: [], notes: [] };

  // Routes: existence is static; intent/label/examples are LLM.
  const manifestRoutes = [];
  for (const rm of routeMeta.routes || []) {
    const staticRoute = routes.find((r) => r.routePath === rm.routePath);
    if (!staticRoute) {
      provenance.notes.push(`LLM invented route ${rm.routePath} — DROPPED (not in static scan)`);
      continue; // hallucination guard: route must exist statically
    }
    if (rm.skip) {
      provenance.routes.push({
        routePath: rm.routePath,
        included: false,
        reason: rm.skipReason || 'skipped by LLM',
        existence: 'static',
        naming: 'llm',
      });
      continue;
    }
    manifestRoutes.push({
      intent: rm.intent,
      label: rm.label,
      route: staticRoute.routePath,
      examples: rm.examples || [],
    });
    provenance.routes.push({
      routePath: rm.routePath,
      included: true,
      intent: rm.intent,
      existence: 'static (file system scan)',
      naming: 'llm (intent, label, examples)',
      file: staticRoute.relFile,
    });
  }
  // BACK route: static convention of the SDK
  manifestRoutes.push({ intent: 'back', label: 'Back', route: 'BACK', examples: ['go back', 'back', 'previous screen'] });
  provenance.routes.push({ routePath: 'BACK', included: true, intent: 'back', existence: 'static (SDK convention)', naming: 'static' });

  // Actions: candidate existence is static; exposure/naming/sensitivity is LLM.
  // Intents share one namespace with routes (core validator enforces it).
  const manifestActions = [];
  const seenIntents = new Set(manifestRoutes.map((r) => r.intent));
  for (const a of curated.actions || []) {
    // Schema coercion: some models return intent as {id,label,category}.
    if (a.intent && typeof a.intent === 'object') {
      a.category = a.category && a.category !== 'other' ? a.category : a.intent.category;
      a.label = a.label || a.intent.label;
      a.intent = a.intent.id;
    }
    let cand = candidates.find((c) => c.name === a.source_name);
    if (!cand && a.intent) {
      // Recovery: some model outputs omit source_name; match by snake_case
      // intent ↔ camelCase candidate name (still traceable to static evidence).
      const camel = String(a.intent).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      cand = candidates.find(
        (c) => c.name === camel || c.name.toLowerCase() === camel.toLowerCase() ||
          c.name.toLowerCase() === ('handle' + camel).toLowerCase(),
      );
      if (cand) a.source_name = cand.name;
    }
    if (!cand) {
      provenance.notes.push(`LLM returned action for unknown candidate '${a.source_name || a.intent}' — DROPPED`);
      continue; // hallucination guard: action must trace to a detected callable
    }
    if (!a.expose) {
      provenance.actions.push({
        source: a.source_name,
        included: false,
        reason: a.evidence_used || 'not agent-worthy (LLM)',
        detection: 'static',
        curation: 'llm',
      });
      continue;
    }
    if (seenIntents.has(a.intent)) {
      const renamed = `${a.intent}_action`;
      if (seenIntents.has(renamed)) {
        provenance.notes.push(`Duplicate intent '${a.intent}' from '${a.source_name}' — DROPPED (kept first occurrence)`);
        continue;
      }
      provenance.notes.push(`Intent '${a.intent}' collided with a route intent — renamed to '${renamed}' (static dedup)`);
      a.intent = renamed;
    }
    seenIntents.add(a.intent);
    // Static normalization: ParameterSpec only admits string|number|boolean.
    for (const spec of Object.values(a.parameters || {})) {
      if (spec.type === 'integer' || spec.type === 'float') spec.type = 'number';
      else if (!['string', 'number', 'boolean'].includes(spec.type)) spec.type = 'string';
      if (typeof spec.required !== 'boolean') spec.required = false;
      if (typeof spec.description !== 'string') spec.description = '';
    }
    manifestActions.push({
      intent: a.intent,
      label: a.label,
      category: a.category || 'other',
      handler: a.source_name,
      requireConfirmation: a.requireConfirmation === true,
      ...(a.requireConfirmation && a.confirmationMessage
        ? { confirmationMessageTemplate: a.confirmationMessage }
        : {}),
      parameters: a.parameters || {},
      contextRequirements: {
        ...(a.requiresVisibleContent ? { requiresVisibleContent: true } : {}),
        requiresAuth: true,
      },
      examples: a.examples || [],
    });
    provenance.actions.push({
      source: a.source_name,
      included: true,
      intent: a.intent,
      detection: `static (${cand.kind}; screens: ${cand.screens.join(', ')})`,
      staticEvidence: cand.evidence,
      curation: 'llm (expose, intent, label, category, confirmation, parameters, examples)',
      llmEvidenceUsed: a.evidence_used || null,
    });
  }

  // Completeness accounting: candidates the LLM never ruled on.
  const decided = new Set((curated.actions || []).map((a) => a.source_name).filter(Boolean));
  for (const c of candidates) {
    if (!decided.has(c.name)) {
      provenance.actions.push({
        source: c.name,
        included: false,
        reason: 'no LLM decision returned (model omission) — needs human review',
        detection: `static (${c.kind})`,
        curation: 'none',
      });
    }
  }

  const manifest = {
    appId: appMeta.bundleId || `auto.${appMeta.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`,
    appName: appMeta.name,
    appDescription: appMeta.description || `${classification.appKind} app (auto-detected)`,
    version: '0.1.0-auto-v2',
    routes: manifestRoutes,
    actions: manifestActions,
    policies: {
      requireConfirmationForDestructive: true,
      allowedWithoutAuth: [],
      contextRetentionTurns: 5,
    },
  };

  return { manifest, provenance };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
