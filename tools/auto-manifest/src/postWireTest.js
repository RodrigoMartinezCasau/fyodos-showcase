/**
 * postWireTest — verify the app still builds after Fiodos wired the handlers and
 * (when needed) edited the user's own components. This is the safety net that
 * lets wireHandlers REVERT instead of leaving a broken app.
 *
 * It runs the app's real build/typecheck (the strongest "didn't break" signal
 * for a web project) with a timeout, and returns a structured result. It NEVER
 * throws — a thrown/timed-out process is reported as a failed/untested stage so
 * the caller can decide to revert.
 *
 * Contract:
 *   runPostWireTest(appRoot, opts) -> {
 *     ok: boolean,            // true only when the build/typecheck succeeded
 *     stage: string,          // 'build' | 'typecheck' | 'skipped-no-deps' | 'timeout' | 'error'
 *     command: string,        // what was run
 *     output: string,         // tail of stdout+stderr (trimmed)
 *   }
 *
 * When dependencies are not installed we cannot build; we return ok:true with
 * stage 'skipped-no-deps' so the caller marks the wiring 'applied-untested'
 * (a warning) rather than reverting a perfectly good wiring.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function readPkg(appRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** Choose the lightest reliable "does it still compile" command for this app. */
function chooseCommand(appRoot, pkg) {
  const scripts = pkg.scripts || {};
  // Prefer an explicit typecheck (fast, no bundling) when available.
  for (const name of ['typecheck', 'type-check', 'check']) {
    if (scripts[name]) return { stage: 'typecheck', args: ['run', name], label: `npm run ${name}` };
  }
  if (scripts.build) return { stage: 'build', args: ['run', 'build'], label: 'npm run build' };
  // Fallback: bare tsc --noEmit when there is a tsconfig.
  if (fs.existsSync(path.join(appRoot, 'tsconfig.json'))) {
    return { stage: 'typecheck', args: ['exec', '--', 'tsc', '--noEmit'], label: 'npx tsc --noEmit' };
  }
  return null;
}

function tail(s, n = 60) {
  const lines = String(s || '').split('\n');
  return lines.slice(-n).join('\n').trim();
}

async function runPostWireTest(appRoot, opts = {}) {
  const timeoutMs = opts.timeoutMs || 240000;
  if (!fs.existsSync(path.join(appRoot, 'node_modules'))) {
    return {
      ok: true,
      stage: 'skipped-no-deps',
      command: '(none)',
      output: 'node_modules missing: could not run the build (install dependencies to verify it).',
    };
  }
  const pkg = readPkg(appRoot);
  const chosen = chooseCommand(appRoot, pkg);
  if (!chosen) {
    return { ok: true, stage: 'skipped-no-deps', command: '(none)', output: 'no build/typecheck script.' };
  }

  const res = spawnSync('npm', chosen.args, {
    cwd: appRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, CI: '1', NODE_ENV: process.env.NODE_ENV || 'production' },
    maxBuffer: 64 * 1024 * 1024,
  });

  if (res.error && res.error.code === 'ETIMEDOUT') {
    return { ok: false, stage: 'timeout', command: chosen.label, output: `build exceeded ${Math.round(timeoutMs / 1000)}s` };
  }
  if (res.error) {
    return { ok: false, stage: 'error', command: chosen.label, output: String(res.error.message || res.error) };
  }
  const output = tail(`${res.stdout || ''}\n${res.stderr || ''}`);
  return { ok: res.status === 0, stage: chosen.stage, command: chosen.label, output };
}

module.exports = { runPostWireTest, chooseCommand };
