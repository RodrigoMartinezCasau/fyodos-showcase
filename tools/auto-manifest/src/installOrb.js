/**
 * installOrb — `fiodos install`: one command, and the orb is in the app.
 *
 * On Shopify the merchant presses a button and we write the block into the
 * theme ourselves, because Shopify lends us an API for exactly that. No other
 * host does. The closest equivalent is this: the developer runs one command
 * where the code lives and we do the writing, so nobody ever copies a block of
 * JavaScript out of a web page and hopes it landed intact.
 *
 * What it writes depends only on what the app HAS:
 *   - an HTML shell (index.html)  → the block, before </body>
 *   - a JS entry file             → a generated module, and one import line
 *   - a Next.js app/ layout       → the module, reached through a client
 *                                   component (a server component's imports
 *                                   never make it to the browser)
 *
 * Both shapes come from the backend, which builds them from ONE mount program,
 * so the command has no copy of the orb's behaviour to fall out of date.
 *
 * Everything it writes sits between FYODOS:ORB markers: re-running replaces
 * instead of stacking, and deleting the marked block is a complete uninstall.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { ORB_SCRIPT_START, ORB_SCRIPT_END } = require('./wireWebMount');
const { detectFramework, detectTarget } = require('./wireWeb');

//: The written account of what we changed. An installer that edits somebody's
//: repository and says "done" in a terminal that will be closed in a minute has
//: left them nothing to review, hand to a colleague, or undo next month.
const REPORT_BASENAME = 'FYODOS_ORB_INSTALL.md';

const HTML_START = '<!-- FYODOS:ORB:START';
const HTML_END = '<!-- FYODOS:ORB:END -->';

//: Where an app's HTML shell lives, by convention, across the frameworks that
//: have one. Order matters only in that the first match with a </body> wins.
const HTML_SHELLS = [
  'index.html',
  'public/index.html',
  'src/index.html',
  'app/index.html',
];

const NEXT_CLIENT_BASENAME = 'fyodos-orb-client';

// ── Pure text surgery (unit-tested without a filesystem) ─────────────────────

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove a previously installed block so a re-run replaces it. */
function stripMarked(source, start, end) {
  const re = new RegExp(`[ \\t]*${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}\\n?`, 'g');
  return source.replace(re, '');
}

/**
 * Put a block in just before the last </body>, matching its indentation.
 *
 * `buildBlock(indent)` is called with the indentation of the closing tag, so
 * what lands reads like it was always there. Returns null when there is no
 * </body>: we refuse rather than guess a position, because an orb written
 * somewhere plausible-but-wrong installs "successfully" and never runs.
 */
function insertBeforeBody(source, buildBlock) {
  const idx = source.lastIndexOf('</body>');
  if (idx === -1) return null;
  const lineStart = source.lastIndexOf('\n', idx) + 1;
  const ahead = source.slice(lineStart, idx);
  // A compact or minified shell keeps </body> on a line with other markup;
  // there is no indentation to match and the block goes in right before it.
  const ownLine = ahead.trim() === '';
  const indent = ownLine ? ahead : '';
  const block = buildBlock(indent);
  return ownLine
    ? `${source.slice(0, lineStart)}${block}\n${indent}${source.slice(idx)}`
    : `${source.slice(0, idx)}${block}${source.slice(idx)}`;
}

/** Put the orb block in just before </body>. Null when there is none. */
function injectIntoHtml(source, snippet) {
  const clean = stripMarked(source, HTML_START, HTML_END);
  return insertBeforeBody(clean, (indent) =>
    snippet
      .split('\n')
      .map((line) => (line ? `${indent}  ${line}` : line))
      .join('\n'),
  );
}

/** The marked one-liner that pulls the generated module into the entry file. */
function moduleImportBlock(specifier) {
  return [ORB_SCRIPT_START, `import '${specifier}';`, ORB_SCRIPT_END].join('\n');
}

/**
 * Add the import at the TOP of the entry file. Not after the last import, as
 * the wiring path does: this module only has side effects, and starting the orb
 * before the app's own imports run means it is already waiting when the first
 * screen paints.
 */
function addModuleImport(source, specifier) {
  const clean = stripMarked(source, ORB_SCRIPT_START, ORB_SCRIPT_END);
  const block = moduleImportBlock(specifier);
  if (!clean.trim()) return `${block}\n`;
  return `${block}\n${clean}`;
}

/** Import specifier from `fromFile` to a sibling module, without extension. */
function siblingSpecifier(basename) {
  return `./${basename}`;
}

/**
 * The glue Next.js App Router needs. `app/layout.tsx` is a server component:
 * anything it imports is bundled for the server and never reaches the browser,
 * so the module has to be pulled in from a client component instead.
 */
function nextClientComponent(moduleSpecifier) {
  return [
    "'use client';",
    '',
    '// FYODOS:ORB — generated by Fiodos. Safe to delete along with the line',
    '// that renders it in your layout.',
    "import { useEffect } from 'react';",
    '',
    'export default function FyodosOrb() {',
    '  // Imported here rather than at the top of the file so the orb is loaded',
    '  // by the browser, after the page is interactive — never during the',
    '  // server render, and never as part of the first bundle.',
    `  useEffect(() => { import('${moduleSpecifier}'); }, []);`,
    '  return null;',
    '}',
    '',
  ].join('\n');
}

/** Mount <FyodosOrb /> before </body> in a Next.js layout, plus its import. */
function addNextClientMount(source, componentBasename) {
  const clean = stripMarked(source, ORB_SCRIPT_START, ORB_SCRIPT_END);
  const mounted = insertBeforeBody(clean, (indent) => `${indent}  <FyodosOrb />`);
  if (mounted === null) return null;
  const importBlock = [
    ORB_SCRIPT_START,
    `import FyodosOrb from './${componentBasename}';`,
    ORB_SCRIPT_END,
  ].join('\n');
  return `${importBlock}\n${mounted}`;
}

// ── Deciding what this particular app needs ─────────────────────────────────

/**
 * Look at the app and say how the orb gets in. Never writes anything.
 * Returns { strategy, files, rel } or { ok: false, reason }.
 */
function planInstall(appRoot, io = fs) {
  const framework = detectFramework(appRoot);

  // Next serves no static shell: a public/index.html there is a leftover, and
  // writing into it would produce an install that silently never runs.
  if (framework !== 'next') {
    for (const rel of HTML_SHELLS) {
      const abs = path.join(appRoot, rel);
      if (!io.existsSync(abs)) continue;
      if (!/<\/body>/.test(io.readFileSync(abs, 'utf8'))) continue;
      return { ok: true, strategy: 'html-shell', file: abs, rel, framework };
    }
  }

  const target = detectTarget(appRoot, framework);
  if (!target || !target.file) {
    return {
      ok: false,
      reason:
        'no index.html and no entry file (src/main.tsx, app/layout.tsx, pages/_app.tsx…) — ' +
        'run this from the folder that holds your app',
    };
  }

  if (target.kind === 'next-app') {
    return {
      ok: true,
      strategy: 'next-app',
      file: target.file,
      rel: path.relative(appRoot, target.file),
      framework,
      ts: target.ext === '.tsx',
    };
  }

  return {
    ok: true,
    strategy: 'entry-import',
    file: target.file,
    rel: path.relative(appRoot, target.file),
    framework,
  };
}

// ── Doing it, reversibly ────────────────────────────────────────────────────

/**
 * Apply `plan` with the block the backend built. Returns the list of files
 * touched (relative to appRoot). Restores every file it opened if anything
 * fails, so a refused install leaves the app exactly as it was.
 */
function applyInstall(appRoot, plan, payload, io = fs) {
  const moduleBasename = payload.moduleBasename || 'fyodos-orb';
  const dir = path.dirname(plan.file);
  const backups = new Map();
  const created = [];

  const readSafe = (f) => (io.existsSync(f) ? io.readFileSync(f, 'utf8') : null);
  const write = (f, content) => {
    if (!backups.has(f)) {
      const before = readSafe(f);
      backups.set(f, before);
      if (before === null) created.push(f);
    }
    io.writeFileSync(f, content);
  };

  const withReport = (files) => {
    const touched = files.map((f) => path.relative(appRoot, f));
    // Written last, and inside the same try, so a failed install leaves no
    // report of an install that did not happen.
    const reportFile = path.join(appRoot, REPORT_BASENAME);
    write(reportFile, buildReport(plan, touched, deployNotice()));
    return [...touched, REPORT_BASENAME];
  };

  try {
    if (plan.strategy === 'html-shell') {
      const next = injectIntoHtml(io.readFileSync(plan.file, 'utf8'), payload.snippet);
      if (next === null) throw new Error(`${plan.rel} has no </body>`);
      write(plan.file, next);
      return withReport([plan.file]);
    }

    const moduleFile = path.join(dir, `${moduleBasename}.js`);
    write(moduleFile, payload.module);

    if (plan.strategy === 'next-app') {
      const componentFile = path.join(dir, `${NEXT_CLIENT_BASENAME}${plan.ts ? '.tsx' : '.jsx'}`);
      write(componentFile, nextClientComponent(siblingSpecifier(moduleBasename)));
      const next = addNextClientMount(io.readFileSync(plan.file, 'utf8'), NEXT_CLIENT_BASENAME);
      if (next === null) throw new Error(`${plan.rel} has no </body>`);
      write(plan.file, next);
      return withReport([moduleFile, componentFile, plan.file]);
    }

    const entry = addModuleImport(
      io.readFileSync(plan.file, 'utf8'),
      siblingSpecifier(moduleBasename),
    );
    write(plan.file, entry);
    return withReport([moduleFile, plan.file]);
  } catch (e) {
    for (const [f, before] of backups) {
      if (before === null) {
        if (io.existsSync(f)) io.unlinkSync(f);
      } else {
        io.writeFileSync(f, before);
      }
    }
    created.length = 0;
    throw e;
  }
}

/** What each strategy actually did, in one line, for the report. */
function describeChange(strategy, rel) {
  switch (strategy) {
    case 'html-shell':
      return `\`${rel}\` — the orb block, added just before \`</body>\`.`;
    case 'next-app':
      return `\`${rel}\` — renders the orb component just before \`</body>\`.`;
    default:
      return `\`${rel}\` — one import line, at the top.`;
  }
}

/**
 * The written account of the install: what changed, how to undo it, and what
 * happens next. Written into the repository on purpose — the terminal it was
 * printed in will be closed, and whoever reviews the pull request tomorrow was
 * not the person who ran the command.
 */
function buildReport(plan, touched, notice) {
  const lines = [
    '# Fiodos — the orb was installed in this app',
    '',
    'Generated by `fiodos install`. This file is a record, not code: deleting it',
    'changes nothing.',
    '',
    '## What changed',
    '',
  ];
  for (const rel of touched) {
    if (rel.endsWith(REPORT_BASENAME)) continue;
    if (/fyodos-orb\.js$/.test(rel)) {
      lines.push(`- \`${rel}\` — new file. Loads the orb and asks Fiodos what it can do.`);
    } else if (/fyodos-orb-client\./.test(rel)) {
      lines.push(`- \`${rel}\` — new file. Loads that module in the browser, which a`);
      lines.push('  server component cannot do on its own.');
    } else {
      lines.push(`- ${describeChange(plan.strategy, rel)}`);
    }
  }
  lines.push(
    '',
    'Every edit sits between `FYODOS:ORB` markers. Running the installer again',
    'replaces them instead of stacking a second orb.',
    '',
    '## What it does NOT do',
    '',
    'It carries no behaviour. What the orb knows and what it can run comes from',
    'Fiodos every time it loads, so a new analysis reaches your users without',
    'anybody touching this code again. No key of yours is read, no source file is',
    'sent anywhere, and nothing here runs at build time.',
    '',
    '## To remove it',
    '',
    'Delete the blocks between the `FYODOS:ORB` markers (and the generated files',
    'listed above). Nothing else in your app depends on them.',
    '',
    '## To make it appear in production',
    '',
  );
  lines.push(
    ...notice,
    '',
    "If it does not show up, reload once ignoring the cache (Cmd/Ctrl + Shift + R):",
    "a browser will happily keep serving you yesterday's page.",
    '',
  );
  return lines.join('\n');
}

/**
 * The one thing left to do, in a sentence.
 *
 * The old CLI printed a three-step tutorial here — copy the key, paste it into
 * the host's Environment Variables, redeploy — because the code it wrote read
 * the key from a build-time variable that lived in a git-ignored file and so
 * never reached the host. The block this command writes carries the key inside
 * it, so that gap is gone and with it the tutorial: whatever puts the code
 * online puts the orb online. Nothing to configure, nothing to paste.
 *
 * Deliberately says nothing about HOW they publish. We do not know their
 * pipeline, and naming a host or a command we merely guessed at would send
 * somebody whose workflow differs off looking for a button that isn't there.
 * "Publish" is the one word that is true for a push, a build, or an upload.
 */
function deployNotice() {
  return [
    "Don't forget! Publish these changes — the orb shows up on your site once they are live.",
  ];
}

/** True when this app already carries an orb (any shape). */
function isAlreadyInstalled(appRoot, plan, io = fs) {
  if (!io.existsSync(plan.file)) return false;
  return /FYODOS:ORB/.test(io.readFileSync(plan.file, 'utf8'));
}

module.exports = {
  HTML_SHELLS,
  NEXT_CLIENT_BASENAME,
  REPORT_BASENAME,
  buildReport,
  deployNotice,
  addModuleImport,
  addNextClientMount,
  applyInstall,
  injectIntoHtml,
  isAlreadyInstalled,
  moduleImportBlock,
  nextClientComponent,
  planInstall,
  siblingSpecifier,
  stripMarked,
};
