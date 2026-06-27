/**
 * usePendingExternalApprovals — the HUMAN side of Fiodos agent-to-agent.
 *
 * When an external agent (ChatGPT, Claude, a company bot) requests an action the
 * developer marked as STRICT, the Fiodos guardian does NOT execute it. It freezes
 * the action and waits for the human account owner to approve it. This hook lets
 * the app show those pending approvals and approve/reject them.
 *
 * Security — the trust boundary:
 *   Approval ALWAYS uses the APP credential (x-api-key) + the user's own ref,
 *   exactly like authorizing an agent (POST /v1/external/authorize). It NEVER
 *   uses the external agent's delegated token, so the external agent can never
 *   approve its own request. The backend enforces this; this hook simply sends
 *   the correct credential. Do not pass an external agent's bearer token here.
 *
 * Wire contract (already implemented server-side):
 *   GET  /v1/external/pending?userRef=...            (x-api-key)
 *   POST /v1/external/pending/{id}/approve {userRef} (x-api-key)
 *   POST /v1/external/pending/{id}/reject  {userRef} (x-api-key)
 *
 * Framework-light: depends only on react + fetch, so it works in React Native
 * and web. The app provides the same apiBaseUrl + apiKey it already uses to wire
 * the orb, and the logged-in user's ref.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface PendingExternalApproval {
  /** Opaque id to approve/reject and to echo back to the external agent. */
  id: string;
  /** The manifest action the external agent wants to run (e.g. 'place_order'). */
  intent: string;
  /** The concrete, frozen parameters the human is approving. */
  parameters: Record<string, unknown>;
  /** Which external agent requested it (for the human to judge). */
  externalAgentId: string;
  /** ISO timestamp the request was created. */
  createdAt: string;
  /** Unix seconds after which the request expires unapproved. */
  expiresAt: number;
}

export interface UsePendingExternalApprovalsOptions {
  /** Base URL of the Fiodos backend (no trailing slash required). */
  apiBaseUrl: string;
  /** The APP's public API key (x-api-key). NEVER an external agent token. */
  apiKey: string;
  /** The logged-in user's stable ref (same value used to authorize agents).
   *  When null/undefined the hook stays idle and reports no pending. */
  userRef: string | null | undefined;
  /** Poll interval in ms to refresh the list. Omit/0 = no polling. */
  pollMs?: number;
  /** Load on mount / when inputs change (default true). */
  autoLoad?: boolean;
}

export interface UsePendingExternalApprovalsResult {
  pending: PendingExternalApproval[];
  loading: boolean;
  error: string | null;
  /** The id currently being approved/rejected (for per-row spinners). */
  decidingId: string | null;
  refresh: () => Promise<void>;
  approve: (id: string) => Promise<void>;
  reject: (id: string) => Promise<void>;
}

function trimBase(url: string): string {
  return (url || '').replace(/\/$/, '');
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === 'string') return body.detail;
  } catch {
    /* fall through */
  }
  return `HTTP ${res.status}`;
}

export function usePendingExternalApprovals(
  options: UsePendingExternalApprovalsOptions,
): UsePendingExternalApprovalsResult {
  const { apiBaseUrl, apiKey, userRef, pollMs, autoLoad = true } = options;

  const [pending, setPending] = useState<PendingExternalApproval[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  // Keep the latest inputs in a ref so the stable callbacks always read fresh
  // values without being recreated on every render.
  const cfgRef = useRef({ apiBaseUrl, apiKey, userRef });
  cfgRef.current = { apiBaseUrl, apiKey, userRef };

  const refresh = useCallback(async () => {
    const { apiBaseUrl: base, apiKey: key, userRef: ref } = cfgRef.current;
    if (!ref || !base || !key) {
      setPending([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${trimBase(base)}/v1/external/pending?userRef=${encodeURIComponent(ref)}`,
        { headers: { 'x-api-key': key } },
      );
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as { pending?: PendingExternalApproval[] };
      setPending(Array.isArray(body.pending) ? body.pending : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load pending approvals');
    } finally {
      setLoading(false);
    }
  }, []);

  const decide = useCallback(
    async (id: string, action: 'approve' | 'reject') => {
      const { apiBaseUrl: base, apiKey: key, userRef: ref } = cfgRef.current;
      if (!ref || !base || !key) return;
      setDecidingId(id);
      setError(null);
      try {
        const res = await fetch(
          `${trimBase(base)}/v1/external/pending/${encodeURIComponent(id)}/${action}`,
          {
            method: 'POST',
            headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ userRef: ref }),
          },
        );
        if (!res.ok) throw new Error(await readError(res));
        // Optimistically drop the decided row; the backend already moved it out
        // of the 'pending' state so a refresh would do the same.
        setPending((rows) => rows.filter((r) => r.id !== id));
      } catch (e) {
        setError(e instanceof Error ? e.message : `Could not ${action} the action`);
        // Re-sync so the UI reflects the true server state on failure.
        void refresh();
      } finally {
        setDecidingId(null);
      }
    },
    [refresh],
  );

  const approve = useCallback((id: string) => decide(id, 'approve'), [decide]);
  const reject = useCallback((id: string) => decide(id, 'reject'), [decide]);

  useEffect(() => {
    if (!autoLoad) return;
    void refresh();
  }, [autoLoad, refresh, apiBaseUrl, apiKey, userRef]);

  useEffect(() => {
    if (!pollMs || !userRef) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, userRef, refresh]);

  return { pending, loading, error, decidingId, refresh, approve, reject };
}
