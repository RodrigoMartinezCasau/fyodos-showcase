/**
 * The AI-first analysis call: the model reads the app's SOURCE CODE directly
 * and proposes the full AppManifest, with mandatory per-item evidence.
 *
 * PRIVACY NOTE: this sends the collected source files to the AI provider
 * (Anthropic or OpenAI) using the DEVELOPER'S OWN key. It never touches the
 * Fiodos backend — only the resulting manifest is published, optionally, later.
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

/**
 * Per-platform analysis guide. Web/mobile (JS) keep their original wording;
 * native (Phase 1) reuses the SAME engine with language-specific hints so the
 * model knows where routes/actions live in Dart/Swift/Kotlin code.
 */
const PLATFORM_GUIDES = {
  web: {
    appKindLabel: 'a web app (React, Next.js, Vite, react-router, or similar)',
    screenWord: 'page/view/route',
    routeHintLine:
      'No reliable static route list is available for web apps, so infer routes/views from the router setup, page/route components, and navigation calls (react-router <Route>, Next.js pages, navigate()/<Link>). Routes you propose are NOT statically verified, so only include ones you can actually see in the code.',
    actionHintLine:
      'Actions are functions wired to UI: handlers inside components, store/context actions (Zustand, Redux, React Context), or service functions. Set "handler" to that real function name exactly.',
  },
  mobile: {
    appKindLabel: 'a mobile app (Expo / React Native)',
    screenWord: 'screen',
    routeHintLine: 'A statically-scanned route list is provided — prefer those hrefs verbatim.',
    actionHintLine:
      'Actions are functions wired to UI: handlers inside components, store/context actions (Zustand, Redux, React Context), or service functions. Set "handler" to that real function name exactly.',
  },
  flutter: {
    appKindLabel: 'a Flutter app (Dart; Widgets, Navigator/GoRouter/AutoRoute)',
    screenWord: 'screen',
    routeHintLine:
      'No static route list is available. Infer screens from the app\'s route table (named routes in MaterialApp.routes, GoRouter/AutoRoute config, onGenerateRoute) and the Widget classes that act as pages (e.g. *Screen/*Page extends StatefulWidget/StatelessWidget). The "route" string MUST be the named route or path the app router uses (e.g. "/cart"), or "BACK". Routes are NOT statically verified — only include ones you can see in the code.',
    actionHintLine:
      'Actions are Dart methods that mutate state or call services: methods on State<...> classes, ChangeNotifier/Provider, Bloc/Cubit handlers, Riverpod notifiers, or repository/service functions wired to onPressed/onTap. Set "handler" to the exact Dart method/function name as written.',
  },
  ios: {
    appKindLabel: 'a native iOS app (Swift / SwiftUI)',
    screenWord: 'screen/view',
    routeHintLine:
      'No static route list is available. Infer screens from SwiftUI navigation (NavigationStack/NavigationLink destinations, .sheet/.fullScreenCover, tab items) and the View structs that act as screens. The "route" string should be a stable identifier the app\'s navigation can map (e.g. a view name or path), or "BACK". Routes are NOT statically verified — only include ones you can see in the code.',
    actionHintLine:
      'Actions are Swift functions that mutate state or call services: methods on ObservableObject/@Observable view models, functions wired to Button(action:) / .onTapGesture, or service/repository functions. Set "handler" to the exact Swift function name as written.',
  },
  android: {
    appKindLabel: 'a native Android app (Kotlin / Jetpack Compose)',
    screenWord: 'screen',
    routeHintLine:
      'No static route list is available. Infer screens from Navigation Compose (NavHost composable destinations, navController.navigate("...") route strings) or Activities/Fragments. The "route" string MUST be the destination route used by the NavController (e.g. "cart"), or "BACK". Routes are NOT statically verified — only include ones you can see in the code.',
    actionHintLine:
      'Actions are Kotlin functions that mutate state or call services: ViewModel functions (exposed to composables and wired to onClick), use-cases, or repository/service functions. Set "handler" to the exact Kotlin function name as written.',
  },
};

function buildSystemPrompt(platform) {
  const guide = PLATFORM_GUIDES[platform] || PLATFORM_GUIDES.mobile;
  const { appKindLabel, screenWord, routeHintLine, actionHintLine } = guide;
  return `You analyze the FULL source code of ${appKindLabel} and produce the manifest of an in-app voice agent (Fiodos AppManifest).

ROUTES: every ${screenWord} the user can navigate to. ${routeHintLine} Skip auth screens (sign-in/sign-up) and dynamic [param] routes. Always include a BACK route ("route": "BACK").

ACTIONS: things a user could trigger by voice. ${actionHintLine} CRITICAL RULES:
- Every action MUST be backed by a REAL function you can see in the provided code. Set "handler" to that real function's name exactly as written in the code.
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

${wiringGuide(platform)}

If a list of omitted files is provided, declare in "uncertain" anything you could not check because of it.

Answer ONLY valid JSON (no markdown fences, no commentary). Start with { and end with }:
{
  "appKind": "<short app-type label, e.g. 'food delivery'>",
  "manifest": { ...AppManifest per the schema provided... },
  "evidence": {
    "routes": {"<intent>": {"file": "...", "symbol": "..."}},
    "actions": {"<intent>": {"file": "...", "symbol": "...", "whatItDoes": "..."}}
  },
  "wiring": {
    "<actionIntent>": {
      "strategy": "module" | "bridge",
      "imports": [{"kind": "named"|"default"|"namespace", "name": "<local name>", "from": "<repo-relative file path exactly as in a FILE header>"}],
      "call": "<MODULE strategy only: a single JS expression that performs the action; use params['<name>'] for manifest parameters; may use await>",
      "bridge": {
        "file": "<BRIDGE strategy only: the component file that owns the state>",
        "scope": "statement" | "class-field",
        "anchor": "<an EXACT, UNIQUE line of existing code in that file. The registration is inserted right AFTER it (or just BEFORE it if the line begins with 'return'), so it must be in the SAME scope where the action's function/state/injected instance is visible>",
        "invoke": "<a JS expression valid at the anchor that performs the action using args.<paramName> for parameters. Call the component's OWN functions or the REAL injected instance via this.<field> (e.g. addTodo(args.title) or this.todoService.updateTodos({ id: Date.now(), title: args.title, done: false })). NEVER instantiate a new service with new X() and NEVER call inject() here>",
        "imports": [{"kind": "named"|"default"|"namespace", "name": "<local name>", "from": "<repo-relative file>"}]
      },
      "requiredSymbols": [{"name": "<identifier that MUST exist>", "file": "<repo-relative file>"}],
      "bridgeReason": "<ONLY when strategy=bridge: why no module-reachable target exists>"
    }
  },
  "uncertain": ["<anything you were not sure about, honestly>"]
}`;
}

/**
 * Wiring guidance — the model not only DETECTS each action, it also says HOW to
 * call it from a STANDALONE generated module (the handler registry), reusing the
 * same code it just read. The mechanical verifier confirms every requiredSymbol
 * exists before any code is written, so the model proposes and the verifier
 * guards. Only the JS web ecosystems consume this today.
 */
function wiringGuide(platform) {
  if (!['web', 'mobile'].includes(platform)) {
    return 'Native wiring is generated separately; you do not need to return a "wiring" block for this platform.';
  }
  return `WIRING (how to actually RUN each action from a standalone generated module):
For EVERY action, also return a "wiring" entry describing how a separate module (the generated handler registry) can invoke the real behaviour, REUSING the code you just read. This is the key output: the user must not wire anything by hand.
- Prefer "strategy": "module" whenever the behaviour is reachable WITHOUT being inside a component instance:
  · an exported function/const (import it by name and call it),
  · a singleton store accessed outside React, e.g. Zustand: useStore.getState().doThing(params['x']),
  · an exported service/singleton object or class instance with a method,
  · a local-first data layer exported from a module (e.g. a Dexie \`db\`: await db.items.add({ ... })), or any repository/DAO module.
  Provide "imports" (exact repo-relative paths, same as the FILE headers; the generator rewrites them to relative paths) and a single "call" expression. Use params['name'] for every manifest parameter, by NAME, never by position. The expression may build objects/ids inline (crypto.randomUUID(), Date.now()).
- Use "strategy": "bridge" when the action can ONLY be performed through component-local state (React useState / Vue ref / Angular component field or an @Injectable service the component injects) with NO module-reachable store, service or data layer. Fiodos WILL edit the user's component (under explicit consent) to register a tiny bridge, so you MUST fill the "bridge" object precisely:
  · "file": the component that owns the state.
  · "scope": "statement" for function-style components (React function body, Vue <script setup>), or "class-field" for class components (Angular @Component classes) where a bare statement would be a syntax error.
  · "anchor": an exact, UNIQUE existing line to place the registration next to, in the SAME scope where the action's function / reactive state / injected instance is in scope. It must appear only ONCE in the file.
    – React: use the component's \`return (\` line (the registration is inserted just before it, so every function above is in scope).
    – Vue <script setup>: any unique line works; the registration is appended at the end of the script automatically.
    – Angular class: use scope "class-field" and anchor on an existing class FIELD line that comes AFTER the \`inject(...)\` field (so the injected instance is initialised first), e.g. \`public allTodos = this.todoSignalsService.todosState();\`.
  · "invoke": a JS expression performing the action using args.<paramName>, calling the component's OWN in-scope functions or the REAL injected instance via \`this.<field>\` (Angular). CRITICAL: never write \`new SomeService()\` and never call \`inject()\` — a fresh/uncontextualised instance is disconnected from the UI; use the instance the component already holds (this.<field>).
  · "bridge.imports": any imports the invoke needs that the file does not already have (e.g. a model class).
  Also set "bridgeReason" explaining why it is component-local.
- ANGULAR @Injectable services (providedIn:'root', etc.): there is NO module-level instance you can import, and \`inject()\` ONLY works inside an injection context — a generated module handler is NOT one, so \`inject(Svc)\` would throw at runtime. NEVER use "strategy":"module" with \`inject(...)\` for these. ALWAYS use "strategy":"bridge" anchored in a component that already does \`private foo = inject(Svc)\`, with "scope":"class-field" and "invoke" using \`this.foo.method(...)\`. Worked example for an action add_todo whose handler is updateTodos on a service the form component injects as \`this.todoSignalsService\`:
  { "strategy":"bridge", "bridgeReason":"updateTodos lives on an @Injectable singleton only reachable via this.todoSignalsService inside the component",
    "bridge": { "file":"src/app/.../todo-add-new-entry-form.component.ts", "scope":"class-field",
      "anchor":"public allTodos = this.todoSignalsService.todosState();",
      "invoke":"this.todoSignalsService.updateTodos({ id: Date.now(), title: args.title, description: args.description, done: false })" },
    "requiredSymbols":[{"name":"todoSignalsService","file":"src/app/.../todo-add-new-entry-form.component.ts"},{"name":"updateTodos","file":"src/app/services/todo-signals.service.ts"}] }
- "requiredSymbols": list every identifier your "call"/"invoke"/"imports" depend on together with the file it lives in. These are verified mechanically; if any is missing, that action is flagged for review rather than wired wrong.
- NEVER reference secrets, env vars, or network calls. Only app state/data operations.
- The confirmation flow is enforced by the engine BEFORE your handler runs, so never add your own confirmation logic; just perform the action.`;
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

/**
 * Focused, cheap re-prompt to FIX one action's wiring after it failed verification
 * (compile error, or it ran but produced no effect). Sends only the relevant
 * files + the concrete error, and asks for corrected wiring for that single
 * action, following the same schema/guide as the full analysis. This is the
 * "diagnose & correct" step of the install-time auto-correction loop.
 *
 * @returns {{ wiring: object|null, usage: object, costUSD: number }}
 */
async function correctActionWiring({
  action, intent, evidence = {}, relevantFiles = [], prevWiring = null,
  errorText = '', attempt = 1, model = DEFAULT_MODEL, platform = 'web',
}) {
  const resolved = resolveModel(model);
  const codeBlob = relevantFiles
    .map((f) => `===== FILE: ${f.rel} =====\n${f.content}`)
    .join('\n\n');
  const system =
    `You are fixing the WIRING of ONE Fiodos action that FAILED automatic verification during install. ` +
    `Re-read the relevant code and the concrete error, diagnose the ROOT CAUSE, and return CORRECTED wiring for this single action.\n\n` +
    `${wiringGuide(platform)}\n\n` +
    `Common root causes & fixes:\n` +
    `- Angular @Injectable service: NEVER strategy:module with inject(...) (throws outside an injection context). Use strategy:bridge, scope:class-field, anchored in a component that already does \`private x = inject(Svc)\`, invoke via this.x.method(...).\n` +
    `- A TypeScript compile error means a type/shape mismatch: pass the exact object shape the real function expects (read its signature), or cast minimally.\n` +
    `- "executed but no observable effect": you wired a getter/no-op or a detached copy; wire the function that actually mutates the shared state.\n` +
    `- Unverified symbol/import: only reference names that exist in the files shown.\n\n` +
    `Answer ONLY valid JSON: {"wiring": {"${intent}": { ...one wiring entry per the schema... }}}`;
  const user =
    `ACTION (manifest):\n${JSON.stringify(action, null, 1)}\n\n` +
    `EVIDENCE: ${JSON.stringify(evidence[intent] || {}, null, 1)}\n\n` +
    `YOUR PREVIOUS WIRING ATTEMPT (attempt ${attempt}) that FAILED:\n${JSON.stringify(prevWiring, null, 1)}\n\n` +
    `VERIFICATION ERROR:\n${String(errorText).slice(0, 3000)}\n\n` +
    `RELEVANT CODE:\n\n${codeBlob}`;

  const { parsed, usage } = isAnthropicModel(resolved)
    ? await completeAnthropic({ model: resolved, system, user })
    : await completeOpenAI({ model: resolved, system, user });
  const price = PRICES[resolved] || { input: 0, output: 0 };
  const costUSD =
    ((usage.prompt_tokens || 0) / 1e6) * price.input +
    ((usage.completion_tokens || 0) / 1e6) * price.output;
  // Be tolerant of the shape the model returns: {wiring:{intent:{...}}}, or
  // {intent:{...}}, or a bare single wiring entry {strategy/bridge/imports/call}.
  let wiring = (parsed && parsed.wiring) || null;
  if (!wiring && parsed && typeof parsed === 'object') {
    if (parsed[intent]) wiring = { [intent]: parsed[intent] };
    else if (parsed.strategy || parsed.bridge || parsed.imports || parsed.call) wiring = { [intent]: parsed };
  }
  return { wiring, usage, costUSD };
}

module.exports = { analyzeWithAI, correctActionWiring, DEFAULT_MODEL, PRICES, resolveModel, isAnthropicModel };
