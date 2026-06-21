/**
 * wireWebMount — safe, reversible orb injection for every web framework.
 * Used by wireWeb.js after terminal consent [y/N]. Markers FYODOS:ORB:START/END
 * make edits idempotent and easy to remove.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const IMPORT_NAME = 'FiodosAgentMount';
const WRAPPER_BASENAME = 'fyodos-agent-mount';

const ORB_JSX_START = '{/* FYODOS:ORB:START (auto-generated — safe to remove) */}';
const ORB_JSX_END = '{/* FYODOS:ORB:END */}';
const ORB_HTML_START = '<!-- FYODOS:ORB:START (auto-generated — safe to remove) -->';
const ORB_HTML_END = '<!-- FYODOS:ORB:END -->';
const ORB_SCRIPT_START = '// FYODOS:ORB:START (auto-generated — safe to remove)';
const ORB_SCRIPT_END = '// FYODOS:ORB:END';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripMarkedRegion(source, start, end) {
  const re = new RegExp(`${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}\\n?`, 'g');
  return source.replace(re, '');
}

function readFile(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeFile(file, content) {
  fs.writeFileSync(file, content);
}

function backupFiles(files) {
  const backups = {};
  for (const f of files) {
    if (fs.existsSync(f)) backups[f] = readFile(f);
  }
  return backups;
}

function revertFiles(backups) {
  for (const [f, content] of Object.entries(backups)) {
    writeFile(f, content);
  }
}

function insertImportAfterLastImport(source, importLine) {
  const lines = source.split('\n');
  let lastImport = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*import\b/.test(lines[i])) lastImport = i;
  }
  if (lastImport === -1) return `${importLine}\n${source}`;
  lines.splice(lastImport + 1, 0, importLine);
  return lines.join('\n');
}

function envExpr(framework, kind, ts) {
  if (framework === 'vite' || framework === 'vue' || framework === 'svelte' || framework === 'sveltekit') {
    if (kind === 'key') {
      return ts ? 'import.meta.env.VITE_FYODOS_API_KEY!' : 'import.meta.env.VITE_FYODOS_API_KEY';
    }
    return 'import.meta.env.VITE_FYODOS_API_URL';
  }
  const key = `process.env.NEXT_PUBLIC_FYODOS_API_KEY${ts ? '!' : ''}`;
  const url = 'process.env.NEXT_PUBLIC_FYODOS_API_URL';
  return kind === 'key' ? key : url;
}

function agentJsx(framework, ts, indent = '  ') {
  const keyExpr = envExpr(framework, 'key', ts);
  const urlExpr = envExpr(framework, 'url', ts);
  return (
    `${indent}<FiodosAgent\n` +
    `${indent}  apiKey={${keyExpr}}\n` +
    `${indent}  apiUrl={${urlExpr}}\n` +
    `${indent}/>`
  );
}

function isAlreadyMounted(source) {
  return /FiodosAgent|fyodos-agent|FYODOS:ORB:START/.test(source);
}

/**
 * Assess whether we can inject safely. Returns { ok, reason?, strategy, files, rel }.
 */
function assessMount(target, framework, appRoot) {
  if (!target || !target.file) {
    return { ok: false, reason: 'could not locate a framework entry file (e.g. src/main.tsx, App.vue, +layout.svelte)' };
  }
  const rel = path.relative(appRoot, target.file);
  const source = readFile(target.file);
  if (isAlreadyMounted(source)) {
    return { ok: false, reason: 'orb already present', already: true, rel };
  }

  switch (target.kind) {
    case 'next-app': {
      if (!source.includes('</body>')) {
        return { ok: false, reason: `${rel} has no </body> — cannot mount the orb wrapper safely` };
      }
      return { ok: true, strategy: 'next-app', files: [target.file], rel, framework, target };
    }
    case 'next-pages':
    case 'vite': {
      if (/createRoot\s*\(/.test(source) && /\.render\s*\(/.test(source)) {
        return { ok: true, strategy: 'vite-main', files: [target.file], rel, framework, target };
      }
      if (/return\s*\([\s\S]*/.test(source)) {
        return { ok: true, strategy: 'react-return', files: [target.file], rel, framework, target };
      }
      return { ok: false, reason: `${rel} is not a recognizable React entry (no createRoot().render() or JSX return)` };
    }
    case 'vue': {
      if (!/<template[\s>]/.test(source)) {
        return { ok: false, reason: `${rel} has no <template> block` };
      }
      if (!/<script/.test(source)) {
        return { ok: false, reason: `${rel} has no <script> block for imports` };
      }
      return { ok: true, strategy: 'vue-sfc', files: [target.file], rel, framework, target };
    }
    case 'svelte':
    case 'sveltekit': {
      if (!/<script/.test(source)) {
        return { ok: false, reason: `${rel} has no <script> block` };
      }
      return { ok: true, strategy: 'svelte-sfc', files: [target.file], rel, framework, target };
    }
    case 'angular': {
      const templatePath = resolveAngularTemplate(target.file, source);
      if (!templatePath) {
        return { ok: false, reason: `${rel} uses inline template — paste the snippet manually (external template only for now)` };
      }
      return {
        ok: true,
        strategy: 'angular-component',
        files: [target.file, templatePath],
        rel,
        framework,
        target,
        templatePath,
      };
    }
    default:
      return { ok: false, reason: `unsupported mount kind "${target.kind}"` };
  }
}

function resolveAngularTemplate(tsFile, tsSource) {
  const inline = /template\s*:\s*`/.test(tsSource) || /template\s*:\s*'/.test(tsSource);
  if (inline) return null;
  const m = tsSource.match(/templateUrl:\s*['"]([^'"]+)['"]/);
  if (!m) return null;
  const p = path.join(path.dirname(tsFile), m[1]);
  return fs.existsSync(p) ? p : null;
}

function describePlan(plan) {
  const lines = [`Will edit: ${plan.files.map((f) => path.basename(f)).join(', ')}`];
  switch (plan.strategy) {
    case 'next-app':
      lines.push(`Create ${WRAPPER_BASENAME} client wrapper next to layout`);
      lines.push(`Import wrapper and mount before </body>`);
      break;
    case 'vite-main':
      lines.push('Add import { FiodosAgent } from @fiodos/react');
      lines.push('Mount <FiodosAgent /> inside createRoot().render() (marked FYODOS:ORB:*)');
      break;
    case 'react-return':
      lines.push('Add import { FiodosAgent } from @fiodos/react');
      lines.push('Mount <FiodosAgent /> inside the root JSX return (marked FYODOS:ORB:*)');
      break;
    case 'vue-sfc':
      lines.push('Add @fiodos/vue import + env vars in <script>');
      lines.push('Mount <FiodosAgent /> in <template> (marked FYODOS:ORB:*)');
      break;
    case 'svelte-sfc':
      lines.push('Add @fiodos/svelte import in <script>');
      lines.push('Mount <FiodosAgent /> in layout (marked FYODOS:ORB:*)');
      break;
    case 'angular-component':
      lines.push('Add FiodosAgentComponent to @Component imports');
      lines.push('Mount <fyodos-agent> in template (marked FYODOS:ORB:*)');
      break;
    default:
      break;
  }
  return lines;
}

function writeWrapper(layoutFile, framework, ts) {
  const dir = path.dirname(layoutFile);
  const ext = ts ? '.tsx' : '.jsx';
  const wrapperFile = path.join(dir, `${WRAPPER_BASENAME}${ext}`);
  if (fs.existsSync(wrapperFile) && /FiodosAgent/.test(readFile(wrapperFile))) {
    return wrapperFile;
  }
  const body =
    `'use client';\n\n` +
    `import { FiodosAgent } from '@fiodos/react';\n\n` +
    `export default function ${IMPORT_NAME}() {\n` +
    `  return (\n` +
    `${agentJsx(framework, ts, '    ')}\n` +
    `  );\n` +
    `}\n`;
  writeFile(wrapperFile, body);
  return wrapperFile;
}

function injectNextApp(plan) {
  const { target, framework } = plan;
  const ts = target.ext === '.tsx';
  let source = stripMarkedRegion(readFile(target.file), ORB_HTML_START, ORB_HTML_END);
  writeWrapper(target.file, framework, ts);
  const importLine = `import ${IMPORT_NAME} from './${WRAPPER_BASENAME}';`;
  if (!source.includes(importLine)) {
    source = insertImportAfterLastImport(source, importLine);
  }
  source = source.replace(/([^\n]*)<\/body>/, (_m, before) => {
    const indent = (before.match(/^(\s*)/) || ['', ''])[1];
    const mount = `${indent}  <${IMPORT_NAME} />\n`;
    return before.trim() === ''
      ? `${mount}${before}</body>`
      : `${before}\n${mount}${indent}</body>`;
  });
  writeFile(target.file, source);
}

function injectViteMain(plan) {
  const { target, framework } = plan;
  const ts = target.ext === '.tsx';
  let source = stripMarkedRegion(readFile(target.file), ORB_JSX_START, ORB_JSX_END);
  const importLine = `import { FiodosAgent } from '@fiodos/react';`;
  if (!source.includes(importLine)) {
    source = insertImportAfterLastImport(source, importLine);
  }
  const orbBlock = [
    `    ${ORB_JSX_START}`,
    agentJsx(framework === 'next' ? 'next' : 'vite', ts, '    '),
    `    ${ORB_JSX_END}`,
  ].join('\n');
  const anchors = ['</StrictMode>', '</React.StrictMode>'];
  for (const anchor of anchors) {
    if (source.includes(anchor)) {
      source = source.replace(anchor, `${orbBlock}\n    ${anchor}`);
      writeFile(target.file, source);
      return;
    }
  }
  const renderIdx = source.search(/\.render\s*\(/);
  if (renderIdx === -1) throw new Error('no .render( found');
  const closeIdx = source.indexOf(');', renderIdx);
  if (closeIdx === -1) throw new Error('no render close');
  source = `${source.slice(0, closeIdx)}\n    ${orbBlock}\n  ${source.slice(closeIdx)}`;
  writeFile(target.file, source);
}

function injectReactReturn(plan) {
  const { target, framework } = plan;
  const ts = target.ext === '.tsx';
  let source = stripMarkedRegion(readFile(target.file), ORB_JSX_START, ORB_JSX_END);
  const importLine = `import { FiodosAgent } from '@fiodos/react';`;
  if (!source.includes(importLine)) {
    source = insertImportAfterLastImport(source, importLine);
  }
  const fw = framework === 'next' ? 'next' : 'vite';
  const orbBlock = [ORB_JSX_START, agentJsx(fw, ts, '    '), ORB_JSX_END].join('\n');
  const anchors = ['</AppProvider>', '</BrowserRouter>', '</RouterProvider>', '</div>', '</>'];
  for (const anchor of anchors) {
    const idx = source.lastIndexOf(anchor);
    if (idx !== -1) {
      source = `${source.slice(0, idx)}${orbBlock}\n      ${source.slice(idx)}`;
      writeFile(target.file, source);
      return;
    }
  }
  const ret = source.lastIndexOf('return (');
  if (ret === -1) throw new Error('no return ( found');
  const close = source.indexOf(');', ret);
  if (close === -1) throw new Error('no return close');
  source = `${source.slice(0, close)}\n      ${orbBlock}\n    ${source.slice(close)}`;
  writeFile(target.file, source);
}

function injectVueSfc(plan) {
  const { target } = plan;
  let source = stripMarkedRegion(readFile(target.file), ORB_HTML_START, ORB_HTML_END);
  if (!/from ['"]@fyodos\/vue['"]/.test(source)) {
    source = source.replace(
      /(<script[^>]*>)/,
      `$1\nimport { FiodosAgent } from '@fiodos/vue';\nconst fyodosApiKey = import.meta.env.VITE_FYODOS_API_KEY;\nconst fyodosApiUrl = import.meta.env.VITE_FYODOS_API_URL;\n`,
    );
  }
  const block = [
    ORB_HTML_START,
    '  <FiodosAgent :api-key="fyodosApiKey" :base-url="fyodosApiUrl" />',
    ORB_HTML_END,
  ].join('\n');
  source = source.replace('</template>', `${block}\n</template>`);
  writeFile(target.file, source);
}

function injectSvelteSfc(plan) {
  const { target } = plan;
  let source = stripMarkedRegion(readFile(target.file), ORB_HTML_START, ORB_HTML_END);
  if (!/from ['"]@fyodos\/svelte/.test(source)) {
    source = source.replace(
      /(<script[^>]*>)/,
      `$1\n\timport FiodosAgent from '@fiodos/svelte/FiodosAgent.svelte';\n`,
    );
  }
  const block = [
    ORB_HTML_START,
    '<FiodosAgent apiKey={import.meta.env.VITE_FYODOS_API_KEY} baseUrl={import.meta.env.VITE_FYODOS_API_URL} />',
    ORB_HTML_END,
  ].join('\n');
  if (source.includes('</main>')) {
    source = source.replace('</main>', `</main>\n\n${block}`);
  } else {
    source = `${source.trimEnd()}\n\n${block}\n`;
  }
  writeFile(target.file, source);
}

function injectAngularComponent(plan) {
  const { target, templatePath } = plan;
  let ts = stripMarkedRegion(readFile(target.file), ORB_SCRIPT_START, ORB_SCRIPT_END);
  let html = stripMarkedRegion(readFile(templatePath), ORB_HTML_START, ORB_HTML_END);

  if (!/FiodosAgentComponent/.test(ts)) {
    ts = insertImportAfterLastImport(ts, `import { FiodosAgentComponent } from '@fiodos/angular/angular';`);
  }
  if (!/FiodosAgentComponent/.test(ts)) {
    ts = ts.replace(/imports:\s*\[/, 'imports: [FiodosAgentComponent, ');
  }
  const envPath = path.join(path.dirname(target.file), '../environments/environment.ts');
  const hasEnv = fs.existsSync(envPath);
  if (hasEnv && !/from ['"].*environment['"]/.test(ts)) {
    const relEnv = path.relative(path.dirname(target.file), envPath).replace(/\\/g, '/').replace(/\.ts$/, '');
    ts = insertImportAfterLastImport(ts, `import { environment } from '${relEnv.startsWith('.') ? relEnv : `./${relEnv}`}';`);
  }
  if (!/fyodosApiKey/.test(ts)) {
    ts = ts.replace(
      /export class (\w+) \{/,
      hasEnv
        ? `export class $1 {\n  readonly fyodosApiKey = environment.fyodosApiKey;\n  readonly fyodosApiUrl = environment.fyodosApiUrl;`
        : `export class $1 {\n  readonly fyodosApiKey = 'YOUR_FYODOS_API_KEY';`,
    );
  }

  const block = [ORB_HTML_START, '<fyodos-agent [apiKey]="fyodosApiKey" [baseUrl]="fyodosApiUrl" />', ORB_HTML_END].join('\n');
  html = `${html.trimEnd()}\n${block}\n`;
  writeFile(target.file, ts);
  writeFile(templatePath, html);
}

function applyMount(plan) {
  switch (plan.strategy) {
    case 'next-app':
      injectNextApp(plan);
      break;
    case 'vite-main':
      injectViteMain(plan);
      break;
    case 'react-return':
      injectReactReturn(plan);
      break;
    case 'vue-sfc':
      injectVueSfc(plan);
      break;
    case 'svelte-sfc':
      injectSvelteSfc(plan);
      break;
    case 'angular-component':
      injectAngularComponent(plan);
      break;
    default:
      throw new Error(`unknown strategy ${plan.strategy}`);
  }
}

function verifyMounted(plan) {
  for (const f of plan.files) {
    const src = readFile(f);
    if (!/FiodosAgent|fyodos-agent|FYODOS:ORB:START/.test(src)) return false;
  }
  return true;
}

function writeConsentDoc(appRoot, plan) {
  const dir = path.join(appRoot, 'src', 'fyodos');
  fs.mkdirSync(dir, { recursive: true });
  const doc = [
    '# Fiodos orb mount (auto-generated)',
    '',
    `Date: ${new Date().toISOString()}`,
    `Strategy: ${plan.strategy}`,
    `Files edited:`,
    ...plan.files.map((f) => `- ${path.relative(appRoot, f)}`),
    '',
    'Changes are wrapped in FYODOS:ORB:START / FYODOS:ORB:END markers.',
    'Remove those blocks (and the Fiodos import) to revert manually.',
    '',
    'Planned edits:',
    ...describePlan(plan).map((l) => `- ${l}`),
    '',
  ].join('\n');
  writeFile(path.join(dir, 'FYODOS_ORB_MOUNT.md'), doc);
}

module.exports = {
  ORB_HTML_START,
  ORB_HTML_END,
  ORB_JSX_START,
  ORB_JSX_END,
  agentJsx,
  envExpr,
  assessMount,
  describePlan,
  applyMount,
  verifyMounted,
  backupFiles,
  revertFiles,
  writeConsentDoc,
  isAlreadyMounted,
  IMPORT_NAME,
  WRAPPER_BASENAME,
};
