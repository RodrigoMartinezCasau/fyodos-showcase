'use strict';

/**
 * mountGate — mechanical guard for bridge wiring anchored in conditionally-mounted
 * components when the invoke reads app-level context/provider hooks.
 *
 * The analyzer's MOUNT AVAILABILITY text is advisory; this gate enforces it:
 * context/provider setters must register in an always-mounted Provider/shell.
 */
const fs = require('fs');
const path = require('path');

const CONDITIONAL_PATH_RE =
  /(?:^|[/\\])(?:Settings|Modal|Tab(?:Panel|Content)?|Panel|Dialog|Drawer|Sheet|Popover|Accordion|Collapsible)(?:[/\\]|\.)/i;
const PROVIDER_PATH_RE = /Provider|Context/i;
const HOOK_RE = /\buse[A-Z][\w$]*\b/;
const VIEW_CONDITION_RE =
  /\b(?:view|section|tab|screen|page|route|active(?:Tab|View|Section|Screen)|current(?:Tab|View|Section|Screen))\s*===?\s*['"][^'"]+['"]\s*&&/;
const SHELL_BASENAMES = new Set([
  'app.tsx', 'app.jsx', 'app.ts', 'app.js',
  '_layout.tsx', '_layout.jsx',
  'layout.tsx', 'layout.jsx',
  'root.tsx', 'root.jsx',
  'main.tsx', 'main.jsx',
]);

function normRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function readFileSafe(appRoot, fileRel) {
  const abs = path.join(appRoot, normRel(fileRel));
  if (!fs.existsSync(abs)) return null;
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function componentNamesFromFile(fileRel, content) {
  const base = path.basename(normRel(fileRel), path.extname(normRel(fileRel)));
  const names = new Set([base]);
  if (!content) return names;
  const fnRe = /export\s+(?:default\s+)?(?:function|const)\s+([A-Z][\w$]*)/g;
  let m;
  while ((m = fnRe.exec(content))) names.add(m[1]);
  return names;
}

function pathLooksConditionalOnly(fileRel) {
  return CONDITIONAL_PATH_RE.test(normRel(fileRel));
}

function pathLooksProviderShell(fileRel) {
  const rel = normRel(fileRel);
  if (PROVIDER_PATH_RE.test(rel)) return true;
  return SHELL_BASENAMES.has(path.basename(rel).toLowerCase());
}

/** True when invoke/requiredSymbols/imports clearly depend on a context/provider hook. */
function usesContextProviderPattern({ invoke, requiredSymbols, bridgeImports }) {
  const inv = String(invoke || '');
  if (HOOK_RE.test(inv)) return true;

  for (const r of requiredSymbols || []) {
    const name = String((r && r.name) || '');
    const file = normRel(r && r.file);
    if (HOOK_RE.test(name)) return true;
    if (PROVIDER_PATH_RE.test(file)) return true;
  }

  for (const imp of bridgeImports || []) {
    if (PROVIDER_PATH_RE.test(normRel(imp && imp.from))) return true;
    if (HOOK_RE.test(String((imp && imp.name) || ''))) return true;
  }
  return false;
}

function collectHookNames({ invoke, requiredSymbols, bridgeImports }) {
  const hooks = new Set();
  const add = (name) => {
    if (HOOK_RE.test(String(name || ''))) hooks.add(String(name).match(HOOK_RE)[0]);
  };
  for (const m of String(invoke || '').matchAll(/\b(use[A-Z][\w$]*)\b/g)) hooks.add(m[1]);
  for (const r of requiredSymbols || []) add(r && r.name);
  for (const imp of bridgeImports || []) add(imp && imp.name);
  return [...hooks];
}

function scoreProviderCandidate(fileRel) {
  const rel = normRel(fileRel);
  const base = path.basename(rel).toLowerCase();
  let score = 0;
  if (/provider/i.test(rel)) score += 100;
  if (/context/i.test(rel)) score += 80;
  if (SHELL_BASENAMES.has(base)) score += 40;
  if (/layout/i.test(base)) score += 30;
  return score;
}

/**
 * Find a Provider/shell file from requiredSymbols, bridge imports, and hook
 * symbol locations. Returns the best app-relative path or null.
 */
function findProviderShell(appRoot, { requiredSymbols, bridgeImports, hookNames }) {
  const candidates = new Map();

  const consider = (fileRel, bonus = 0) => {
    const rel = normRel(fileRel);
    if (!rel) return;
    const content = readFileSafe(appRoot, rel);
    if (content == null) return;
    const score = scoreProviderCandidate(rel) + bonus;
    const prev = candidates.get(rel);
    if (!prev || score > prev) candidates.set(rel, score);
  };

  for (const r of requiredSymbols || []) {
    const file = normRel(r && r.file);
    const name = String((r && r.name) || '');
    if (PROVIDER_PATH_RE.test(file)) consider(file, 20);
    if (hookNames.includes(name)) consider(file, 15);
  }

  for (const imp of bridgeImports || []) {
    const file = normRel(imp && imp.from);
    if (PROVIDER_PATH_RE.test(file)) consider(file, 10);
    if (hookNames.includes(String((imp && imp.name) || ''))) consider(file, 8);
  }

  // Walk src for *Provider* / *Context* files that export the hook(s).
  const srcRoot = path.join(appRoot, 'src');
  if (fs.existsSync(srcRoot)) {
    walkDir(srcRoot, (abs, relFromSrc) => {
      const rel = normRel(path.join('src', relFromSrc));
      if (!PROVIDER_PATH_RE.test(rel)) return;
      const content = readFileSafe(appRoot, rel);
      if (!content) return;
      if (hookNames.some((h) => new RegExp(`\\b${h}\\b`).test(content))) consider(rel, 5);
      else consider(rel, 0);
    });
  }

  let best = null;
  let bestScore = -1;
  for (const [rel, score] of candidates) {
    if (score > bestScore) {
      best = rel;
      bestScore = score;
    }
  }
  return best;
}

function walkDir(dir, onFile, prefix = '') {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walkDir(abs, onFile, rel);
    else if (/\.(tsx?|jsx?)$/.test(ent.name)) onFile(abs, rel);
  }
}

/**
 * Heuristic: the component is only mounted under a view/section/tab conditional
 * in a parent file (e.g. `{view === 'settings' && <Settings />}`).
 */
function isConditionallyMountedInParent(appRoot, bridgeFile) {
  const bridgeRel = normRel(bridgeFile);
  const bridgeContent = readFileSafe(appRoot, bridgeRel);
  const names = componentNamesFromFile(bridgeRel, bridgeContent);
  const srcRoot = path.join(appRoot, 'src');
  if (!fs.existsSync(srcRoot)) return false;

  let sawUsage = false;
  let allConditional = true;

  walkDir(srcRoot, (_abs, relFromSrc) => {
    const rel = normRel(path.join('src', relFromSrc));
    if (rel === bridgeRel) return;
    const content = readFileSafe(appRoot, rel);
    if (!content) return;

    for (const name of names) {
      const importRe = new RegExp(
        `import\\s+(?:\\{[^}]*\\b${name}\\b[^}]*\\}|\\*\\s+as\\s+\\w+|${name})\\s+from\\s+['"][^'"]*${esc(path.basename(bridgeRel, path.extname(bridgeRel)))}['"]`,
        'm',
      );
      if (!importRe.test(content) && !content.includes(`<${name}`)) continue;
      if (!content.includes(`<${name}`)) continue;

      sawUsage = true;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(`<${name}`)) continue;
        const window = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
        const conditional =
          VIEW_CONDITION_RE.test(window) ||
          /\{\s*[^}]+\s*&&\s*<\s*/.test(window) ||
          /\?\s*<\s*/.test(window);
        if (!conditional) allConditional = false;
      }
    }
  });

  return sawUsage && allConditional;
}

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bridgeFileLooksConditionalOnly(appRoot, bridgeFile) {
  if (pathLooksConditionalOnly(bridgeFile)) return true;
  if (pathLooksProviderShell(bridgeFile)) return false;
  return isConditionallyMountedInParent(appRoot, bridgeFile);
}

function defaultAnchorNearReturn(content) {
  const lines = String(content || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*return\s*\(?\s*$/.test(line) || /^\s*return\s+\(?\s*</.test(line)) {
      if (countOccurrences(content, line) === 1) return line;
    }
  }
  return null;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Main gate. Returns:
 *   { action: 'pass' }
 *   { action: 'promote', file, anchor, detail }
 *   { action: 'reject', reason }
 */
function checkBridgeMountGate({
  appRoot,
  bridgeFile,
  invoke,
  requiredSymbols,
  bridgeImports,
  deriveAnchor,
}) {
  const file = normRel(bridgeFile);
  if (!usesContextProviderPattern({ invoke, requiredSymbols, bridgeImports })) {
    return { action: 'pass' };
  }
  if (!bridgeFileLooksConditionalOnly(appRoot, file)) {
    return { action: 'pass' };
  }
  if (pathLooksProviderShell(file)) {
    return { action: 'pass' };
  }

  const hookNames = collectHookNames({ invoke, requiredSymbols, bridgeImports });
  const providerFile = findProviderShell(appRoot, { requiredSymbols, bridgeImports, hookNames });
  if (!providerFile) {
    return {
      action: 'reject',
      reason:
        `bridge '${file}' is only mounted conditionally but the invoke uses context/provider hooks ` +
        `(${hookNames.join(', ') || 'use*'}) — register in an always-mounted Provider/shell instead ` +
        '(no suitable Provider file found in requiredSymbols/imports)',
    };
  }

  const providerContent = readFileSafe(appRoot, providerFile);
  if (providerContent == null) {
    return {
      action: 'reject',
      reason: `found provider candidate '${providerFile}' but could not read it — wire this action manually`,
    };
  }

  const stripped = providerContent; // mount gate runs before FYODOS block strip in caller
  let anchor = typeof deriveAnchor === 'function' ? deriveAnchor(stripped, invoke) : null;
  if (!anchor) anchor = defaultAnchorNearReturn(stripped);
  if (!anchor) {
    return {
      action: 'reject',
      reason:
        `auto-promote to '${providerFile}' failed: no safe anchor near the Provider return — wire this action manually`,
    };
  }

  return {
    action: 'promote',
    file: providerFile,
    anchor,
    detail:
      `mount gate: promoted bridge from conditionally-mounted '${file}' to always-mounted '${providerFile}' ` +
      `(context/provider hooks must register while the Provider is rendered)`,
  };
}

module.exports = {
  checkBridgeMountGate,
  usesContextProviderPattern,
  bridgeFileLooksConditionalOnly,
  findProviderShell,
  pathLooksConditionalOnly,
  pathLooksProviderShell,
  isConditionallyMountedInParent,
  normRel,
};
