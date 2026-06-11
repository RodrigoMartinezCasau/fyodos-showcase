/**
 * Per-entity UI registry — for actions whose target UI lives inside a mounted
 * component, not behind a route (open a composer, open a picker…).
 *
 * Each mounted card/screen registers how to open its UI under its entity id;
 * handlers look the target up by id. If the visible entity is not registered,
 * the action degrades with a clear message.
 */

export interface UiRegistry<T> {
  /** Registers handlers for an entity id. Returns the cleanup function. */
  register(id: string, handlers: T): () => void;
  /** Handlers for the id, or null if not mounted/registered. */
  get(id: string): T | null;
}

export function createUiRegistry<T>(): UiRegistry<T> {
  const registry = new Map<string, T>();
  return {
    register(id, handlers) {
      registry.set(id, handlers);
      return () => {
        if (registry.get(id) === handlers) registry.delete(id);
      };
    },
    get(id) {
      return registry.get(id) ?? null;
    },
  };
}
