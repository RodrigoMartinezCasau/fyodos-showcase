/**
 * Screen-context registration hooks. Screens declare what is visible while
 * mounted; the agent reads the latest snapshot lazily when invoked.
 */
import { useEffect, useRef } from 'react';
import { useFyodosRuntime } from '../provider/FyodosProvider';
import type { AgentScreenSnapshot } from './screenContextStore';

/** Registers the visible content while the component is mounted. */
export function useAgentScreenContext(
  snapshot: AgentScreenSnapshot | null | undefined,
): void {
  const ownerId = useRef(Symbol('fyodos-screen')).current;
  const { screenStore } = useFyodosRuntime();

  useEffect(() => {
    if (snapshot?.text?.trim()) {
      screenStore.set(ownerId, snapshot);
    } else {
      screenStore.clear(ownerId);
    }
    return () => screenStore.clear(ownerId);
  }, [snapshot, ownerId, screenStore]);
}

/** Imperative owner handle — for viewability callbacks (FlatList, carousels). */
export function useAgentScreenContextOwner(): {
  ownerId: symbol;
  set: (snapshot: AgentScreenSnapshot) => void;
  clear: () => void;
} {
  const ownerId = useRef(Symbol('fyodos-screen-owner')).current;
  const { screenStore } = useFyodosRuntime();
  return {
    ownerId,
    set: (snapshot) => screenStore.set(ownerId, snapshot),
    clear: () => screenStore.clear(ownerId),
  };
}

/**
 * Focus-scoped variant factory. Both expo-router and react-navigation export
 * a compatible useFocusEffect — the app passes its own once:
 *
 *   import { useFocusEffect } from 'expo-router';
 *   export const useAgentFocusedScreenContext =
 *     createFocusedScreenContextHook(useFocusEffect);
 */
export function createFocusedScreenContextHook(
  useFocusEffect: (effect: () => undefined | (() => void)) => void,
) {
  return function useAgentFocusedScreenContext(
    snapshot: AgentScreenSnapshot | null | undefined,
  ): void {
    const ownerId = useRef(Symbol('fyodos-focused-screen')).current;
    const { screenStore } = useFyodosRuntime();
    const focusedRef = useRef(false);
    const snapshotRef = useRef(snapshot);
    snapshotRef.current = snapshot;

    useFocusEffect(() => {
      focusedRef.current = true;
      const current = snapshotRef.current;
      if (current?.text?.trim()) screenStore.set(ownerId, current);
      return () => {
        focusedRef.current = false;
        screenStore.clear(ownerId);
      };
    });

    // Refresh while focused if the data changes with the screen visible.
    useEffect(() => {
      if (!focusedRef.current || !snapshot?.text?.trim()) return;
      screenStore.set(ownerId, snapshot);
    }, [snapshot, ownerId, screenStore]);
  };
}
