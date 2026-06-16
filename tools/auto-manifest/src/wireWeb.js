/**
 * wireWeb — automatic, consent-based orb wiring for web apps.
 *
 * Runs at the end of a WEB analysis (never for mobile). It is the web
 * equivalent of what the mobile express installer does when it copies the
 * provider/layout into the app: the same `analyze` command the developer
 * already runs also offers to drop `<FyodosAgent/>` into their app, so the
 * onboarding flow itself never has to add a manual step.
 *
 * Contract (chosen by the product owner — "option B"):
 *   1. Detect WHERE the orb should mount (framework-aware, generic).
 *   2. ASK before touching the developer's code:
 *        "About to add the orb to <file>. Proceed? [y/N]"
 *   3. On yes  → edit idempotently and safely (never duplicates on re-run).
 *      On no   → print the ready-to-paste snippet (with the right env vars).
 *      On non-TTY / can't edit → print the snippet (never hangs, never fails).
 *   4. ALWAYS verify + report the real outcome at the end
 *      ("orbe añadido" / "no se pudo, pega esto"), so nothing is reported as
 *      done when the orb is not actually mounted.
 *
 * Nothing here is product-specific: detection is by framework, not by app.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const IMPORT_NAME = 'FyodosAgentMount';
const WRAPPER_BASENAME = 'fyodos-agent-mount';

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 'next' | 'vite' | null — used to pick env var names + the right snippet. */
function detectFramework(appRoot) {
  const pkg = readJsonSafe(path.join(appRoot, 'package.json')) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (deps.next) return 'next';
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

/**
 * Where would the orb mount? Returns { kind, file, ext } or null.
 *   kind: 'next-app'   → App Router root layout (server component → needs a
 *                        'use client' wrapper, which we generate).
 *         'next-pages' → pages/_app (already client; direct mount).
 *         'vite'       → Vite/CRA entry (already client; direct mount).
 */
function detectTarget(appRoot) {
  const appLayout = firstExisting(appRoot, [
    'app/layout.tsx', 'app/layout.jsx',
    'src/app/layout.tsx', 'src/app/layout.jsx',
  ]);
  if (appLayout) return { kind: 'next-app', file: appLayout, ext: path.extname(appLayout) };

  const pagesApp = firstExisting(appRoot, [
    'pages/_app.tsx', 'pages/_app.jsx',
    'src/pages/_app.tsx', 'src/pages/_app.jsx',
  ]);
  if (pagesApp) return { kind: 'next-pages', file: pagesApp, ext: path.extname(pagesApp) };

  const viteEntry = firstExisting(appRoot, [
    'src/main.tsx', 'src/main.jsx', 'src/index.tsx', 'src/App.tsx', 'src/App.jsx',
  ]);
  if (viteEntry) return { kind: 'vite', file: viteEntry, ext: path.extname(viteEntry) };

  return null;
}

/** Env-var access expression for the detected framework. */
function envExpr(framework, kind, ts) {
  if (framework === 'vite') {
    return kind === 'key' ? 'import.meta.env.VITE_FYODOS_API_KEY' : 'import.meta.env.VITE_FYODOS_API_URL';
  }
  // Next (and default): public env vars.
  const key = `process.env.NEXT_PUBLIC_FYODOS_API_KEY${ts ? '!' : ''}`;
  const url = 'process.env.NEXT_PUBLIC_FYODOS_API_URL';
  return kind === 'key' ? key : url;
}

/** The drop-in JSX a developer pastes (used for fallback + the wrapper body). */
function agentJsx(framework, ts, indent = '  ') {
  const keyExpr = envExpr(framework, 'key', ts);
  const urlExpr = envExpr(framework, 'url', ts);
  return (
    `${indent}<FyodosAgent\n` +
    `${indent}  apiKey={${keyExpr}}\n` +
    `${indent}  apiUrl={${urlExpr}}\n` +
    `${indent}/>`
  );
}

// ── Consent ──────────────────────────────────────────────────────────────────

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

// ── Next App Router injection (the one we can do deterministically) ───────────

/**
 * Create the local client wrapper next to the layout. We generate a wrapper
 * (rather than mounting <FyodosAgent/> straight into the layout) because the
 * App Router root layout is a Server Component; the wrapper carries the
 * 'use client' boundary so the orb's hooks run. The file is the developer's,
 * tiny, and idempotent.
 */
function writeWrapper(layoutFile, framework, ts) {
  const dir = path.dirname(layoutFile);
  const ext = ts ? '.tsx' : '.jsx';
  const wrapperFile = path.join(dir, `${WRAPPER_BASENAME}${ext}`);
  if (fs.existsSync(wrapperFile) && /FyodosAgent/.test(fs.readFileSync(wrapperFile, 'utf8'))) {
    return wrapperFile;
  }
  const body =
    `'use client';\n\n` +
    `import { FyodosAgent } from '@fyodos/react';\n\n` +
    `export default function ${IMPORT_NAME}() {\n` +
    `  return (\n` +
    `${agentJsx(framework, ts, '    ')}\n` +
    `  );\n` +
    `}\n`;
  fs.writeFileSync(wrapperFile, body);
  return wrapperFile;
}

function insertImportAfterLastImport(source, importLine) {
  const lines = source.split('\n');
  let lastImport = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*import\b/.test(lines[i])) lastImport = i;
  }
  if (lastImport === -1) {
    return `${importLine}\n${source}`;
  }
  lines.splice(lastImport + 1, 0, importLine);
  return lines.join('\n');
}

/** Inject <FyodosAgentMount /> just before the first </body>. */
function injectNextApp(target, framework) {
  const ts = target.ext === '.tsx';
  let source = fs.readFileSync(target.file, 'utf8');
  if (!source.includes('</body>')) {
    throw new Error('no <body> tag found in layout');
  }
  writeWrapper(target.file, framework, ts);

  const importLine = `import ${IMPORT_NAME} from './${WRAPPER_BASENAME}';`;
  if (!source.includes(importLine)) {
    source = insertImportAfterLastImport(source, importLine);
  }
  // Mount on its own line just before </body>, matching the closing tag's
  // indentation whether </body> sits on its own line or shares one with {children}.
  source = source.replace(/([^\n]*)<\/body>/, (_m, before) => {
    const indent = (before.match(/^(\s*)/) || ['', ''])[1];
    return before.trim() === ''
      ? `${indent}  <${IMPORT_NAME} />\n${before}</body>`
      : `${before}\n${indent}  <${IMPORT_NAME} />\n${indent}</body>`;
  });
  fs.writeFileSync(target.file, source);
}

// ── Printed fallback ──────────────────────────────────────────────────────────

function printSnippet(target, framework, colors, appRoot) {
  const { blue, cyan, dim, reset } = colors;
  const ts = !target || target.ext === '.tsx';
  console.error(`\n${cyan}◉${reset} ${blue}Fiodos${reset} · ${dim}add the orb to your web app (copy this):${reset}`);

  if (!target || target.kind === 'next-app') {
    const where = target ? path.relative(appRoot, target.file) : 'your root layout (app/layout.tsx)';
    console.error(`${dim}In App Router the layout is a Server Component, so the orb goes in a client wrapper.${reset}`);
    console.error(`${dim}1) Create ${WRAPPER_BASENAME}${ts ? '.tsx' : '.jsx'} next to ${where}:${reset}\n`);
    console.error(
      `'use client';\n\n` +
      `import { FyodosAgent } from '@fyodos/react';\n\n` +
      `export default function ${IMPORT_NAME}() {\n` +
      `  return (\n${agentJsx(framework || 'next', ts, '    ')}\n  );\n}`,
    );
    console.error(`\n${dim}2) In ${where}, import and mount before </body>:${reset}\n`);
    console.error(`import ${IMPORT_NAME} from './${WRAPPER_BASENAME}';\n// …\n  <${IMPORT_NAME} />\n</body>`);
  } else {
    const where = path.relative(appRoot, target.file);
    console.error(`${dim}In ${where}, import and mount <FyodosAgent/>:${reset}\n`);
    console.error(`import { FyodosAgent } from '@fyodos/react';\n\n${agentJsx(framework || (target.kind === 'vite' ? 'vite' : 'next'), ts, '')}`);
  }
  console.error('');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Offer to wire the orb into the web app.
 * Returns { status, file? }:
 *   'added' | 'already' | 'declined' | 'printed' | 'failed' | 'skipped'
 */
async function wireWebOrb(appRoot, opts = {}) {
  const { colors = {}, assumeYes = false, noWire = false } = opts;
  if (noWire) return { status: 'skipped' };

  const framework = detectFramework(appRoot);
  const target = detectTarget(appRoot);

  // No recognizable mount point → print generic guidance and report honestly.
  if (!target) {
    printSnippet(null, framework, colors, appRoot);
    return { status: 'printed' };
  }

  const rel = path.relative(appRoot, target.file);

  // Idempotency: already wired anywhere in the target file.
  if (/FyodosAgent/.test(fs.readFileSync(target.file, 'utf8'))) {
    return { status: 'already', file: rel };
  }

  // Only the App Router case is edited automatically; others get the snippet
  // (their entry trees vary too much to edit safely without an AST).
  if (target.kind !== 'next-app') {
    printSnippet(target, framework, colors, appRoot);
    return { status: 'printed', file: rel };
  }

  const yes = assumeYes || (await askYesNo(
    `${colors.cyan || ''}◉${colors.reset || ''} About to add the orb to ${rel}. Proceed? [y/N] `,
  ));
  if (!yes) {
    printSnippet(target, framework, colors, appRoot);
    return { status: 'declined', file: rel };
  }

  try {
    injectNextApp(target, framework);
    // Verify the edit actually landed.
    if (!/FyodosAgent/.test(fs.readFileSync(target.file, 'utf8'))) {
      throw new Error('post-edit verification failed');
    }
    return { status: 'added', file: rel };
  } catch (err) {
    printSnippet(target, framework, colors, appRoot);
    return { status: 'failed', file: rel, error: err };
  }
}

/** Final, honest report line about whether the orb really got mounted. */
function reportWireResult(result, colors = {}) {
  const { blue, cyan, dim, reset } = colors;
  const tag = `${cyan || ''}◉${reset || ''} ${blue || ''}Fiodos${reset || ''}`;
  switch (result.status) {
    case 'added':
      console.error(`${tag} · ✓ orb added to ${result.file}. Start your web app (e.g. \`npm run dev\`) to see it.`);
      break;
    case 'already':
      console.error(`${tag} · ✓ orb already mounted in ${result.file}. Nothing to do.`);
      break;
    case 'declined':
      console.error(`${tag} · ${dim || ''}did not modify your code. Paste the snippet above to mount the orb.${reset || ''}`);
      break;
    case 'printed':
      console.error(`${tag} · ${dim || ''}could not edit automatically: paste the snippet above to mount the orb.${reset || ''}`);
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
  // exported for tests
  detectFramework,
  detectTarget,
};
