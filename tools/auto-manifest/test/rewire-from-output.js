/**
 * Re-apply handler wiring for an already-analyzed app WITHOUT calling the AI
 * again: it reuses the saved manifest.json + evidence.json (which now also
 * carries the AI's `wiring`). Lets us validate wireHandlers changes against the
 * real apps for free.
 *
 * Usage: node test/rewire-from-output.js <appRoot> <outputDir>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { wireHandlers, reportHandlerResult } = require('../src/wireHandlers');

async function main() {
  const appRoot = process.argv[2];
  const outDir = process.argv[3];
  if (!appRoot || !outDir) {
    console.error('Usage: node test/rewire-from-output.js <appRoot> <outputDir>');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  const ev = JSON.parse(fs.readFileSync(path.join(outDir, 'evidence.json'), 'utf8'));

  const result = await wireHandlers(path.resolve(appRoot), {
    manifest,
    evidence: ev.evidence || {},
    wiring: ev.wiring || {},
    appName: manifest.appName,
    assumeYes: true,
    colors: {},
  });
  reportHandlerResult(result, {});

  const auto = (result.plan && result.plan.auto) || [];
  const review = (result.plan && (result.plan.review || result.plan.manual)) || [];
  console.log(`\n[${manifest.appName}] auto=${auto.length} review=${review.length}`);
  for (const e of auto) console.log(`  AUTO  ${e.intent}  (${e.source})  →  ${e.callExpr}`);
  for (const e of review) console.log(`  REVIEW ${e.intent}  →  ${e.reason}`);
  if (result.registryFile) {
    console.log(`\n────────── ${path.relative(appRoot, result.registryFile)} ──────────`);
    console.log(fs.readFileSync(result.registryFile, 'utf8'));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
