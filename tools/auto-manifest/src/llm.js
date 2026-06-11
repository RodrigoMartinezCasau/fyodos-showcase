/**
 * Layer 3 — EXPLICIT LLM calls inside the pipeline.
 *
 * The static layers (1+2) extract facts; this layer makes judgment calls the
 * code cannot express, and every call is LOGGED so the final report can show
 * exactly which decisions came from the model vs from static analysis:
 *
 *   1. classifyApp        — app type vs the pattern catalog
 *   2. curateActions      — which detected callables deserve agent exposure,
 *                           category, sensitivity, parameters, label
 *   3. writeRouteMeta     — intent ids, labels and example phrases for routes
 *   4. patternGapFill     — given the matched pattern, propose what's missing
 *
 * Model: gpt-4o-mini via the OpenAI REST API (OPENAI_API_KEY env var).
 */
'use strict';

const LLM_LOG = [];

function getLog() {
  return LLM_LOG;
}

async function callLLM(taskName, system, user, { maxTokens = 2000 } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for the LLM layer');

  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.AUTO_MANIFEST_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM call '${taskName}' failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`LLM call '${taskName}' returned non-JSON output`);
  }
  LLM_LOG.push({
    task: taskName,
    ms: Date.now() - t0,
    promptChars: system.length + user.length,
    usage: data.usage || null,
  });
  return parsed;
}

/** 1. Classify the app against the available pattern catalog. */
async function classifyApp(appSummary, patternSummaries) {
  const system =
    'You classify a mobile app into one of the available integration patterns, or "none". ' +
    'Answer JSON: {"pattern": "<id-or-none>", "confidence": 0..1, "appKind": "<free text>", "reason": "<short>"}';
  const user =
    `Available patterns:\n${patternSummaries.map((p) => `- id=${p.id}: ${p.summary}`).join('\n')}\n\n` +
    `App evidence (from static analysis):\n${JSON.stringify(appSummary, null, 1).slice(0, 4000)}`;
  return callLLM('classifyApp', system, user, { maxTokens: 300 });
}

/**
 * 2. Curate detected callables into agent actions.
 * Batched: large candidate lists are processed in chunks so no candidate is
 * silently dropped by prompt-size truncation.
 */
async function curateActions(appKind, candidates) {
  const BATCH = 14;
  const all = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    const chunk = candidates.slice(i, i + BATCH);
    const res = await curateActionsBatch(appKind, chunk);
    all.push(...(res.actions || []));
  }
  return { actions: all };
}

async function curateActionsBatch(appKind, candidates) {
  const system =
    'You design the action surface of an in-app voice agent. Input: callables detected by static ' +
    'analysis of a mobile app (handlers, store actions, buttons, alerts). For EACH candidate decide:\n' +
    '- expose: should the voice agent be able to trigger it? (skip pure-UI plumbing like toggling pickers, ' +
    'rendering callbacks, backdrop handlers, text-input onChange)\n' +
    '- intent: snake_case id; label: short human label (English); category: one of discovery|workout|history|account|navigation|other\n' +
    '- requireConfirmation: true only for destructive/sensitive operations (deleting data, losing progress, signing out, spending money)\n' +
    '- confirmationMessage: required question if requireConfirmation\n' +
    '- parameters: object of {name:{type,required,description}} ONLY when the user must provide a value by voice (e.g. a search query)\n' +
    '- requiresVisibleContent: true when the action operates on an item the user is looking at\n' +
    '- examples: 3-4 natural English voice phrases\n' +
    '- evidence_used: which input evidence justified your decision\n' +
    'Be conservative: when a candidate looks like internal plumbing, expose=false. ' +
    'Sign-in/sign-up/verification flows requiring typed credentials should be expose=false ' +
    '(a voice agent cannot dictate passwords safely).\n' +
    'Return a decision for EVERY candidate. "intent" MUST be a plain string.\n' +
    'Answer JSON: {"actions": [{...candidate fields above, "source_name": "<input name>"}]}';
  const user =
    `App kind: ${appKind}\n\nCandidates (with static evidence):\n` +
    JSON.stringify(candidates, null, 1).slice(0, 14000);
  return callLLM('curateActions', system, user, { maxTokens: 4000 });
}

/** 3. Route intents, labels, examples. */
async function writeRouteMeta(appKind, routes) {
  const system =
    'You name navigation intents for an in-app voice agent. For each route give: ' +
    'intent (snake_case), label (short English), examples (3-4 natural English voice phrases). ' +
    'Skip auth screens the agent should not navigate to mid-session if any seem like sign-in/sign-up (mark skip=true). ' +
    'For dynamic routes ([param]) mark dynamic=true and skip=true (they need a runtime parameter the static manifest cannot provide). ' +
    'Answer JSON: {"routes": [{"routePath": "...", "intent": "...", "label": "...", "examples": [...], "skip": false, "skipReason": ""}]}';
  const user = `App kind: ${appKind}\n\nRoutes:\n${JSON.stringify(routes, null, 1)}`;
  return callLLM('writeRouteMeta', system, user, { maxTokens: 2500 });
}

/** 4. Pattern gap-fill: what does the matched pattern expect that we missed? */
async function patternGapFill(patternId, patternText, draftManifestSummary) {
  const system =
    'You compare a draft voice-agent manifest against an integration pattern document. ' +
    'List actions/routes the pattern suggests SHOULD usually exist for this app type but are missing or ' +
    'under-specified in the draft. Only suggest things genuinely implied by the pattern; do not invent. ' +
    'Answer JSON: {"suggestions": [{"kind": "action"|"route", "intent": "...", "label": "...", "why": "...", ' +
    '"confidence": 0..1}], "patternUseful": true|false, "notes": "<honest assessment of how much this pattern helped>"}';
  const user =
    `Pattern (${patternId}):\n${patternText.slice(0, 5000)}\n\nDraft manifest summary:\n` +
    JSON.stringify(draftManifestSummary, null, 1).slice(0, 5000);
  return callLLM('patternGapFill', system, user, { maxTokens: 1200 });
}

module.exports = { classifyApp, curateActions, writeRouteMeta, patternGapFill, getLog };
