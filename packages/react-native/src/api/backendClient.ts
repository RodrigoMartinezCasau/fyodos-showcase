/**
 * HTTP client for the Fiodos backend — implements AgentBackendClient.
 *
 * Hardening preserved from production:
 * - Turn timeout 45 s, matching the backend's own LLM budget plus in-band TTS
 *   (15 s still cut off slow turns and reported them as a network fault).
 *   The orchestrator's 60 s watchdog stays the final safety net behind it.
 * - A voice turn is NEVER auto-retried: each attempt triggers another LLM+TTS
 *   generation the user is no longer waiting for. Retries only apply to
 *   idempotent helper calls (TTS preview).
 * - Aborts are never retried and are distinguishable from timeouts.
 */
import {
  manifestActionsForBackend,
  manifestRoutesForBackend,
  withExecutableActions,
  type ActionRegistries,
  parseAgentAction,
  type AgentBackendClient,
  type AgentTurnRequest,
  type AgentTurnResult,
  type AppManifest,
  type ClientConfigResponse,
  type ConversationTurn,
} from '@fiodos/core';
import { AgentApiError } from './errors';
import { SDK_VERSION, SDK_PACKAGE } from '../version';

export interface FiodosBackendClientOptions {
  baseUrl: string;
  /** Client API key sent as x-api-key. */
  apiKey?: string;
  /** End-user id sent as x-user-id (rate limiting / telemetry correlation). */
  getUserId?: () => string | null;
  /**
   * Signed-in session token, sent as `Authorization: Bearer …`.
   *
   * Optional and off by default, so a public orb or a key-embedded install is
   * byte-for-byte unchanged. An app whose users are EMPLOYEES must provide it:
   * a company orb reaches the company's connected services only for a proven
   * member, because the project API key ships inside the app and proves nothing
   * about who is holding it.
   *
   * A function, not a string, because the token is re-minted on every
   * `/v1/auth/me` and a value captured at mount time would go stale.
   */
  getAuthToken?: () => string | null | undefined;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  turnTimeoutMs?: number;
  ttsTimeoutMs?: number;
}

/**
 * Per-turn HTTP budget. MUST NOT be shorter than the backend's own LLM budget
 * (backend/llm.py `_REQUEST_TIMEOUT_SECONDS = 45`) plus in-band TTS: a tighter
 * cap aborts turns the server is still working on and blames the network.
 */
export const DEFAULT_TURN_TIMEOUT_MS = 45_000;
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
    // The backend marks plan/budget 429s with error:"quota_exceeded" (rate
    // limits carry error:"rate_limited"); the detail/remaining checks cover
    // older backends. Getting this right matters: a quota 429 shown as "too
    // many requests" sends the developer chasing rate limits that are fine.
    const quotaSignal =
      body.error === 'quota_exceeded' ||
      typeof body.remaining === 'number' ||
      (detail ?? '').toLowerCase().includes('quota');
    return new AgentApiError(quotaSignal ? 'quota_exceeded' : 'rate_limited', detail, res.status);
  }
  if (res.status === 404) return new AgentApiError('not_found', detail, res.status);
  if (res.status >= 500) return new AgentApiError('server_error', detail, res.status);
  return new AgentApiError('unknown', detail ?? res.statusText, res.status);
}

export function createFiodosBackendClient(options: FiodosBackendClientOptions): AgentBackendClient {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const ttsTimeoutMs = options.ttsTimeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;

  function buildHeaders(): Record<string, string> {
    const userId = options.getUserId?.();
    const authToken = options.getAuthToken?.();
    return {
      'Content-Type': 'application/json',
      ...(options.apiKey ? { 'x-api-key': options.apiKey } : {}),
      ...(userId ? { 'x-user-id': userId } : {}),
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
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
      if (request.appType?.trim()) body.app_type = request.appType.trim();
      if (request.appFlow?.trim()) body.app_flow = request.appFlow.trim();
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
      // Device capability flags (retrocompatible: old backends ignore them).
      if (request.platformCapabilities?.credentialAutofill) {
        body.platform_capabilities = { credential_autofill: true };
      }
      // Live session verdict for audience filtering (retrocompatible: absent
      // when the host wired no session source; old backends ignore it).
      if (request.sessionContext) {
        body.session_context = {
          authenticated: request.sessionContext.authenticated,
          ...(request.sessionContext.capabilities
            ? { capabilities: request.sessionContext.capabilities }
            : {}),
        };
      }
      // Autonomous chaining (opt-in). Older backends ignore these; older SDKs
      // never set them (retrocompatible).
      if (request.isContinuation) {
        body.is_continuation = true;
        if (typeof request.chainStep === 'number') body.chain_step = request.chainStep;
        if (request.lastStep) {
          body.last_step = {
            type: request.lastStep.type,
            intent: request.lastStep.intent,
            ...(request.lastStep.label ? { label: request.lastStep.label } : {}),
            success: request.lastStep.success,
            // Technical error of a FAILED step: the backend renders it in the
            // RECOVERY block so the model can diagnose and change path.
            ...(request.lastStep.error ? { error: request.lastStep.error } : {}),
            // Bounded result payload of the executed step (product search
            // results…): the backend renders it so the model can read real
            // ids for the NEXT step's parameters.
            ...(request.lastStep.data ? { data: request.lastStep.data } : {}),
          };
        }
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
        task_status?: unknown;
      };
      try {
        data = (await res.json()) as typeof data;
      } catch {
        throw new AgentApiError('invalid_response');
      }
      const taskStatus =
        data.task_status === 'in_progress' || data.task_status === 'blocked'
          ? data.task_status
          : 'complete';
      return {
        reply: (data.reply ?? '').trim(),
        audioBase64: data.audio_base64 ?? null,
        action: parseAgentAction(data.action),
        wasTruncated: data.was_truncated === true,
        taskStatus,
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

    async contactFiodos(message: string): Promise<{ id: string }> {
      const res = await fetchWithTimeout(
        `${baseUrl}/v1/client/contact-fiodos`,
        {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify({ message: message.trim() }),
        },
        12_000,
      );
      if (!res.ok) throw await errorFromResponse(res);
      const data = (await res.json()) as { id?: string };
      if (!data.id) throw new AgentApiError('invalid_response');
      return { id: data.id };
    },

    async reportOrbSeen(platform = 'mobile'): Promise<void> {
      // Best-effort: prove the orb booted in the running app so the dashboard
      // onboarding can confirm a real install. Never throws / never blocks.
      // sdkVersion/sdkPackage let the dashboard surface an "update available"
      // notice when the running orb is older than the latest published SDK
      // (mirrors @fiodos/react and @fiodos/web-core).
      try {
        await fetchWithTimeout(
          `${baseUrl}/v1/client/orb-seen`,
          {
            method: 'POST',
            headers: buildHeaders(),
            body: JSON.stringify({ platform, sdkVersion: SDK_VERSION, sdkPackage: SDK_PACKAGE }),
          },
          5_000,
        );
      } catch {
        /* heartbeat is best-effort; never block the orb on it */
      }
    },
  };
}

/**
 * Serializes the manifest payloads for a turn request (helper for useAgent).
 *
 * When the live registries are provided, actions with no registered handler
 * are dropped from the payload (runtime "wired or nonexistent"): the LLM never
 * hears about an action this mounted app cannot execute, so it can never
 * promise it. Fail-open without registries.
 */
export function buildManifestPayload(manifest: AppManifest, registries?: ActionRegistries | null) {
  const effective = withExecutableActions(manifest, registries);
  return {
    manifestVersion: effective.version,
    manifestRoutes: manifestRoutesForBackend(effective),
    manifestActions: manifestActionsForBackend(effective),
    appName: effective.appName,
    appDescription: effective.appDescription,
    ...(effective.appType ? { appType: effective.appType } : {}),
    ...(effective.appFlow ? { appFlow: effective.appFlow } : {}),
  };
}
