import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFiodosBackendClient } from '../src/api/backendClient';
import { isAgentApiError } from '../src/api/errors';
import type { AgentTurnRequest } from '@fiodos/core';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type FetchCall = { url: string; init: { headers: Record<string, string>; body: string } };

function mockFetch(
  handler: (url: string) => { status: number; body: unknown } | 'hang',
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    const url = String(input);
    const typedInit = init as { headers: Record<string, string>; body: string; signal?: AbortSignal };
    calls.push({ url, init: typedInit });
    const result = handler(url);
    if (result === 'hang') {
      return new Promise((_resolve, reject) => {
        typedInit.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
        );
      });
    }
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      statusText: String(result.status),
      json: async () => result.body,
      text: async () => JSON.stringify(result.body),
    };
  }) as typeof fetch;
  return calls;
}

const turnRequest: AgentTurnRequest = {
  message: 'open settings',
  language: 'en',
  manifestVersion: '1.0.0',
  manifestRoutes: [],
  manifestActions: [],
  appName: 'Demo Notes',
  appDescription: 'A note-taking app',
};

test('sendTurn posts the contract body and parses the response', async () => {
  const calls = mockFetch(() => ({
    status: 200,
    body: {
      reply: ' Done. ',
      audio_base64: 'abc',
      action: { type: 'navigate', intent: 'open_settings' },
      was_truncated: false,
    },
  }));
  const client = createFiodosBackendClient({
    baseUrl: 'https://api.example.com/',
    apiKey: 'k-123',
    getUserId: () => 'u-9',
  });
  const result = await client.sendTurn(turnRequest);

  assert.equal(calls[0]?.url, 'https://api.example.com/assistant/chat');
  const sent = JSON.parse(calls[0]!.init.body) as Record<string, unknown>;
  assert.equal(sent.message, 'open settings');
  assert.equal(sent.language, 'en');
  assert.equal(sent.app_name, 'Demo Notes');
  assert.equal(calls[0]?.init.headers['x-api-key'], 'k-123');
  assert.equal(calls[0]?.init.headers['x-user-id'], 'u-9');

  assert.equal(result.reply, 'Done.');
  assert.equal(result.audioBase64, 'abc');
  assert.equal(result.action?.type, 'navigate');
  assert.equal(result.action?.intent, 'open_settings');
  assert.equal(result.wasTruncated, false);
});

test('reportOrbSeen sends sdkVersion/sdkPackage so the dashboard can detect outdated orbs', async () => {
  const calls = mockFetch(() => ({ status: 200, body: { ok: true } }));
  const client = createFiodosBackendClient({ baseUrl: 'https://api.example.com', apiKey: 'k-123' });
  await client.reportOrbSeen('mobile');

  assert.equal(calls[0]?.url, 'https://api.example.com/v1/client/orb-seen');
  const sent = JSON.parse(calls[0]!.init.body) as Record<string, unknown>;
  assert.equal(sent.platform, 'mobile');
  assert.equal(sent.sdkPackage, '@fiodos/react-native');
  assert.equal(typeof sent.sdkVersion, 'string');
  assert.ok((sent.sdkVersion as string).length > 0);
});

test('HTTP statuses map to stable machine codes (no language matching)', async () => {
  const cases: Array<{ status: number; body: unknown; code: string }> = [
    { status: 401, body: {}, code: 'unauthorized' },
    { status: 403, body: {}, code: 'unauthorized' },
    { status: 429, body: { error: 'rate limit' }, code: 'rate_limited' },
    { status: 429, body: { error: 'Daily quota exceeded' }, code: 'quota_exceeded' },
    { status: 429, body: { remaining: 0 }, code: 'quota_exceeded' },
    // Plan/budget 429s carry error:"quota_exceeded" with a human detail that
    // does NOT contain the word "quota" — the machine field must win, or the
    // user sees a misleading "too many requests" for a budget problem.
    {
      status: 429,
      body: { detail: 'Daily AI usage safety limit reached for this project.', error: 'quota_exceeded' },
      code: 'quota_exceeded',
    },
    { status: 404, body: {}, code: 'not_found' },
    { status: 503, body: {}, code: 'server_error' },
  ];
  for (const c of cases) {
    mockFetch(() => ({ status: c.status, body: c.body }));
    const client = createFiodosBackendClient({ baseUrl: 'https://x.test' });
    await assert.rejects(
      client.sendTurn(turnRequest),
      (e: unknown) => isAgentApiError(e) && e.code === c.code,
      `status ${c.status} → ${c.code}`,
    );
  }
});

test('turn timeout surfaces as code "timeout" (never retried)', async () => {
  const calls = mockFetch(() => 'hang');
  const client = createFiodosBackendClient({ baseUrl: 'https://x.test', turnTimeoutMs: 30 });
  await assert.rejects(
    client.sendTurn(turnRequest),
    (e: unknown) => isAgentApiError(e) && e.code === 'timeout',
  );
  assert.equal(calls.length, 1);
});

test('caller abort surfaces as code "cancelled"', async () => {
  mockFetch(() => 'hang');
  const client = createFiodosBackendClient({ baseUrl: 'https://x.test' });
  const controller = new AbortController();
  const promise = client.sendTurn(turnRequest, { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, (e: unknown) => isAgentApiError(e) && e.code === 'cancelled');
});

test('network failures surface as code "network"', async () => {
  globalThis.fetch = (async () => {
    throw new Error('Network request failed');
  }) as typeof fetch;
  const client = createFiodosBackendClient({ baseUrl: 'https://x.test' });
  await assert.rejects(
    client.sendTurn(turnRequest),
    (e: unknown) => isAgentApiError(e) && e.code === 'network',
  );
});

test('previewTts returns audio or null, never throws', async () => {
  mockFetch(() => ({ status: 200, body: { audio_base64: 'mp3data' } }));
  const client = createFiodosBackendClient({ baseUrl: 'https://x.test' });
  assert.equal(await client.previewTts('voice-1', 'hello'), 'mp3data');

  mockFetch(() => ({ status: 500, body: {} }));
  assert.equal(await client.previewTts('voice-1', 'hello'), null);

  globalThis.fetch = (async () => {
    throw new Error('boom');
  }) as typeof fetch;
  assert.equal(await client.previewTts('voice-1', 'hello'), null);
});

test('optional fields are omitted from the body when absent', async () => {
  const calls = mockFetch(() => ({ status: 200, body: { reply: 'ok' } }));
  const client = createFiodosBackendClient({ baseUrl: 'https://x.test' });
  await client.sendTurn(turnRequest);
  const sent = JSON.parse(calls[0]!.init.body) as Record<string, unknown>;
  assert.ok(!('voice' in sent));
  assert.ok(!('screen_context' in sent));
  assert.ok(!('current_route' in sent));
  assert.ok(!('conversation_history' in sent));
  assert.ok(!('conversation_summary' in sent));
  assert.ok(!('x-user-id' in calls[0]!.init.headers));
});

test('sendTurn includes conversation memory when provided', async () => {
  const calls = mockFetch(() => ({ status: 200, body: { reply: 'ok' } }));
  const client = createFiodosBackendClient({ baseUrl: 'https://x.test' });
  await client.sendTurn({
    ...turnRequest,
    conversationHistory: [
      { role: 'user', content: 'quiero pizza' },
      { role: 'assistant', content: '¿De qué tipo?' },
    ],
    conversationSummary: 'Earlier: user greeted the assistant.',
  });
  const sent = JSON.parse(calls[0]!.init.body) as {
    conversation_history?: Array<{ role: string; content: string }>;
    conversation_summary?: string;
  };
  assert.equal(sent.conversation_history?.length, 2);
  assert.equal(sent.conversation_summary, 'Earlier: user greeted the assistant.');
});
