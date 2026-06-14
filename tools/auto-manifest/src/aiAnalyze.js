/**
 * The AI-first analysis call: the model reads the app's SOURCE CODE directly
 * and proposes the full AppManifest, with mandatory per-item evidence.
 *
 * Ported from experiments/ai-only/run.js (the control experiment that
 * produced zero hallucinated actions), hardened for production:
 *   - static route scan passed as a hint (existence is cheap to know)
 *   - omitted-file list passed so the model declares blind spots
 *   - evidence contract: every action must name a real file + symbol
 *
 * PRIVACY NOTE: this sends the collected source files to the AI provider
 * (OpenAI API) using the DEVELOPER'S OWN key. It never touches the Fyodos
 * backend — only the resulting manifest is published, optionally, later.
 */
'use strict';

// USD per 1M tokens (OpenAI list prices, June 2026).
const PRICES = {
  'gpt-5': { input: 1.25, output: 10.0 },
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

const DEFAULT_MODEL = 'gpt-5';

function manifestSchemaDoc() {
  // Condensed from packages/core/src/manifest/types.ts + validate.ts.
  return `
AppManifest (all fields required unless noted):
{
  "appId": string, "appName": string, "appDescription": string, "version": string,
  "routes": [{
    "intent": string (snake_case, UNIQUE across routes AND actions),
    "label": string, "route": string (opaque route string for the app's navigation adapter — an expo-router href, a URL path, or "BACK"),
    "examples": string[] (3-4 natural voice phrases, REQUIRED non-empty)
  }],
  "actions": [{
    "intent": string (snake_case, UNIQUE across routes AND actions),
    "label": string, "category": string,
    "handler": string (name of the REAL function in the app code that implements it),
    "requireConfirmation": boolean,
    "confirmationMessageTemplate": string (REQUIRED if requireConfirmation true),
    "parameters": { "<name>": {"type": "string"|"number"|"boolean", "required": boolean, "description": string (non-empty)} },
    "contextRequirements": {"requiresVisibleContent"?: bool, "requiresAuth"?: bool} (optional),
    "examples": string[] (3-4 natural voice phrases, REQUIRED non-empty)
  }],
  "policies": {"requireConfirmationForDestructive": true, "allowedWithoutAuth": string[], "contextRetentionTurns": 5}
}
Validation rules: no duplicate intents anywhere; every route/action needs non-empty examples;
actions need non-empty handler; requireConfirmation implies confirmationMessageTemplate.`;
}

function buildSystemPrompt(platform) {
  const isWeb = platform === 'web';
  const appKindLabel = isWeb
    ? 'a web app (React, Next.js, Vite, react-router, or similar)'
    : 'a mobile app (Expo / React Native)';
  const screenWord = isWeb ? 'page/view/route' : 'screen';
  const routeHintLine = isWeb
    ? 'No reliable static route list is available for web apps, so infer routes/views from the router setup, page/route components, and navigation calls (react-router <Route>, Next.js pages, navigate()/<Link>). Routes you propose are NOT statically verified, so only include ones you can actually see in the code.'
    : 'A statically-scanned route list is provided — prefer those hrefs verbatim.';
  return `You analyze the FULL source code of ${appKindLabel} and produce the manifest of an in-app voice agent (Fyodos AppManifest).

ROUTES: every ${screenWord} the user can navigate to. ${routeHintLine} Skip auth screens (sign-in/sign-up) and dynamic [param] routes. Always include a BACK route ("route": "BACK").

ACTIONS: things a user could trigger by voice. CRITICAL RULES:
- Every action MUST be backed by a REAL function you can see in the provided code (a handler inside a component, a store/context action, a service function wired to UI). Set "handler" to that real function's name exactly as written in the code.
- DO NOT invent actions that "apps like this usually have". If you cannot point to the code, leave it out. A hallucinated action is worse than a missed one: it fails in production in front of the user.
- State can live anywhere: Zustand stores, React Context providers (look for createContext / useReducer / useState exposed via provider value), service modules. Read them all.
- Skip pure UI plumbing (toggling pickers, onChange of inputs, sheet open/close) and credential entry (passwords cannot be dictated).
- Destructive/sensitive operations (delete data, logout, place/cancel orders, spend money) need requireConfirmation + confirmationMessageTemplate.
- "parameters" only when the user must supply a value by voice.

Also return EVIDENCE for every route and action: the file (exact relative path as given in the FILE headers) and symbol (function/property name) in the provided code that justifies it. Evidence is verified mechanically afterwards: an action whose file or symbol does not exist is dropped, and unverifiable items count against you.

If a list of omitted files is provided, declare in "uncertain" anything you could not check because of it.

Answer ONLY JSON:
{
  "appKind": "<short app-type label, e.g. 'food delivery'>",
  "manifest": { ...AppManifest per the schema provided... },
  "evidence": {
    "routes": {"<intent>": {"file": "...", "symbol": "..."}},
    "actions": {"<intent>": {"file": "...", "symbol": "...", "whatItDoes": "..."}}
  },
  "uncertain": ["<anything you were not sure about, honestly>"]
}`;
}

/**
 * @returns {{ parsed: object, usage: object, costUSD: number, elapsedMs: number, model: string }}
 */
async function analyzeWithAI({ appMeta, files, omitted, staticRoutes, model = DEFAULT_MODEL, platform = 'mobile' }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required (auto-loaded from backend/.env or your shell)');

  const codeBlob = files.map((f) => `===== FILE: ${f.rel} =====\n${f.content}`).join('\n\n');
  const routeHint = staticRoutes
    .map((r) => `${r.routePath}${r.isDynamic ? ' (dynamic)' : ''} ← ${r.relFile}`)
    .join('\n');
  const omittedNote = omitted.length
    ? `\nFILES OMITTED FOR SIZE (declare blind spots in "uncertain"):\n${omitted.map((o) => o.rel).join('\n')}\n`
    : '';
  const routeBlock = staticRoutes.length
    ? `Statically-scanned routes (existence is verified — use these hrefs):\n${routeHint}\n`
    : `No static route list (web app): infer routes/views from the router and navigation calls in the code below.\n`;

  const user =
    `App: ${appMeta.name}\nDescription: ${appMeta.description || '(none)'}\n` +
    `App id / bundle id (if any): ${appMeta.bundleId || '(none)'}\nDependencies: ${(appMeta.dependencies || []).join(', ')}\n\n` +
    routeBlock +
    omittedNote +
    `\nManifest schema:\n${manifestSchemaDoc()}\n\n` +
    `FULL SOURCE CODE (${files.length} files):\n\n${codeBlob}`;

  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: buildSystemPrompt(platform) },
        { role: 'user', content: user },
      ],
      ...(model.startsWith('gpt-5')
        ? { max_completion_tokens: 30000 }
        : { max_tokens: 8000, temperature: 0.2 }),
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  const elapsedMs = Date.now() - t0;

  const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  const usage = data.usage || {};
  const price = PRICES[model] || { input: 0, output: 0 };
  const costUSD =
    ((usage.prompt_tokens || 0) / 1e6) * price.input +
    ((usage.completion_tokens || 0) / 1e6) * price.output;

  return { parsed, usage, costUSD, elapsedMs, model, promptChars: user.length };
}

module.exports = { analyzeWithAI, DEFAULT_MODEL, PRICES };
