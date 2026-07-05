/**
 * wireReactNative — auto-mount the Fiodos orb in an Expo Router app, mirroring
 * the web orb auto-mount (wireWeb.js) but adapted to React Native.
 *
 * Web drops a one-line <FiodosAgent/> into the app entry. The RN counterpart is
 * the SDK's <FiodosExpoAgent/> (from '@fiodos/react-native/expo'), which wires
 * the provider + floating layer + Expo adapters + published orb design behind a
 * single component. So here we:
 *   1. write the published manifest to `fyodos/manifest.json`, and
 *   2. wrap the Expo Router root layout's returned tree with <FiodosExpoAgent>.
 *
 * Edits are idempotent and reversible (FYODOS:ORB markers). When the layout is
 * not in the safe, recognized shape we DON'T touch it — we print a short snippet
 * instead (exactly like the web path), and the caller then skips the install
 * proof so the dashboard waits for the runtime heartbeat rather than lying.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Markers are JS LINE comments, never JSX `{/* */}` comment-expressions. A
// `return ( … )` accepts exactly ONE root JSX node, and a `{/* */}` is itself an
// expression node: placing it as a sibling of the wrapper ("{/* */} <Orb>…")
// makes the return have multiple roots → "Unexpected token, expected ','".
// Line comments are pure trivia, valid before/after the single root element.
const ORB_START = '// FYODOS:ORB:START (auto-generated — safe to remove)';
const ORB_END = '// FYODOS:ORB:END';
const IMPORT_START = '// FYODOS:ORB:START (auto-generated — safe to remove)';
const IMPORT_END = '// FYODOS:ORB:END';

const LAYOUT_CANDIDATES = [
  'app/_layout.tsx',
  'app/_layout.jsx',
  'src/app/_layout.tsx',
  'src/app/_layout.jsx',
];

/**
 * Last-line defense: NEVER write a layout that won't parse. esbuild is already a
 * CLI dependency; we use it to validate the generated TSX/JSX. On any doubt we
 * return false and the caller falls back to the (non-destructive) snippet path.
 */
function parsesAsTsx(source, layoutRel) {
  try {
    const esbuild = require('esbuild');
    const loader = layoutRel && layoutRel.endsWith('.jsx') ? 'jsx' : 'tsx';
    esbuild.transformSync(source, { loader });
    return true;
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return true; // esbuild unavailable → don't block
    return false;
  }
}

function findRootLayout(appRoot) {
  for (const rel of LAYOUT_CANDIDATES) {
    const abs = path.join(appRoot, rel);
    if (fs.existsSync(abs)) return { abs, rel };
  }
  return null;
}

/** Write the published manifest the SDK mounts from. Returns the rel path. */
function writeManifestFile(appRoot, manifest) {
  const dir = path.join(appRoot, 'fyodos');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return path.relative(appRoot, file);
}

/** Import path (POSIX) from the layout file to fyodos/manifest.json. */
function manifestImportSpecifier(layoutAbs, appRoot) {
  const manifestAbs = path.join(appRoot, 'fyodos', 'manifest.json');
  let rel = path.relative(path.dirname(layoutAbs), manifestAbs);
  rel = rel.split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

function insertImportsAfterLastImport(source, block) {
  const lines = source.split('\n');
  let lastImport = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*import\b/.test(lines[i])) lastImport = i;
  }
  if (lastImport === -1) return `${block}\n${source}`;
  lines.splice(lastImport + 1, 0, block);
  return lines.join('\n');
}

/**
 * Find the parenthesized expression of the FIRST `return (` and return its inner
 * span [start,end) (exclusive of the wrapping parens). null when the return is
 * not the safe `return ( … )` shape we auto-wrap.
 */
function findReturnParenSpan(source) {
  const m = /return\s*\(/.exec(source);
  if (!m) return null;
  const open = m.index + m[0].length - 1; // index of '('
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { innerStart: open + 1, innerEnd: i, openIdx: open, closeIdx: i };
    }
  }
  return null;
}

/** Detect indentation (spaces) of the line containing index. */
function indentAt(source, index) {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  const m = /^[ \t]*/.exec(source.slice(lineStart));
  return m ? m[0] : '';
}

/**
 * Produce the wired layout source, or null when the layout is not auto-wrappable.
 */
function buildWiredLayout(source, manifestSpecifier) {
  const span = findReturnParenSpan(source);
  if (!span) return null;
  const inner = source.slice(span.innerStart, span.innerEnd);
  const baseIndent = indentAt(source, span.openIdx);
  const innerIndent = `${baseIndent}  `;

  // Re-indent the existing tree one level deeper so it nests cleanly.
  const nested = inner
    .replace(/^\n/, '')
    .split('\n')
    .map((l) => (l.trim() ? `  ${l}` : l))
    .join('\n');

  const wrapped =
    `\n${innerIndent}${ORB_START}\n` +
    `${innerIndent}<FiodosExpoAgent manifest={fyodosManifest as never}>\n` +
    `${nested}\n` +
    `${innerIndent}</FiodosExpoAgent>\n` +
    `${innerIndent}${ORB_END}\n${baseIndent}`;

  const withWrap = source.slice(0, span.innerStart) + wrapped + source.slice(span.innerEnd);

  const importBlock =
    `${IMPORT_START}\n` +
    `import { FiodosExpoAgent } from '@fiodos/react-native/expo';\n` +
    `import fyodosManifest from '${manifestSpecifier}';\n` +
    `${IMPORT_END}`;

  return insertImportsAfterLastImport(withWrap, importBlock);
}

/**
 * Strip a previous orb wrap so we can re-wire cleanly. Removes our markers (both
 * the current line-comment form and the legacy broken JSX-comment form), our
 * imports, and the single-line FiodosExpoAgent open/close tags — leaving the
 * user's original tree (possibly over-indented, which is harmless / re-wrapped).
 */
function unwireOrb(source) {
  const drop = (line) => {
    const t = line.trim();
    if (/FYODOS:ORB/.test(line)) return true; // `// …` or `{/* … */}` markers
    if (/^import\s+\{?\s*FiodosExpoAgent\b/.test(t)) return true;
    if (/^import\s+fyodosManifest\b/.test(t)) return true;
    if (/^import\s+\{\s*fyodosIsAuthenticated\b/.test(t)) return true; // session pass import
    if (/^<FiodosExpoAgent\b[^]*>$/.test(t)) return true; // our single-line open tag
    if (/^<\/FiodosExpoAgent>$/.test(t)) return true;
    return false;
  };
  return source
    .split('\n')
    .filter((line) => !drop(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** The copy-paste snippet shown when we can't safely auto-wrap. */
function mountSnippet(manifestSpecifier) {
  return (
    `import { FiodosExpoAgent } from '@fiodos/react-native/expo';\n` +
    `import fyodosManifest from '${manifestSpecifier}';\n\n` +
    `// Wrap your root layout's returned tree:\n` +
    `<FiodosExpoAgent manifest={fyodosManifest as never}>\n` +
    `  {/* your existing <Stack/> / <Slot/> tree */}\n` +
    `</FiodosExpoAgent>`
  );
}

function printSnippet(colors, layoutRel, manifestSpecifier, reason) {
  const { blue, cyan, dim, reset } = colors;
  console.error(`\n${cyan}◉${reset} ${blue}Fiodos${reset} · ${dim}add the orb to ${layoutRel || 'app/_layout.tsx'}${reason ? ` (${reason})` : ''}:${reset}`);
  console.error(mountSnippet(manifestSpecifier));
  console.error(`${dim}Then re-run analyze — the mount becomes automatic once the layout matches.${reset}\n`);
}

/**
 * Auto-mount the orb into an Expo Router app.
 * @returns {{status:'added'|'already'|'printed'|'skipped', file?:string, reason?:string}}
 */
function wireReactNativeOrb(appRoot, { manifest, colors = {}, noWire = false } = {}) {
  const layout = findRootLayout(appRoot);
  const manifestSpecifier = layout
    ? manifestImportSpecifier(layout.abs, appRoot)
    : './fyodos/manifest.json';

  if (!layout) {
    if (!noWire && manifest) writeManifestFile(appRoot, manifest);
    printSnippet(colors, null, manifestSpecifier, 'no Expo Router app/_layout found');
    return { status: 'printed', reason: 'no-layout' };
  }

  let source;
  try {
    source = fs.readFileSync(layout.abs, 'utf8');
  } catch (e) {
    return { status: 'skipped', reason: `read-failed: ${e.message}` };
  }

  if (source.includes('FiodosExpoAgent') || source.includes('FYODOS:ORB')) {
    // Already wired AND still valid → nothing to do.
    if (parsesAsTsx(source, layout.rel)) {
      if (!noWire && manifest) writeManifestFile(appRoot, manifest);
      return { status: 'already', file: layout.rel };
    }
    // A previous CLI version may have left an UNPARSEABLE wrap (e.g. JSX
    // `{/* */}` markers as siblings of the return root). Self-heal: strip our
    // own markers/imports and re-wire cleanly below.
    if (!noWire) {
      source = unwireOrb(source);
    } else {
      return { status: 'skipped', reason: 'no-wire' };
    }
  }

  if (noWire) return { status: 'skipped', reason: 'no-wire' };

  if (manifest) writeManifestFile(appRoot, manifest);
  const wired = buildWiredLayout(source, manifestSpecifier);
  if (!wired) {
    printSnippet(colors, layout.rel, manifestSpecifier, "layout has no plain `return ( … )`");
    return { status: 'printed', file: layout.rel, reason: 'unrecognized-layout' };
  }

  // Safety net: if the auto-wrap would produce code that doesn't parse, do NOT
  // write it. Leave the file untouched and show the manual snippet instead.
  if (!parsesAsTsx(wired, layout.rel)) {
    printSnippet(colors, layout.rel, manifestSpecifier, 'auto-wrap would not parse — left untouched');
    return { status: 'printed', file: layout.rel, reason: 'wrap-unparseable' };
  }

  try {
    fs.writeFileSync(layout.abs, wired);
  } catch (e) {
    return { status: 'skipped', reason: `write-failed: ${e.message}` };
  }
  return { status: 'added', file: layout.rel };
}

/**
 * Connect the generated SESSION module to the wired <FiodosExpoAgent> tag:
 * adds `isAuthenticated={fyodosIsAuthenticated}` and `getUserId={fyodosGetUserId}`
 * plus the import. Mirrors the web mount session pass. Idempotent; never
 * overrides a developer-wired isAuthenticated; validated with the same parse
 * safety net as the orb wrap.
 */
function connectRnSession(appRoot, { sessionFileAbs, colors = {} } = {}) {
  if (!sessionFileAbs || !fs.existsSync(sessionFileAbs)) return { status: 'no-session-file' };
  const layout = findRootLayout(appRoot);
  if (!layout) return { status: 'not-mounted' };

  let source;
  try {
    source = fs.readFileSync(layout.abs, 'utf8');
  } catch (e) {
    return { status: 'skipped', reason: `read-failed: ${e.message}` };
  }
  const tagRe = /<FiodosExpoAgent\b[^>]*>/;
  const m = source.match(tagRe);
  if (!m) return { status: 'not-mounted' };
  const tag = m[0];
  if (/isAuthenticated=\{fyodosIsAuthenticated\}/.test(tag)) return { status: 'already', file: layout.rel };
  if (/\bisAuthenticated=/.test(tag)) return { status: 'dev-wired', file: layout.rel };

  let specifier = path.relative(path.dirname(layout.abs), sessionFileAbs).split(path.sep).join('/');
  specifier = specifier.replace(/\.(tsx?|jsx?)$/, '');
  if (!specifier.startsWith('.')) specifier = `./${specifier}`;

  const newTag = tag.replace(
    />$/,
    ' isAuthenticated={fyodosIsAuthenticated} getUserId={fyodosGetUserId}>',
  );
  let next = source.replace(tag, newTag);
  const importLine = `import { fyodosIsAuthenticated, fyodosGetUserId } from '${specifier}';`;
  if (!next.includes(importLine)) {
    next = insertImportsAfterLastImport(next, importLine);
  }

  if (!parsesAsTsx(next, layout.rel)) {
    return { status: 'skipped', file: layout.rel, reason: 'session props would not parse — left untouched' };
  }
  try {
    fs.writeFileSync(layout.abs, next);
  } catch (e) {
    return { status: 'skipped', reason: `write-failed: ${e.message}` };
  }
  return { status: 'connected', file: layout.rel };
}

function reportReactNativeWire(result, colors = {}, { quiet = false } = {}) {
  const { blue, cyan, dim, reset } = colors;
  if (!result) return;
  if (result.status === 'added') {
    console.error(`\n${cyan}◉${reset} ${blue}Fiodos${reset} · orb mounted in ${result.file}`);
  } else if (result.status === 'already' && !quiet) {
    console.error(`\n${cyan}◉${reset} ${blue}Fiodos${reset} · ${dim}orb already mounted in ${result.file}${reset}`);
  }
}

module.exports = {
  wireReactNativeOrb,
  reportReactNativeWire,
  connectRnSession,
  // exported for tests
  buildWiredLayout,
  unwireOrb,
  parsesAsTsx,
  findReturnParenSpan,
  writeManifestFile,
  manifestImportSpecifier,
  findRootLayout,
};
