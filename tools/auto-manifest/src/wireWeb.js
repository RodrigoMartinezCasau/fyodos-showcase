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
    const f = firstExisting(appRoot, ['src/App.vue', 'src/main.ts', 'src/main.js']);
    return f ? { kind: 'vue', file: f, ext: path.extname(f), framework } : { kind: 'vue', file: null, framework };
  }
  if (framework === 'sveltekit') {
    const f = firstExisting(appRoot, [
      'src/routes/+layout.svelte', 'src/routes/+page.svelte', 'src/App.svelte',
    ]);
    return f ? { kind: 'sveltekit', file: f, ext: '.svelte', framework } : { kind: 'sveltekit', file: null, framework };
  }
  if (framework === 'svelte') {
    const f = firstExisting(appRoot, ['src/App.svelte', 'src/routes/+layout.svelte', 'src/main.ts']);
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

  printMountPreview(plan, colors);

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
  try {
    applyMount(plan);
    if (!verifyMounted(plan)) {
      revertFiles(backups);
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
      revertFiles(backups);
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
    revertFiles(backups);
    printSnippet(target, framework, colors, appRoot, err.message || String(err));
    return { status: 'failed', file: plan.rel, error: err };
  }
}

function reportWireResult(result, colors = {}) {
  const { blue, cyan, dim, reset } = colors;
  const tag = `${cyan || ''}◉${reset || ''} ${blue || ''}Fiodos${reset || ''}`;
  switch (result.status) {
    case 'added':
      console.error(`${tag} · ✓ orb added to ${result.file}. Start your web app (e.g. \`npm run dev\`) to see it.`);
      if (result.preexistingFailure) {
        console.error(`${tag} · ${dim || ''}Note: your app was ALREADY not building before the orb was added (${result.test && result.test.stage}); not caused by Fiodos — the orb is kept so it appears once your build is fixed.${reset || ''}`);
      } else if (result.test && result.test.stage === 'skipped-no-deps') {
        console.error(`${tag} · ${dim || ''}build not verified (no node_modules) — run npm install && npm run build locally.${reset || ''}`);
      } else if (result.test && result.test.ok) {
        console.error(`${tag} · ✓ ${result.test.command} passed after mount.`);
      }
      break;
    case 'already':
      console.error(`${tag} · ✓ orb already mounted in ${result.file}. Nothing to do.`);
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

module.exports = {
  wireWebOrb,
  reportWireResult,
  detectFramework,
  detectTarget,
};
