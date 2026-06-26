/**
 * wireWeb — automatic, consent-based orb wiring for web apps.
 *
 * Runs at the end of a WEB analysis (never for mobile). Every supported web
 * ecosystem gets the same contract:
 *   1. Detect mount point (framework-aware).
 *   2. Verify we can edit safely (assessMount) — else honest snippet fallback.
 *   3. Show what will change + ask [y/N] in terminal.
 *   4. On yes → edit with FYODOS:ORB markers, post-build verify, revert on failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { runPostWireTest } = require('./postWireTest');
const {
  assessMount,
  describePlan,
  applyMount,
  verifyMounted,
  backupFiles,
  revertFiles,
  writeConsentDoc,
  agentJsx,
  envExpr,
  registryRelImport,
  addRegistriesToMountSource,
  addRegistriesToBootstrapSource,
  buildEntryBootstrapBlock,
  IMPORT_NAME,
  WRAPPER_BASENAME,
} = require('./wireWebMount');

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function detectFramework(appRoot) {
  const pkg = readJsonSafe(path.join(appRoot, 'package.json')) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const has = (rel) => fs.existsSync(path.join(appRoot, rel));

  if (deps.next) return 'next';
  if (deps['@angular/core'] || has('angular.json')) return 'angular';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  if (deps.svelte || has('svelte.config.js') || has('svelte.config.ts')) return 'svelte';
  if (deps.vue || deps['@vitejs/plugin-vue']) return 'vue';
  if (deps.vite || deps['@vitejs/plugin-react'] || deps['react-scripts']) return 'vite';
  return null;
}

function firstExisting(appRoot, rels) {
  for (const rel of rels) {
    const abs = path.join(appRoot, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function detectTarget(appRoot, framework = detectFramework(appRoot)) {
  if (framework === 'vue') {
    // Prefer the entry module (deterministic anchor → bootstrap injection). Fall
    // back to the SFC <template> strategy only when there is no entry file.
    const entry = firstExisting(appRoot, ['src/main.ts', 'src/main.js']);
    if (entry) return { kind: 'vue-entry', file: entry, ext: path.extname(entry), framework };
    const f = firstExisting(appRoot, ['src/App.vue']);
    return f ? { kind: 'vue', file: f, ext: path.extname(f), framework } : { kind: 'vue', file: null, framework };
  }
  if (framework === 'sveltekit') {
    // SvelteKit owns the bootstrap (no src/main.ts), but src/hooks.client.ts runs
    // once in the browser — the ideal, template-free spot. Create it if missing.
    const existing = firstExisting(appRoot, ['src/hooks.client.ts', 'src/hooks.client.js']);
    const file = existing || path.join(appRoot, 'src/hooks.client.ts');
    return { kind: 'sveltekit-hooks', file, ext: path.extname(file), framework };
  }
  if (framework === 'svelte') {
    const entry = firstExisting(appRoot, ['src/main.ts', 'src/main.js']);
    if (entry) return { kind: 'svelte-entry', file: entry, ext: path.extname(entry), framework };
    const f = firstExisting(appRoot, ['src/App.svelte']);
    return f ? { kind: 'svelte', file: f, ext: '.svelte', framework } : { kind: 'svelte', file: null, framework };
  }
  if (framework === 'angular') {
    const f = firstExisting(appRoot, [
      'src/app/app.component.ts', 'src/app/app.ts', 'src/main.ts',
    ]);
    return f ? { kind: 'angular', file: f, ext: '.ts', framework } : { kind: 'angular', file: null, framework };
  }

  const appLayout = firstExisting(appRoot, [
    'app/layout.tsx', 'app/layout.jsx',
    'src/app/layout.tsx', 'src/app/layout.jsx',
  ]);
  if (appLayout) return { kind: 'next-app', file: appLayout, ext: path.extname(appLayout), framework: framework || 'next' };

  const pagesApp = firstExisting(appRoot, [
    'pages/_app.tsx', 'pages/_app.jsx',
    'src/pages/_app.tsx', 'src/pages/_app.jsx',
  ]);
  if (pagesApp) return { kind: 'next-pages', file: pagesApp, ext: path.extname(pagesApp), framework: framework || 'next' };

  const viteEntry = firstExisting(appRoot, [
    'src/main.tsx', 'src/main.jsx', 'src/index.tsx', 'src/App.tsx', 'src/App.jsx',
  ]);
  if (viteEntry) return { kind: 'vite', file: viteEntry, ext: path.extname(viteEntry), framework: framework || 'vite' };

  return null;
}

function agentSnippetVue() {
  return (
    `<script setup lang="ts">\n` +
    `import { FiodosAgent } from '@fiodos/vue';\n` +
    `const fyodosApiKey = import.meta.env.VITE_FYODOS_API_KEY;\n` +
    `const fyodosApiUrl = import.meta.env.VITE_FYODOS_API_URL;\n` +
    `</script>\n\n` +
    `<template>\n` +
    `  <!-- ...your app... -->\n` +
    `  <FiodosAgent :api-key="fyodosApiKey" :base-url="fyodosApiUrl" />\n` +
    `</template>`
  );
}

function agentSnippetSvelte() {
  return (
    `<script lang="ts">\n` +
    `  import FiodosAgent from '@fiodos/svelte/FiodosAgent.svelte';\n` +
    `</script>\n\n` +
    `<FiodosAgent apiKey={import.meta.env.VITE_FYODOS_API_KEY} baseUrl={import.meta.env.VITE_FYODOS_API_URL} />`
  );
}

function agentSnippetAngular() {
  return (
    `import { FiodosAgentComponent } from '@fiodos/angular/angular';\n\n` +
    `@Component({\n` +
    `  imports: [FiodosAgentComponent],\n` +
    `  templateUrl: './app.component.html',\n` +
    `})\n` +
    `export class AppComponent {\n` +
    `  fyodosApiKey = environment.fyodosApiKey;\n` +
    `}\n\n` +
    `<!-- app.component.html -->\n` +
    `<fyodos-agent [apiKey]="fyodosApiKey" />`
  );
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
      resolve(/^(y|yes)/i.test((answer || '').trim()));
    });
  });
}

function printSnippet(target, framework, colors, appRoot, reason) {
  const { blue, cyan, dim, reset } = colors;
  const ts = !target || target.ext === '.tsx';
  console.error(`\n${cyan}◉${reset} ${blue}Fiodos${reset} · ${dim}add the orb to your web app (copy this):${reset}`);
  if (reason) {
    console.error(`${dim}Reason: ${reason}${reset}\n`);
  }

  // Entry-file bootstrap frameworks: the safe fallback is the same one-shot call
  // we would have auto-injected into the entry module — no <template> edit.
  const entryKind = target && /(-entry|-hooks)$/.test(target.kind || '');
  if (entryKind) {
    const where = path.relative(appRoot, target.file);
    console.error(`${dim}In ${where}, after your imports:${reset}\n`);
    console.error(buildEntryBootstrapBlock());
    return;
  }
  if (framework === 'vue') {
    const where = target && target.file ? path.relative(appRoot, target.file) : 'src/App.vue';
    console.error(`${dim}In ${where}:${reset}\n`);
    console.error(agentSnippetVue());
    return;
  }
  if (framework === 'svelte' || framework === 'sveltekit') {
    const def = framework === 'sveltekit' ? 'src/routes/+layout.svelte' : 'src/App.svelte';
    const where = target && target.file ? path.relative(appRoot, target.file) : def;
    console.error(`${dim}In ${where}:${reset}\n`);
    console.error(agentSnippetSvelte());
    return;
  }
  if (framework === 'angular') {
    const where = target && target.file ? path.relative(appRoot, target.file) : 'src/app/app.component.ts';
    console.error(`${dim}In ${where}:${reset}\n`);
    console.error(agentSnippetAngular());
    return;
  }

  if (!target || target.kind === 'next-app') {
    const where = target ? path.relative(appRoot, target.file) : 'app/layout.tsx';
    console.error(`${dim}Next App Router — client wrapper + layout edit:${reset}\n`);
    console.error(
      `'use client';\nimport { FiodosAgent } from '@fiodos/react';\n` +
      `export default function ${IMPORT_NAME}() { return (${agentJsx(framework || 'next', ts, '\n    ')}\n  ); }`,
    );
    console.error(`\n${dim}In ${where}, before </body>: <${IMPORT_NAME} />${reset}`);
  } else {
    const where = path.relative(appRoot, target.file);
    console.error(`${dim}In ${where}:${reset}\n`);
    console.error(`import { FiodosAgent } from '@fiodos/react';\n\n${agentJsx(framework || 'vite', ts, '')}`);
  }
  console.error('');
}

function printMountPreview(plan, colors) {
  const { dim, reset } = colors;
  console.error(`${dim}Planned orb mount (${plan.rel}):${reset}`);
  for (const line of describePlan(plan)) {
    console.error(`${dim}  · ${line}${reset}`);
  }
  console.error('');
}

async function wireWebOrb(appRoot, opts = {}) {
  const { colors = {}, assumeYes = false, noWire = false, runTest = true } = opts;
  if (noWire) return { status: 'skipped' };

  const framework = detectFramework(appRoot);
  const target = detectTarget(appRoot, framework);
  const plan = assessMount(target, framework, appRoot);

  if (plan.already) {
    return { status: 'already', file: plan.rel || (target && path.relative(appRoot, target.file)) };
  }

  if (!plan.ok) {
    printSnippet(target, framework, colors, appRoot, plan.reason);
    return { status: 'printed', reason: plan.reason };
  }

  if (!assumeYes) {
    printMountPreview(plan, colors);
  }

  const yes = assumeYes || (await askYesNo(
    `${colors.cyan || ''}◉${colors.reset || ''} About to add the orb to ${plan.rel}. Proceed? [y/N] `,
  ));
  if (!yes) {
    printSnippet(target, framework, colors, appRoot, 'you declined the automatic edit');
    return { status: 'declined', file: plan.rel };
  }

  const build = async () => {
    try {
      return await runPostWireTest(appRoot, { timeoutMs: 180000 });
    } catch (e) {
      return { ok: false, stage: 'runner', command: '(runner)', output: String((e && e.message) || e) };
    }
  };

  const backups = backupFiles(plan.files);
  // Files the installer creates from scratch (e.g. SvelteKit src/hooks.client.ts)
  // are not in `backups`; a revert must DELETE them, not leave an orphan behind.
  const createdFiles = plan.files.filter((f) => !(f in backups));
  const revertAll = () => {
    revertFiles(backups);
    for (const f of createdFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        /* best-effort */
      }
    }
  };
  try {
    applyMount(plan);
    if (!verifyMounted(plan)) {
      revertAll();
      printSnippet(target, framework, colors, appRoot, 'post-edit verification failed — FiodosAgent not found in edited files');
      return { status: 'failed', file: plan.rel };
    }

    // The orb is a single, trivial component mount — it must APPEAR. We therefore
    // only revert when WE are demonstrably the cause: the app built fine on its
    // own but breaks once the orb is mounted (e.g. the SDK package isn't installed
    // yet). A pre-existing build failure, a timeout, or a missing toolchain must
    // NOT make the orb vanish — that was the silent "orb never shows up" bug.
    // Fast path: one build. Only when it fails do we spend a second build (on the
    // reverted original) to tell "we broke it" from "it was already broken".
    if (runTest) {
      const test = await build();
      if (test.ok || test.stage === 'skipped-no-deps') {
        writeConsentDoc(appRoot, plan);
        return { status: 'added', file: plan.rel, test };
      }
      // Build failed with the orb mounted — was the app building WITHOUT it?
      revertAll();
      const baseline = await build();
      if (baseline.ok) {
        // Built before, fails now → the mount is the regression. Keep it reverted.
        printSnippet(target, framework, colors, appRoot, `mount caused a build regression — reverted (${test.command})`);
        return { status: 'reverted', file: plan.rel, test, reason: test.output };
      }
      // It was already not building (or not verifiable) before us → keep the orb.
      applyMount(plan);
      verifyMounted(plan);
      writeConsentDoc(appRoot, plan);
      return { status: 'added', file: plan.rel, test, preexistingFailure: true };
    }

    writeConsentDoc(appRoot, plan);
    return { status: 'added', file: plan.rel };
  } catch (err) {
    revertAll();
    printSnippet(target, framework, colors, appRoot, err.message || String(err));
    return { status: 'failed', file: plan.rel, error: err };
  }
}

function reportWireResult(result, colors = {}, opts = {}) {
  const quiet = opts.quiet !== false;
  if (!result) return;
  const { blue, cyan, dim, reset } = colors;
  const tag = `${cyan || ''}◉${reset || ''} ${blue || ''}Fiodos${reset || ''}`;
  switch (result.status) {
    case 'added':
    case 'already':
      if (quiet) return;
      break;
    case 'declined':
      console.error(`${tag} · ${dim || ''}did not modify your code. Paste the snippet above to mount the orb.${reset || ''}`);
      break;
    case 'printed':
      console.error(`${tag} · ${dim || ''}automatic mount not possible${result.reason ? `: ${result.reason}` : ''}. Paste the snippet above.${reset || ''}`);
      break;
    case 'reverted':
      console.error(`${tag} · ✗ mount reverted — app would not build. Paste the snippet above or fix manually.`);
      if (result.reason) console.error(`${dim}${result.reason}${reset}`);
      break;
    case 'failed':
      console.error(`${tag} · ✗ could not safely edit ${result.file}. Paste the snippet above.`);
      break;
    case 'skipped':
    default:
      break;
  }
}

/**
 * Second pass (after handler wiring): connect the generated registry to the
 * already-mounted orb so it EXECUTES actions, not just navigates. This is what
 * removes the manual "paste registries={…}" step. Idempotent and reversible:
 * the prop lives inside the FYODOS:ORB block. React-family mounts only —
 * Vue/Svelte/Angular SDKs receive handlers differently and are left to the doc.
 * Nav-only apps (no auto-wired handlers) never reach here (the caller gates on
 * autoCount > 0), so they are not given a needless registries prop.
 */
function connectOrbRegistries(appRoot, opts = {}) {
  const { registryFileAbs, exportName = 'fyodosGeneratedRegistries' } = opts;
  if (!registryFileAbs || !fs.existsSync(registryFileAbs)) return { status: 'no-registry' };

  const framework = detectFramework(appRoot);
  const target = detectTarget(appRoot, framework);
  if (!target || !target.file) return { status: 'no-target' };

  // Entry-file bootstrap (Vue / Svelte / SvelteKit): the registries go INTO the
  // createFiodosAgent({…}) call we injected into the entry module — same safe,
  // idempotent, reversible block. No manual "pass registries" step anywhere.
  const bootstrapKinds = new Set(['vue-entry', 'svelte-entry', 'sveltekit-hooks']);
  if (bootstrapKinds.has(target.kind)) {
    let source;
    try {
      source = fs.readFileSync(target.file, 'utf8');
    } catch {
      return { status: 'not-mounted' };
    }
    const importPath = registryRelImport(target.file, registryFileAbs);
    const fileRel = path.relative(appRoot, target.file);
    const backups = backupFiles([target.file]);
    try {
      const res = addRegistriesToBootstrapSource(source, importPath);
      if (!res.changed) {
        return { status: res.reason === 'already' ? 'already' : 'not-mounted', file: fileRel };
      }
      fs.writeFileSync(target.file, res.source);
      return { status: 'connected', file: fileRel };
    } catch (e) {
      revertFiles(backups);
      return { status: 'failed', file: fileRel, error: e };
    }
  }

  // Only React-family mounts accept a `registries={...}` prop.
  const reactKinds = new Set(['vite', 'next-pages', 'next-app']);
  if (!reactKinds.has(target.kind)) return { status: 'unsupported-framework', framework };

  // <FiodosAgent/> lives in the client wrapper for the Next App Router, in the
  // entry/root file otherwise.
  let mountFile = target.file;
  if (target.kind === 'next-app') {
    const dir = path.dirname(target.file);
    mountFile =
      [path.join(dir, `${WRAPPER_BASENAME}.tsx`), path.join(dir, `${WRAPPER_BASENAME}.jsx`)].find((f) =>
        fs.existsSync(f),
      ) || null;
    if (!mountFile) return { status: 'not-mounted' };
  }

  let source;
  try {
    source = fs.readFileSync(mountFile, 'utf8');
  } catch {
    return { status: 'not-mounted' };
  }
  if (!/<FiodosAgent\b/.test(source)) return { status: 'not-mounted' };

  const importPath = registryRelImport(mountFile, registryFileAbs);
  const fileRel = path.relative(appRoot, mountFile);
  const backups = backupFiles([mountFile]);
  try {
    const res = addRegistriesToMountSource(source, exportName, importPath);
    if (!res.changed) {
      return { status: res.reason === 'already' ? 'already' : 'not-mounted', file: fileRel };
    }
    fs.writeFileSync(mountFile, res.source);
    return { status: 'connected', file: fileRel };
  } catch (e) {
    revertFiles(backups);
    return { status: 'failed', file: fileRel, error: e };
  }
}

function reportRegistriesResult(result, colors = {}, opts = {}) {
  const quiet = opts.quiet !== false;
  if (!result) return;
  const { blue, cyan, dim, reset } = colors;
  const tag = `${cyan || ''}◉${reset || ''} ${blue || ''}Fiodos${reset || ''}`;
  switch (result.status) {
    case 'connected':
      console.error(`${tag} · ${dim || ''}connected actions to the orb (registries=) in ${result.file}${reset || ''}`);
      break;
    case 'already':
      if (quiet) return;
      console.error(`${tag} · ${dim || ''}orb already wired to actions in ${result.file}${reset || ''}`);
      break;
    case 'unsupported-framework':
      console.error(`${tag} · ${dim || ''}pass the generated registry to your orb manually (see FYODOS_HANDLERS.md)${reset || ''}`);
      break;
    case 'failed':
      console.error(`${tag} · ✗ could not auto-connect actions to the orb${result.file ? ` in ${result.file}` : ''}. See FYODOS_HANDLERS.md.`);
      break;
    default:
      // not-mounted / no-registry / no-target: silent. The orb still navigates,
      // and the doc shows how to connect actions by hand if needed.
      break;
  }
}

module.exports = {
  wireWebOrb,
  reportWireResult,
  connectOrbRegistries,
  reportRegistriesResult,
  detectFramework,
  detectTarget,
};
