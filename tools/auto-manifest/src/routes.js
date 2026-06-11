/**
 * Layer 1a — expo-router route tree, derived programmatically from the file
 * system of the target app (app/ or src/app/).
 *
 * Pure static analysis: every route here has provenance "static".
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Locates the expo-router app dir ('app' or 'src/app'). */
function findAppDir(appRoot) {
  for (const candidate of ['app', 'src/app']) {
    const full = path.join(appRoot, candidate);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return full;
  }
  throw new Error(`No expo-router app/ directory found under ${appRoot}`);
}

const SCREEN_EXT = /\.(tsx|jsx|ts|js)$/;
const IGNORED = new Set(['_layout', '+not-found', '+html']);

/**
 * Walks the app dir and returns route records:
 * { routePath, filePath, isDynamic, params[], group }
 * expo-router conventions handled: (group) segments (stripped from URL),
 * index files, [param] dynamic segments, +api files (excluded — not screens).
 */
function scanRoutes(appRoot) {
  const appDir = findAppDir(appRoot);
  const routes = [];

  function walk(dir, urlSegments) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, [...urlSegments, entry.name]);
        continue;
      }
      if (!SCREEN_EXT.test(entry.name)) continue;
      const base = entry.name.replace(SCREEN_EXT, '');
      if (IGNORED.has(base)) continue;
      if (base.endsWith('+api')) continue; // API route, not a screen

      const segments = base === 'index' ? urlSegments : [...urlSegments, base];
      const urlParts = segments.filter((s) => !(s.startsWith('(') && s.endsWith(')')));
      const groups = segments.filter((s) => s.startsWith('(') && s.endsWith(')'));
      const params = urlParts
        .filter((s) => s.startsWith('[') && s.endsWith(']'))
        .map((s) => s.slice(1, -1));

      // Route string as the navigation adapter would receive it. Keep the
      // group prefix for tab roots (expo-router accepts both forms).
      const routePath = '/' + segments.join('/');

      routes.push({
        routePath,
        urlPath: '/' + urlParts.join('/'),
        filePath: full,
        relFile: path.relative(appRoot, full),
        isDynamic: params.length > 0,
        params,
        groups,
      });
    }
  }

  walk(appDir, []);
  return { appDir, routes };
}

module.exports = { scanRoutes, findAppDir };
