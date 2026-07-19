/**
 * Publish-time bundler: the npm package ships ONE minified file (dist/) and
 * never the readable sources under src/.
 *
 * Confidentiality: src/ carries the analyzer's mechanical know-how (collection
 * heuristics, wiring, verification). Publishing it readable hands that to any
 * competitor browsing npm. The bundle is functionally identical but minified
 * (no comments, mangled locals). The prompt templates were ALREADY excluded
 * (prompts.dev.js) and stay server-side — this closes the remaining surface.
 *
 * Runs automatically via "prepack" (npm publish / npm pack). Dev flow is
 * unchanged: the monorepo keeps running node src/index.js directly.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(pkgRoot, 'dist', 'index.cjs');

fs.rmSync(path.join(pkgRoot, 'dist'), { recursive: true, force: true });

await build({
  entryPoints: [path.join(pkgRoot, 'src', 'index.js')],
  outfile: outFile,
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // Real dependencies resolve from the installed package's node_modules at
  // runtime; the dev-only prompt templates must NEVER enter the bundle (the
  // require sits in a try/catch and the published CLI fetches server prompts).
  external: ['esbuild', 'jsdom', 'typescript', '@fiodos/core', './prompts.dev'],
  logLevel: 'warning',
});

// Fail the publish loudly if any prompt text leaked into the bundle (these
// phrases exist ONLY in the dev-only prompts.dev.js templates).
const bundled = fs.readFileSync(outFile, 'utf8');
if (
  bundled.includes('You are AUDITING an already') ||
  bundled.includes('You are fixing the WIRING of ONE Fiodos action')
) {
  throw new Error('prompts.dev content leaked into the published bundle — aborting');
}
fs.chmodSync(outFile, 0o755);
console.log(`bundled -> ${path.relative(pkgRoot, outFile)} (${(bundled.length / 1024).toFixed(0)} kB, minified)`);
