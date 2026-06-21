/**
 * Screen-context store: screens register WHAT IS VISIBLE while mounted; the
 * agent reads it lazily when a turn is invoked (no re-renders, ref-based).
 *
 * The structured part is the core's generic AgentScreenContext
 * (visibleContent + custom) — no domain types.
 */
import type { AgentScreenContext } from '@fiodos/core';

/** What a screen registers for the agent. */
export interface AgentScreenSnapshot {
  /** App-defined tag of the screen type (free string, for telemetry/debug). */
  kind: string;
  /** Pre-formatted context text for the LLM (the app's own language/wording). */
  text: string;
  /** Structured snapshot used by 'execute' actions (target ids, etc.). */
  context?: AgentScreenContext;
}

export interface ScreenContextStore {
  set(ownerId: symbol, snapshot: AgentScreenSnapshot): void;
  clear(ownerId: symbol): void;
  /** Registered text, or the route fallback, or null. */
  getText(): string | null;
  /** Structured snapshot or null. */
  getSnapshot(): AgentScreenSnapshot | null;
}

export function createScreenContextStore(options: {
  getCurrentRoute: () => string | null;
  routeFallback?: (route: string | null) => string | null;
}): ScreenContextStore {
  let entry: { ownerId: symbol; snapshot: AgentScreenSnapshot } | null = null;

  return {
    set(ownerId, snapshot) {
      entry = { ownerId, snapshot };
    },
    clear(ownerId) {
      if (entry?.ownerId === ownerId) entry = null;
    },
    getText() {
      const registered = entry?.snapshot.text?.trim();
      if (registered) return registered;
      const fallback = options.routeFallback?.(options.getCurrentRoute())?.trim();
      return fallback || null;
    },
    getSnapshot() {
      return entry?.snapshot ?? null;
    },
  };
}
