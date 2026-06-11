/**
 * Bridge pattern — connect SDK action handlers to app state that lives in
 * React Contexts (stores, auth, preferences…), which cannot be used outside
 * components.
 *
 * The app defines an imperative interface, creates a module-level bridge with
 * createBridge<T>(), registers the live implementation from a mounted
 * component (useRegisterBridge), and handlers consume bridge.get(). When the
 * bridge is not registered yet, handlers degrade with a clear message.
 */

export interface Bridge<T extends object> {
  /** Debug name surfaced in error messages. */
  readonly name: string;
  set(impl: T | null): void;
  /** Current implementation, or null if the app has not registered it yet. */
  get(): T | null;
}

export function createBridge<T extends object>(name = 'bridge'): Bridge<T> {
  let current: T | null = null;
  return {
    name,
    set(impl) {
      current = impl;
    },
    get() {
      return current;
    },
  };
}
