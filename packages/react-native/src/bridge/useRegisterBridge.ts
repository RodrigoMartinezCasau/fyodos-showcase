import { useEffect, useRef } from 'react';
import type { Bridge } from './createBridge';

/**
 * Registers a bridge implementation while the component is mounted.
 *
 * The implementation object may be re-created on every render with live
 * context values: the bridge stores a stable proxy that always reads through
 * a ref, so handlers see the CURRENT state without re-registrations
 * (the "stateRef" pattern hardened in production).
 */
export function useRegisterBridge<T extends object>(bridge: Bridge<T>, impl: T): void {
  const implRef = useRef(impl);
  implRef.current = impl;

  useEffect(() => {
    const proxy = new Proxy({} as T, {
      get(_target, prop) {
        return (implRef.current as Record<PropertyKey, unknown>)[prop];
      },
      has(_target, prop) {
        return prop in implRef.current;
      },
    });
    bridge.set(proxy);
    return () => bridge.set(null);
  }, [bridge]);
}
