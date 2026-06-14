/**
 * HTTP client for the Fyodos backend — implements AgentBackendClient.
 *
 * Hardening preserved from production:
 * - Turn timeout 15 s (measured real range 3.4–10.8 s; 10 s gave false
 *   timeouts). The orchestrator's 20 s watchdog stays the final safety net.
 * - A voice turn is NEVER auto-retried: each attempt triggers another LLM+TTS
 *   generation the user is no longer waiting for. Retries only apply to
 *   idempotent helper calls (TTS preview).
 * - Aborts are never retried and are distinguishable from timeouts.
 */
import {
  manifestActionsForBackend,
  manifestRoutesForBackend,
  parseAgentAction,
  type AgentBackendClient,
  type AgentTurnRequest,
  type AgentTurnResult,
  type AppManifest,
  type ClientConfigResponse,
  type ConversationTurn,
} from '@fyodos/core';
import { AgentApiError } from './errors';

export interface FyodosBackendClientOptions {
  baseUrl: string;
  /** Client API key sent as x-api-key. */
  apiKey?: string;
  /** End-user id sent as x-user-id (rate limiting / telemetry correlation). */
  getUserId?: () => string | null;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  turnTimeoutMs?: number;
  ttsTimeoutMs?: number;
}

const DEFAULT_TURN_TIMEOUT_MS = 15_000;
const DEFAULT_TTS_TIMEOUT_MS = 12_000;

interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

async function fetchWithTimeout(
  url: string,
  init: FetchInit,
  timeoutMs: number,
  externalSignal?: { aborted: boolean; addEventListener(type: 'abort', cb: () => void): void },
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', () => controller.abort());
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (timedOut) throw new AgentApiError('timeout');
    if (externalSignal?.aborted) throw new AgentApiError('cancelled');
    const msg = e instanceof Error ? e.message : String(e);
    throw new AgentApiError('network', msg);
  } finally {
    clearTimeout(timer);
  }
}

async function errorFromResponse(res: Response): Promise<AgentApiError> {
  let body: { detail?: string; error?: string; message?: string; remaining?: number } = {};
  try {
    const text = await res.text();
    if (text) body = JSON.parse(text);
  } catch {
    /* unparseable body — classify by status alone */
  }
  const detail =
    typeof body.detail === 'string'
      ? body.detail
      : typeof body.error === 'string'
        ? body.error
        : body.message;

  if (res.status === 401 || res.status === 403) {
    return new AgentApiError('unauthorized', detail, res.status);
  }
  if (res.status === 429) {
    const quotaSignal =
      typeof body.remaining === 'number' || (detail ?? '').toLowerCase().includes('quota');
    return new AgentApiError(quotaSignal ? 'quota_exceeded' : 'rate_limited', detail, res.status);
  }
  if (res.status === 404) return new AgentApiError('not_found', detail, res.status);
  if (res.status >= 500) return new AgentApiError('server_error', detail, res.status);
  return new AgentApiError('unknown', detail ?? res.statusText, res.status);
}

export function createFyodosBackendClient(options: FyodosBackendClientOptions): AgentBackendClient {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const ttsTimeoutMs = options.ttsTimeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;

  function buildHeaders(): Record<string, string> {
    const userId = options.getUserId?.();
    return {
      'Content-Type': 'application/json',
      ...(options.apiKey ? { 'x-api-key': options.apiKey } : {}),
      ...(userId ? { 'x-user-id': userId } : {}),
      ...(options.headers ?? {}),
    };
  }

  return {
    async sendTurn(request: AgentTurnRequest, opts): Promise<AgentTurnResult> {
      const body: Record<string, unknown> = {
        message: request.message.trim(),
        language: request.language,
        manifest_version: request.manifestVersion,
        manifest_routes: request.manifestRoutes,
        manifest_actions: request.manifestActions,
        app_name: request.appName,
        app_description: request.appDescription,
      };
      if (request.voice) body.voice = request.voice;
      if (request.screenContext?.trim()) body.screen_context = request.screenContext.trim();
      if (request.currentRoute?.trim()) body.current_route = request.currentRoute.trim();
      if (request.conversationHistory?.length) {
        body.conversation_history = request.conversationHistory.map((t: ConversationTurn) => ({
          role: t.role,
          content: t.content.trim(),
        }));
      }
      if (request.conversationSummary?.trim()) {
        body.conversation_summary = request.conversationSummary.trim();
      }
      if (request.llmModel?.trim()) {
        body.llm_model = request.llmModel.trim();
      }
      if (request.sessionId?.trim()) {
        body.session_id = request.sessionId.trim();
      }

      const res = await fetchWithTimeout(
        `${baseUrl}/assistant/chat`,
        { method: 'POST', headers: buildHeaders(), body: JSON.stringify(body) },
        turnTimeoutMs,
        opts?.signal,
      );
      if (!res.ok) throw await errorFromResponse(res);

      let data: {
        reply?: string;
        audio_base64?: string | null;
        action?: unknown;
        was_truncated?: boolean;
      };
      try {
        data = (await res.json()) as typeof data;
      } catch {
        throw new AgentApiError('invalid_response');
      }
      return {
        reply: (data.reply ?? '').trim(),
        audioBase64: data.audio_base64 ?? null,
        action: parseAgentAction(data.action),
        wasTruncated: data.was_truncated === true,
      };
    },

    async previewTts(voice: string, text: string): Promise<string | null> {
      try {
        const res = await fetchWithTimeout(
          `${baseUrl}/assistant/preview-tts`,
          {
            method: 'POST',
            headers: buildHeaders(),
            body: JSON.stringify({ voice, text }),
          },
          ttsTimeoutMs,
        );
        if (!res.ok) return null;
        const data = (await res.json()) as { audio_base64?: string | null };
        return data.audio_base64?.length ? data.audio_base64 : null;
      } catch {
        return null;
      }
    },

    async warmUp(): Promise<void> {
      try {
        await fetchWithTimeout(
          `${baseUrl}/health`,
          { method: 'GET', headers: buildHeaders(), body: undefined as unknown as string },
          5_000,
        );
      } catch {
        /* best-effort cold-start warm-up */
      }
    },

    async fetchPublishedConfig(): Promise<ClientConfigResponse> {
      const res = await fetchWithTimeout(
        `${baseUrl}/v1/client/config`,
        { method: 'GET', headers: buildHeaders(), body: undefined as unknown as string },
        8_000,
      );
      if (!res.ok) throw await errorFromResponse(res);
      return (await res.json()) as ClientConfigResponse;
    },
  };
}

/** Serializes the manifest payloads for a turn request (helper for useAgent). */
export function buildManifestPayload(manifest: AppManifest) {
  return {
    manifestVersion: manifest.version,
    manifestRoutes: manifestRoutesForBackend(manifest),
    manifestActions: manifestActionsForBackend(manifest),
    appName: manifest.appName,
    appDescription: manifest.appDescription,
  };
}
