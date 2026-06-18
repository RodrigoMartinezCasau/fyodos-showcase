/**
 * Re-run the handler-wiring AUTO-CORRECTION LOOP on an already-analyzed app,
 * reusing the saved manifest.json + evidence.json (with the AI `wiring`) so NO
 * new AI tokens are spent. The point is to exercise the NEW component real-effect
 * verification (render the real component, invoke the wired handler, confirm the
 * UI mutates) end-to-end and regenerate FYODOS_HANDLERS.md with the verification
 * table.
 *
 * Usage: node test/reverify-render.js <appRoot> <outputDir>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { collectFiles } = require('../src/collect');
const { runPostWireTest } = require('../src/postWireTest');
const { wireHandlers, reportHandlerResult } = require('../src/wireHandlers');

async function main() {
  const appRoot = path.resolve(process.argv[2]);
  const outDir = path.resolve(process.argv[3]);
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  const ev = JSON.parse(fs.readFileSync(path.join(outDir, 'evidence.json'), 'utf8'));
  const { included } = collectFiles(appRoot, { maxInputTokens: 150000, platform: 'web' });

  // No-AI corrector: if an action fails verification we do NOT invent a fix here;
  // it stays honestly unfixed (we are only re-verifying existing wiring for free).
  const corrector = async () => null;

  const result = await wireHandlers(appRoot, {
    manifest,
    evidence: ev.evidence || {},
    wiring: ev.wiring || {},
    appName: manifest.appName,
    colors: {},
    assumeYes: true,
    runTest: true,
    revertOnFailure: true,
    testRunner: runPostWireTest,
    corrector,
    files: included,
    maxAttempts: Number(process.env.FYODOS_WIRE_MAX_ATTEMPTS || 2),
  });
  reportHandlerResult(result, {});

  if (result.docPath && fs.existsSync(result.docPath)) {
    const doc = fs.readFileSync(result.docPath, 'utf8');
    const i = doc.indexOf('## Verificación automática');
    if (i >= 0) {
      console.log('\n────────── FYODOS_HANDLERS.md · Verificación automática ──────────');
      console.log(doc.slice(i, doc.indexOf('\n## ', i + 5) === -1 ? undefined : doc.indexOf('\n## ', i + 5)));
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
