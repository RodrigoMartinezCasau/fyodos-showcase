/**
 * Default Fyodos telemetry adapter — maps the SDK's agent events to the
 * backend's privacy-safe usage events and ships them to POST /v1/agent/events.
 *
 * Design constraints:
 * - Fire-and-forget: wrapped by createSafeTelemetry upstream, and additionally
 *   guarded here so a failed flush can never surface to the agent flow.
 * - Cheap: events are buffered and flushed in small batches (a short timer or a
 *   size threshold), so the assistant's hot path is never blocked by I/O.
 * - Privacy: ONLY the event type, the action intent and an opaque session id
 *   leave the device. Never any message, transcript or context content.
 *
 * Statistics are produced server-side by COUNTING these events (SQL), never by
 * AI — this adapter only reports the countable facts.
 */
import type { AgentEventParams, TelemetryAdapter } from '@fyodos/core';

export interface FyodosTelemetryOptions {
  baseUrl: string;
  /** Client API key sent as x-api-key (same contract as the backend client). */
  apiKey?: string;
  /** End-user id sent as x-user-id (rate-limit correlation). */
  getUserId?: () => string | null;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Max ms to buffer events before flushing (default 4000). */
  flushIntervalMs?: number;
  /** Max events buffered before an immediate flush (default 20). */
  maxBatch?: number;
}

/** Wire shape accepted by POST /v1/agent/events. */
interface WireEvent {
  type: 'session' | 'action' | 'confirmation_requested' | 'confirmation_completed';
  intent?: string | null;
  session_id?: string | null;
}

/**
 * Maps one SDK agent event to zero or more backend usage events. Only the
 * events that are countable and content-free produce output; everything else
 * (navigation, errors, consent, STT issues…) is intentionally ignored here.
 */
function mapEvent(params: AgentEventParams): WireEvent[] {
  const intent = params.intentDetected ?? null;
  const sessionId = params.sessionId ?? null;

  switch (params.eventType) {
    case 'agent_session_started':
      return [{ type: 'session', session_id: sessionId }];

    case 'action_executed': {
      // A real, successful execution of a manifest action.
      const events: WireEvent[] = [{ type: 'action', intent, session_id: sessionId }];
      // If it ran through a sensitive confirmation, it also completed one.
      const confirmed =
        params.actionExecuted != null &&
        (params.actionExecuted as { confirmed?: unknown }).confirmed === true;
      if (confirmed) {
        events.push({ type: 'confirmation_completed', intent, session_id: sessionId });
      }
      return events;
    }

    case 'action_confirmation_requested':
      return [{ type: 'confirmation_requested', intent, session_id: sessionId }];

    default:
      return [];
  }
}

export function createFyodosTelemetry(options: FyodosTelemetryOptions): TelemetryAdapter {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const flushIntervalMs = options.flushIntervalMs ?? 4000;
  const maxBatch = options.maxBatch ?? 20;

  let queue: WireEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function buildHeaders(): Record<string, string> {
    const userId = options.getUserId?.();
    return {
      'Content-Type': 'application/json',
      ...(options.apiKey ? { 'x-api-key': options.apiKey } : {}),
      ...(userId ? { 'x-user-id': userId } : {}),
      ...(options.headers ?? {}),
    };
  }

  function flush(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    // Best-effort: a telemetry failure must never bubble up. We drop on error
    // rather than retry, to keep the assistant path cheap and predictable.
    void (async () => {
      try {
        await fetch(`${baseUrl}/v1/agent/events`, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify({ events: batch }),
        });
      } catch {
        /* drop — analytics are best-effort */
      }
    })();
  }

  function scheduleFlush(): void {
    if (timer) return;
    timer = setTimeout(flush, flushIntervalMs);
  }

  return {
    logEvent(params: AgentEventParams): void {
      const mapped = mapEvent(params);
      if (mapped.length === 0) return;
      for (const ev of mapped) queue.push(ev);
      if (queue.length >= maxBatch) flush();
      else scheduleFlush();
    },
  };
}
