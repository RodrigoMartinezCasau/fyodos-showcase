/**
 * The AI-first analysis call: the model reads the app's SOURCE CODE directly
 * and proposes the full AppManifest, with mandatory per-item evidence.
 *
 * PRIVACY NOTE: this sends the collected source files to the AI provider
 * (Anthropic or OpenAI) using the DEVELOPER'S OWN key. It never touches the
 * Fyodos backend — only the resulting manifest is published, optionally, later.
 */
'use strict';

// USD per 1M tokens (list prices, June 2026).
const PRICES = {
  'claude-opus-4-8': { input: 15.0, output: 75.0 },
  'claude-opus-4-20250514': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'gpt-5': { input: 1.25, output: 10.0 },
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

// Fallback only. The real model is chosen by the backend per plan (tier-based
// cost control) and sent to the CLI; this is used when there is no backend
// answer (e.g. --no-publish local runs or an operator override via --model).
const DEFAULT_MODEL = 'claude-opus-4-8';

const MODEL_ALIASES = {
  opus: 'claude-opus-4-8',
  'claude-opus': 'claude-opus-4-8',
  'claude-opus-4-20250514': 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  'claude-sonnet': 'claude-sonnet-4-6',
  'claude-sonnet-4-20250514': 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
  'claude-haiku': 'claude-haiku-4-5',
};

function resolveModel(model) {
  const raw = (model || DEFAULT_MODEL).trim();
  return MODEL_ALIASES[raw] || raw;
}

function isAnthropicModel(model) {
  return resolveModel(model).startsWith('claude');
}

function manifestSchemaDoc() {
  return `
AppManifest (all fields required unless noted):
{
  "appId": string, "appName": string, "appDescription": string, "version": string,
  "appType": string (short app-type label, e.g. "food delivery", "habit tracker"),
  "appFlow": string (1-2 sentences describing the MAIN user flow, e.g. "Users browse restaurants, add dishes to a cart, then check out."),
  "routes": [{
    "intent": string (snake_case, UNIQUE across routes AND actions),
    "label": string, "route": string (opaque route string for the app's navigation adapter — an expo-router href, a URL path, or "BACK"),
    "description": string (one line: WHAT THIS SCREEN SHOWS and what the user can do there),
    "examples": string[] (3-4 natural voice phrases, REQUIRED non-empty)
  }],
  "actions": [{
    "intent": string (snake_case, UNIQUE across routes AND actions),
    "label": string, "category": string,
    "handler": string (name of the REAL function in the app code that implements it),
    "description": string (what the action does, in clear plain language),
    "preconditions": string (what must be true to run it, in words — e.g. "the cart must have at least one item"; empty string if none),
    "effect": string (what happens AFTER it runs — the result/outcome the user perceives),
    "relatedIntents": string[] (intents that commonly follow or pair with this one — flows; [] if none),
    "requireConfirmation": boolean,
    "confirmationMessageTemplate": string (REQUIRED if requireConfirmation true),
    "parameters": { "<name>": {"type": "string"|"number"|"boolean", "required": boolean, "description": string (non-empty)} },
    "contextRequirements": {"requiresVisibleContent"?: bool, "requiresAuth"?: bool} (optional),
    "examples": string[] (3-4 natural voice phrases, REQUIRED non-empty)
  }],
  "policies": {"requireConfirmationForDestructive": true, "allowedWithoutAuth": string[], "contextRetentionTurns": 5}
}
Validation rules: no duplicate intents anywhere; every route/action needs non-empty examples;
actions need non-empty handler; requireConfirmation implies confirmationMessageTemplate.
The description/preconditions/effect/relatedIntents (actions), description (routes) and appType/appFlow
fields are the app's "manual": they go verbatim into the agent's prompt so it understands the app.
Base them on the REAL code you read; be precise and concise, never padding.`;
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

THE MANUAL (description/preconditions/effect/relatedIntents per action; description per screen; appType/appFlow):
This is the context the agent reads to understand the app, so it can reason instead of guessing. Derive every field from the REAL code:
- description: what the action actually does (read the handler's body).
- preconditions: state the code requires before it has an effect (e.g. a non-empty cart, an active order, a signed-in user). Empty string if none.
- effect: the observable outcome after it runs (state change, navigation, message).
- relatedIntents: other manifest intents this naturally flows into or from (e.g. add-to-cart → checkout). Use the exact intent ids; [] if none.
- route description: what the screen displays and what can be done there.
- appType/appFlow: the app category and its main end-to-end flow.
Be precise and concise — quality over volume. Never pad.

Also return EVIDENCE for every route and action: the file (exact relative path as given in the FILE headers) and symbol (function/property name) in the provided code that justifies it. Evidence is verified mechanically afterwards: an action whose file or symbol does not exist is dropped, and unverifiable items count against you.

If a list of omitted files is provided, declare in "uncertain" anything you could not check because of it.

Answer ONLY valid JSON (no markdown fences, no commentary). Start with { and end with }:
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

function buildUserPrompt(appMeta, files, omitted, staticRoutes) {
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

  return (
    `App: ${appMeta.name}\nDescription: ${appMeta.description || '(none)'}\n` +
    `App id / bundle id (if any): ${appMeta.bundleId || '(none)'}\nDependencies: ${(appMeta.dependencies || []).join(', ')}\n\n` +
    routeBlock +
    omittedNote +
    `\nManifest schema:\n${manifestSchemaDoc()}\n\n` +
    `FULL SOURCE CODE (${files.length} files):\n\n${codeBlob}`
  );
}

function parseJsonContent(raw) {
  let trimmed = (raw || '').trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Model response is not JSON');
  return JSON.parse(trimmed.slice(start, end + 1));
}

async function completeAnthropic({ model, system, user }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required (auto-loaded from backend/.env or your shell)');
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 30000,
      system: `${system}\n\nRespond with raw JSON only. No markdown code fences. No text before or after the JSON object.`,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  const textPart = (data.content || []).find((b) => b.type === 'text');
  const raw = textPart?.text || '';
  const usage = {
    prompt_tokens: data.usage?.input_tokens || 0,
    completion_tokens: data.usage?.output_tokens || 0,
  };
  return { parsed: parseJsonContent(raw), usage };
}

async function completeOpenAI({ model, system, user }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required (auto-loaded from backend/.env or your shell)');
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
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
  const usage = data.usage || {};
  return { parsed: parseJsonContent(data.choices?.[0]?.message?.content || '{}'), usage };
}

/**
 * @returns {{ parsed: object, usage: object, costUSD: number, elapsedMs: number, model: string }}
 */
async function analyzeWithAI({ appMeta, files, omitted, staticRoutes, model = DEFAULT_MODEL, platform = 'mobile' }) {
  const resolved = resolveModel(model);
  const system = buildSystemPrompt(platform);
  const user = buildUserPrompt(appMeta, files, omitted, staticRoutes);

  const t0 = Date.now();
  const { parsed, usage } = isAnthropicModel(resolved)
    ? await completeAnthropic({ model: resolved, system, user })
    : await completeOpenAI({ model: resolved, system, user });
  const elapsedMs = Date.now() - t0;

  const price = PRICES[resolved] || { input: 0, output: 0 };
  const costUSD =
    ((usage.prompt_tokens || 0) / 1e6) * price.input +
    ((usage.completion_tokens || 0) / 1e6) * price.output;

  return { parsed, usage, costUSD, elapsedMs, model: resolved, promptChars: user.length };
}

module.exports = { analyzeWithAI, DEFAULT_MODEL, PRICES, resolveModel, isAnthropicModel };
