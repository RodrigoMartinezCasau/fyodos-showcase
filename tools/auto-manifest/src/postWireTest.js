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
const { spawn } = require('child_process');

/**
 * Run a command WITHOUT blocking Node's event loop (unlike spawnSync). This
 * matters for the live terminal spinner: spawnSync freezes the whole process
 * while the build runs, so the elapsed-seconds counter appears to jump in big
 * steps ("stuck"). With async spawn the loop stays free and the counter ticks
 * every second. Resolves to a spawnSync-shaped result { status, stdout, stderr,
 * error } and never rejects.
 */
function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error });
      return;
    }
    let stdout = '';
    let stderr = '';
    const max = opts.maxBuffer || 64 * 1024 * 1024;
    // Bound total captured output (the way maxBuffer would) without throwing.
    child.stdout.on('data', (c) => { if (stdout.length + stderr.length < max) stdout += c.toString(); });
    child.stderr.on('data', (c) => { if (stdout.length + stderr.length < max) stderr += c.toString(); });

    let timedOut = false;
    let timer = null;
    if (opts.timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, opts.timeout);
    }
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        const error = new Error('ETIMEDOUT');
        error.code = 'ETIMEDOUT';
        resolve({ status: null, stdout, stderr, error });
        return;
      }
      resolve({ status: code, stdout, stderr, error: null });
    });
  });
}

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

/** Compact build failure for the terminal — not the full next/vite log. */
function summarizeBuildOutput(raw, maxLines = 4) {
  const lines = String(raw || '').split('\n');
  const picked = [];
  const push = (line) => {
    const t = line.trim();
    if (!t || picked.includes(t)) return;
    if (/telemetry|Learn more:/i.test(t)) return;
    if (/^▲ Next\.js/i.test(t)) return;
    picked.push(t);
  };
  for (const line of lines) {
    if (
      /Module not found|Can't resolve|Failed to compile|error TS\d+|SyntaxError|ENOENT/i.test(line)
    ) {
      push(line);
    }
  }
  if (picked.length === 0) {
    for (const line of lines.slice(-maxLines)) push(line);
  }
  return picked.slice(0, maxLines).join('\n').trim();
}

/** Does this output contain a signal that the CODE is broken (vs npm/env noise)? */
function looksLikeCompileFailure(output) {
  return /error\s+TS\d+|Type error:|Module not found|Can't resolve|Failed to compile|SyntaxError|Parsing error|Cannot find (?:module|name)/i.test(
    String(output || ''),
  );
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

  const runOnce = () =>
    runAsync('npm', chosen.args, {
      cwd: appRoot,
      timeout: timeoutMs,
      env: { ...process.env, CI: '1', NODE_ENV: process.env.NODE_ENV || 'production' },
      maxBuffer: 64 * 1024 * 1024,
    });

  let res = await runOnce();
  // A spawn-level or npm-level failure with ZERO compile diagnostics is
  // environment noise (npm cache contention, a concurrent process touching
  // package.json, transient ENOENT), not broken code. Blaming the action for
  // it drops perfectly good wiring, so retry once before judging.
  const npmLevelFailure =
    (res.error && res.error.code !== 'ETIMEDOUT') ||
    (res.status !== 0 && res.status !== null && !looksLikeCompileFailure(`${res.stdout}\n${res.stderr}`));
  if (npmLevelFailure) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await runOnce();
  }

  if (res.error && res.error.code === 'ETIMEDOUT') {
    return { ok: false, stage: 'timeout', command: chosen.label, output: `build exceeded ${Math.round(timeoutMs / 1000)}s` };
  }
  if (res.error) {
    return { ok: false, stage: 'error', command: chosen.label, output: String(res.error.message || res.error) };
  }
  const output = tail(`${res.stdout || ''}\n${res.stderr || ''}`);
  return { ok: res.status === 0, stage: chosen.stage, command: chosen.label, output };
}

module.exports = { runPostWireTest, chooseCommand, summarizeBuildOutput, readPkg };
