/**
 * Source collector for the AI-first engine.
 *
 * Cheap, rule-based file selection — NOT analysis. It cannot "fail to zero":
 * every code file is included unless it is objectively irrelevant (deps,
 * native projects, assets, tests, build configs). When the app exceeds the
 * input budget, files are prioritized by tier (screens/state/services first,
 * generic UI last) and the omitted ones are reported so the model can declare
 * what it did not see.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Per-platform collection profile: which source extensions are code, and which
 * directories to skip. Native (Phase 1) reuses the SAME budget + tiering + AI
 * pipeline as web/mobile — only the file selection differs by language.
 */
const PROFILES = {
  web: {
    exts: ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte'],
    skipDirs: [
      'node_modules', 'assets', '.git', 'dist', 'build', '.expo', 'android', 'ios', 'coverage',
      '.next', 'web-build',
      // Monorepo siblings: never mix mobile/native code into a web analysis.
      'mobile', 'native', 'flutter', 'react-native', 'expo',
    ],
  },
  mobile: {
    exts: ['.ts', '.tsx', '.js', '.jsx'],
    skipDirs: ['node_modules', 'assets', '.git', 'dist', 'build', '.expo', 'android', 'ios', 'coverage', '.next', 'web-build'],
  },
  // Flutter: analyze lib/ (Dart); skip the native host wrappers + build output.
  flutter: {
    exts: ['.dart'],
    skipDirs: ['.git', '.dart_tool', 'build', 'android', 'ios', 'web', 'linux', 'macos', 'windows', 'test', 'integration_test'],
  },
  // iOS: analyze Swift sources; skip SwiftPM/Xcode build output.
  ios: {
    exts: ['.swift'],
    skipDirs: ['.git', '.build', 'build', 'DerivedData', 'Pods', 'Carthage', 'Tests'],
  },
  // Android: analyze Kotlin sources; skip Gradle build output.
  android: {
    exts: ['.kt'],
    skipDirs: ['.git', '.gradle', 'build', '.idea'],
  },
  // Shopify theme repo (GitHub-synced Liquid theme). The "code" is the theme's
  // Liquid templates + JSON templates/settings; heavy static assets are noise.
  shopify: {
    exts: ['.liquid', '.json'],
    skipDirs: ['.git', 'node_modules', 'assets', 'dist', 'build'],
  },
};

const SKIP_FILES = /\.(d\.ts|test\.|spec\.)|babel\.config|metro\.config|tailwind\.config|postcss\.config|jest\.config|eslint/;
const SKIP_NATIVE_FILES = /\.(g\.dart|freezed\.dart|gr\.dart|mocks\.dart)$|_test\.(dart|kt|swift)$|Test\.kt$|Tests\.swift$/;

/** Chars→tokens for budgeting. Source code (esp. TS/TSX/JSX, which is symbol
 *  dense) tokenizes closer to ~3.0 chars/token than the ~3.6 of prose. Budgeting
 *  with the optimistic 3.6 let the prompt admit ~540k chars for a nominal "150k
 *  token" budget, which is really ~165-180k tokens — and once the backend adds
 *  its fixed 30k output reservation, input + max_tokens crossed Claude's 200k
 *  context window and the provider rejected the call (surfaced as a 502). Using
 *  the conservative real ratio keeps real input near the nominal budget so there
 *  is always headroom for the output. */
const CHARS_PER_TOKEN = 3.0;

/** Lower tier = higher priority when the budget forces choices. Generalized so
 *  it ranks screens/state/services first across web, RN AND native naming. */
function tierFor(rel, platform) {
  const p = rel.replace(/\\/g, '/');
  if (platform === 'shopify') {
    // Shopify theme layout: templates define the store's pages; layout + locales
    // carry structure and language; sections/snippets are secondary UI.
    if (/^(layout|templates)\//.test(p)) return 0;
    if (/^locales\//.test(p)) return 1;
    if (/^sections\//.test(p)) return 2;
    return 3; // snippets/, config/ (settings_data.json can be huge), rest
  }
  return tierForApp(p);
}

/** Central-state files: the providers/stores/contexts that DEFINE the setters
 *  which turn screen controls into wireable actions (patchWorkspace, saveAll,
 *  switchProject…). These are guaranteed into the analysis (see collectFiles):
 *  a screen without its provider yields navigation but no actions, so the
 *  provider is worth more than any single screen for ACTION detection. */
function isCentralStateFile(rel) {
  const p = rel.replace(/\\/g, '/');
  const file = p.split('/').pop() || '';
  return (
    /(^|\/)(state|stores?|context|contexts|redux|providers?|blocs?|cubits?|viewmodels?)\//i.test(p) ||
    /(viewmodel|notifier|bloc|cubit|store|controller)\.(dart|kt|swift)$/i.test(p) ||
    // Persisted-state / store modules by filename (e.g. clientStore.ts,
    // appStore.ts) even when they live under lib/ — they hold the app's
    // config and the persistence the provider patches.
    /[a-z0-9]*store\.(ts|tsx|js|jsx)$/i.test(file)
  );
}

/** CONFIG / TYPE-DEFINITION modules: the files that ENUMERATE the fields a
 *  provider's patch functions accept (theme configs, workspace/settings shapes,
 *  default constants). Guaranteeing them lets the analyzer emit one action PER
 *  field for multi-field setters (patchOrbTheme, patchBubbleTheme,
 *  patchKeyboardButtonTheme, patchConversationTheme…) — without the field list
 *  in view it under-enumerates and whole personalization families vanish
 *  (clean-room finding). Small, evidence-dense; safe to force in. */
function isConfigTypesFile(rel) {
  const p = rel.replace(/\\/g, '/');
  const file = p.split('/').pop() || '';
  return (
    /(^|\/)(lib|data|config|constants|types|models|theme|themes|settings)\//i.test(p) &&
    /(config|defaults?|theme|themes|types?|schema|constants|settings|workspace|manifest)/i.test(file)
  );
}

function tierForApp(p) {
  if (/^(src\/)?app\//.test(p)) return 0; // expo-router / Next screens
  // `sections/` and `panels/` are SCREEN BODIES in shell-based apps (a Shell
  // page switches between section components): they carry the visible controls
  // (color pickers, toggles) the analyzer must read to emit their actions.
  // Ranking them as generic components (tier 3) silently dropped them under
  // budget pressure and whole screens became invisible to the AI.
  if (/(^|\/)(screens?|pages?|views?|routes?|sections?|panels?|activities|fragments)\//i.test(p)) return 0;
  if (/(screen|page|view|activity|fragment|section)\.(dart|kt|swift)$/i.test(p)) return 0;
  // Central state gets its OWN tier right after screens: the providers/stores
  // define the setters that make screen controls wire-able actions. Sharing a
  // tier with the (numerous) service/lib files let alphabetical fill starve
  // out AppProvider-style files, and the AI had to guess every handler name.
  if (/(^|\/)(state|store|stores|context|contexts|redux|providers?|blocs?|cubits?|viewmodels?)\//i.test(p)) return 1;
  if (/(viewmodel|notifier|bloc|cubit|store|controller)\.(dart|kt|swift)$/i.test(p)) return 1;
  // CONTROL-SURFACE components: settings/account/security/team/project-switch
  // panels are exactly what users ask the assistant to operate, wherever they
  // live in the tree. Ranked as generic components (tier 4) they were the
  // first thing the budget cut — and the audit showed the analyzer then missed
  // whole capability families (2FA setup, promo codes, project switching, the
  // team audit log). Same priority as central state. NOTE: 'onboard' is
  // intentionally EXCLUDED — install/onboarding UI is not a runtime control
  // surface for the orb and its files tend to be huge (would starve the budget).
  if (/(settings?|preferences?|config|profile|account|security|totp|2fa|team|members?|invit\w*|audit|switcher)[^/]*\.(tsx?|jsx?|vue|svelte|dart|kt|swift)$/i.test(p.split('/').pop() || '')) return 1;
  if (/(^|\/)(services?|api|db|data|domain|agent|handlers?|actions?|lib|utils|repositories|repository|usecases?)\//i.test(p)) return 2;
  if (/(^|\/)(hooks)\//.test(p)) return 3;
  return 4; // generic components / ui
}

function collectFiles(appRoot, { maxInputTokens = 150_000, platform = 'mobile' } = {}) {
  const profile = PROFILES[platform] || PROFILES.mobile;
  const codeExt = new Set(profile.exts);
  const skipDirs = new Set(profile.skipDirs);
  const isNative = platform === 'flutter' || platform === 'ios' || platform === 'android';

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      const full = path.join(dir, entry.name);
      const rel = path.relative(appRoot, full);
      if (!codeExt.has(path.extname(entry.name))) continue;
      if (SKIP_FILES.test(rel)) continue;
      if (isNative && SKIP_NATIVE_FILES.test(rel)) continue;
      let content = fs.readFileSync(full, 'utf8');
      if (platform === 'shopify' && /^locales\//.test(rel.replace(/\\/g, '/'))) {
        // Theme-editor translations (merchant-facing settings strings), not
        // storefront language evidence — pure noise for the analysis.
        if (/\.schema\.json$/.test(rel)) continue;
        // Non-default storefront locales: what matters is THAT the language is
        // published (the filename carries the code) — that is the evidence the
        // MULTILINGUAL rule needs to emit appLanguages/bubblePrompts. Sending
        // each file whole (tens of KB × dozens of locales) blew the budget and
        // the alphabetical cut dropped exactly the important ones (en/es
        // arrived after bg/cs/da…), so the AI saw a "monolingual" store.
        if (!/\.default\.json$/.test(rel)) {
          content = '{"__fyodos_note": "published storefront locale (content elided; this language IS offered to shoppers — count it in appLanguages/bubblePrompts)"}';
        }
      }
      files.push({ rel, content, tier: tierFor(rel, platform), chars: content.length });
    }
  };
  walk(appRoot);

  // Stable order: tier, then path (deterministic prompts → reproducible runs).
  files.sort((a, b) => a.tier - b.tier || a.rel.localeCompare(b.rel));

  const budgetChars = maxInputTokens * CHARS_PER_TOKEN;

  const included = [];
  let used = 0;

  // GUARANTEED CENTRAL STATE (do this BEFORE the tiered fill). The audit of a
  // virgin analysis showed the single richest file — AppProvider (~82KB), which
  // defines patchWorkspace/saveAll/resetChanges/switchProject/patchBubbleTheme
  // and the rest of the setters — losing the budget race to the many screen
  // files, so ~12 real capabilities vanished from the manifest. Force the
  // central-state files in first, capped per file (a pathological monster
  // provider can't consume everything) and capped in total (never starve
  // screens completely), letting any overflow fall back to normal tiering.
  const PER_FILE_CAP = 0.4 * budgetChars;
  const TOTAL_STATE_CAP = 0.55 * budgetChars;
  const mustSet = new Set();
  const centralState = files
    .filter(
      (f) => (isCentralStateFile(f.rel) || isConfigTypesFile(f.rel)) && f.chars <= PER_FILE_CAP,
    )
    // Central state first, then config/types; small first so as many fit as possible.
    .sort((a, b) => {
      const ca = isCentralStateFile(a.rel) ? 0 : 1;
      const cb = isCentralStateFile(b.rel) ? 0 : 1;
      return ca - cb || a.chars - b.chars;
    });
  for (const f of centralState) {
    if (used + f.chars > TOTAL_STATE_CAP) continue; // overflow → normal tiering
    included.push(f);
    used += f.chars;
    mustSet.add(f.rel);
  }
  const rest = files.filter((f) => !mustSet.has(f.rel));

  // Floor-reserved fill over the REMAINING files. A pure greedy fill let a fat
  // tier 0 (many large screen files) consume the WHOLE budget and push out
  // tier 1 entirely. Each lower tier gets a guaranteed FLOOR (share of the
  // total budget, capped at its real demand); screens still get what is left,
  // and a final backfill hands unused room to deferred files in tier order.
  const FLOOR_SHARE = { 1: 0.2, 2: 0.05, 3: 0.02, 4: 0.02 };
  const demand = new Map();
  for (const f of rest) demand.set(f.tier, (demand.get(f.tier) ?? 0) + f.chars);

  const deferred = [];
  const tiers = [...demand.keys()].sort((a, b) => a - b);
  for (const tier of tiers) {
    // Reserve, for every LOWER-priority tier that still has files, the smaller
    // of its floor and what it actually needs.
    let reserved = 0;
    for (const t of tiers) {
      if (t <= tier) continue;
      reserved += Math.min((FLOOR_SHARE[t] ?? 0) * budgetChars, demand.get(t));
    }
    const available = budgetChars - used - reserved;
    let tierUsed = 0;
    for (const f of rest) {
      if (f.tier !== tier) continue;
      if (tierUsed + f.chars <= available) {
        included.push(f);
        tierUsed += f.chars;
      } else {
        deferred.push(f);
      }
    }
    used += tierUsed;
  }
  // Backfill: any room the floors did not consume goes back to the deferred
  // files, highest tier priority first.
  const omitted = [];
  for (const f of deferred) {
    if (used + f.chars <= budgetChars) {
      included.push(f);
      used += f.chars;
    } else {
      omitted.push({ rel: f.rel, chars: f.chars, tier: f.tier });
    }
  }
  // Restore deterministic tier/path order after the backfill.
  included.sort((a, b) => a.tier - b.tier || a.rel.localeCompare(b.rel));

  return {
    included,
    omitted,
    totalChars: used,
    estimatedTokens: Math.round(used / CHARS_PER_TOKEN),
  };
}

/** Files the COVERAGE AUDIT (second pass) re-reads to find missed actions:
 *  central state + config/types (the setters and the field enumerations) plus
 *  the control-surface components (settings/studio/panels) where those setters
 *  are invoked. Shopify: Liquid theme + storefront snapshot (link CTAs). */
function isAuditRelevantFile(rel, platform) {
  const p = rel.replace(/\\/g, '/');
  const file = p.split('/').pop() || '';
  if (platform === 'shopify') {
    if (p.includes('_fyodos/storefront/')) return true;
    return /\.(liquid|json)$/i.test(file);
  }
  if (isCentralStateFile(rel) || isConfigTypesFile(rel)) return true;
  // Primary screens with CTAs — not only settings panels.
  if (/(page|screen|view|layout|nav|header|footer|sidebar|menu|form|modal|dialog|drawer)[^/]*\.(tsx?|jsx?|vue|svelte)$/i.test(file)) {
    return true;
  }
  return /(settings?|preferences?|profile|account|security|totp|2fa|team|members?|invit\w*|audit|switcher|advanced|section|panel|studio|config|cart|checkout|product|catalog|todo|list)[^/]*\.(tsx?|jsx?|vue|svelte|dart|kt|swift)$/i.test(file);
}

module.exports = { collectFiles, isCentralStateFile, isConfigTypesFile, isAuditRelevantFile };
