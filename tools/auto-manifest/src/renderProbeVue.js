/**
 * Vue real-effect render probe.
 *
 * Mounts the user's real .vue component in jsdom using the APP's own `vue`
 * runtime, compiling SFCs on the fly with `@vue/compiler-sfc` (the standard Vue
 * toolchain) via a tiny esbuild plugin. Then invokes the generated handler and
 * confirms the rendered UI mutates.
 *
 * NOTE on the test app's pre-existing build errors: we transpile with esbuild
 * (type-stripping only), so the app's pre-existing `vue-tsc` *type* errors do NOT
 * block rendering — the effect check is independent of that unrelated noise.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { decide, installDom, captureSnapshot, short, loadEsbuild, loadJsdom, reqFrom, emptyAssetsPlugin, captureConsole } = require('./renderProbe');

function vuePlugin(compilerSfc) {
  return {
    name: 'fyodos-vue-sfc',
    setup(build) {
      build.onLoad({ filter: /\.vue$/ }, (args) => {
        const src = fs.readFileSync(args.path, 'utf8');
        const id = crypto.createHash('md5').update(args.path).digest('hex').slice(0, 8);
        const { descriptor, errors } = compilerSfc.parse(src, { filename: args.path });
        if (errors && errors.length) {
          return { errors: [{ text: `SFC parse: ${errors[0].message || errors[0]}` }] };
        }
        try {
          if (descriptor.scriptSetup || descriptor.script) {
            const compiled = compilerSfc.compileScript(descriptor, { id, inlineTemplate: true });
            return { contents: compiled.content, loader: 'ts', resolveDir: path.dirname(args.path) };
          }
          // Template-only component.
          const tpl = compilerSfc.compileTemplate({ source: descriptor.template ? descriptor.template.content : '', id, filename: args.path });
          return { contents: `${tpl.code}\nexport default { render };\n`, loader: 'ts', resolveDir: path.dirname(args.path) };
        } catch (e) {
          return { errors: [{ text: `SFC compile: ${e && e.message}` }] };
        }
      });
    },
  };
}

async function probeVueEffect(appRoot, entry, ctx) {
  const esbuild = loadEsbuild(appRoot);
  const jsdomMod = loadJsdom();
  const compilerSfc = reqFrom(appRoot, '@vue/compiler-sfc');
  if (!esbuild || !jsdomMod || !compilerSfc) {
    const miss = !esbuild ? 'esbuild' : !jsdomMod ? 'jsdom' : '@vue/compiler-sfc';
    return { status: 'unverifiable', detail: `could not set up the Vue headless render (${miss} not available); wiring applied, real effect not automatically verifiable — test by hand` };
  }
  const fyodosDirAbs = path.join(appRoot, ctx.fyodosDirRel);
  const componentAbs = path.join(appRoot, entry.bridge.file);
  const entryRel = './' + path.relative(fyodosDirAbs, componentAbs).split(path.sep).join('/');
  const harnessAbs = path.join(fyodosDirAbs, '__fyodos_probe_entry.ts');
  const outAbs = path.join(os.tmpdir(), `fyodos-vue-probe-${Date.now()}.cjs`);
  const harness =
    `import { createApp, nextTick } from 'vue';\n` +
    `import Component from '${entryRel}';\n` +
    `import { fyodosGeneratedRegistries } from './handlers.generated';\n` +
    `export const probe = { createApp, nextTick, Component, registry: fyodosGeneratedRegistries };\n`;

  let restore = () => {};
  let cap = { restore() {} };
  try {
    fs.writeFileSync(harnessAbs, harness);
    await esbuild.build({
      entryPoints: [harnessAbs],
      outfile: outAbs,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      resolveExtensions: ['.vue', '.ts', '.mjs', '.js', '.jsx', '.tsx', '.json'],
      define: {
        'process.env.NODE_ENV': '"development"',
        __VUE_OPTIONS_API__: 'true',
        __VUE_PROD_DEVTOOLS__: 'false',
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
      },
      plugins: [emptyAssetsPlugin(), vuePlugin(compilerSfc)],
      logLevel: 'silent',
      absWorkingDir: fyodosDirAbs,
    });

    // Silence Vue/jsdom render noise from here through unmount.
    cap = captureConsole();
    restore = installDom(jsdomMod, { storageKeys: ctx.storageKeys, kind: ctx.kind });
    delete require.cache[outAbs];
    const mod = require(outAbs);
    const { createApp, nextTick, Component, registry } = mod.probe;
    if (!Component) return { status: 'unverifiable', detail: `'${entry.bridge.file}' does not export a mountable Vue component — real effect not verifiable, test by hand` };

    const container = document.createElement('div');
    document.body.appendChild(container);
    let app;
    try {
      app = createApp(Component);
      app.config && (app.config.warnHandler = () => {});
      app.mount(container);
      await nextTick();
    } catch (err) {
      try { app && app.unmount(); } catch {}
      return { status: 'unverifiable', detail: `the Vue component could not be mounted in isolation (${short(err)}); real effect not automatically verifiable — test by hand` };
    }

    const beforeHTML = captureSnapshot(container);
    const beforeText = container.textContent || '';
    const handler = registry.handlers[entry.handler];
    if (typeof handler !== 'function') { try { app.unmount(); } catch {} return { status: 'fail', detail: `the registry does not expose the handler '${entry.handler}'` }; }

    if (ctx.sensitive) {
      try { app.unmount(); } catch {}
      return { status: 'unverifiable', detail: 'confirmation action: its effect is not fired in the test render (security); wiring verified up to the confirmation point' };
    }

    let invokeErr = null;
    try { await handler(ctx.params); } catch (e) { invokeErr = e; }
    await nextTick();
    if (invokeErr) { try { app.unmount(); } catch {} return { status: 'fail', detail: `invoking the handler, the real app threw: ${short(invokeErr)}` }; }

    const afterHTML = captureSnapshot(container);
    const afterText = container.textContent || '';
    try { app.unmount(); } catch {}
    return decide(ctx.kind, { beforeHTML, beforeText, afterHTML, afterText });
  } catch (err) {
    return { status: 'unverifiable', detail: `could not prepare the Vue test render (${short(err)}); real effect not automatically verifiable — test by hand` };
  } finally {
    try { cap.restore(); } catch {}
    try { fs.existsSync(harnessAbs) && fs.rmSync(harnessAbs); } catch {}
    try { fs.existsSync(outAbs) && fs.rmSync(outAbs); } catch {}
    try { restore(); } catch {}
  }
}

module.exports = { probeVueEffect, vuePlugin };
