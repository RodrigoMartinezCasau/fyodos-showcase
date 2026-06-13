import { RefObject, useEffect, useRef } from 'react';
import type { View } from 'react-native';
import {
  computeOrbRimCounterSpinDegPerSec,
  computeOrbRimMotionOpacity,
  computeOrbSpinDegPerSec,
} from '@fyodos/core';

type RimMotionOptions = {
  reverse?: boolean;
  pulseScale?: number;
};

/**
 * Rotating rim + opacity fluctuation via setNativeProps (no React re-renders per frame).
 */
export function useOrbRimMotionRef(
  speed = 42,
  active = true,
  options?: RimMotionOptions,
): RefObject<View | null> {
  const ref = useRef<View>(null);
  const angleRef = useRef(0);
  const t0Ref = useRef(Date.now());

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = Date.now();
    const dps = options?.reverse
      ? computeOrbRimCounterSpinDegPerSec(speed)
      : computeOrbSpinDegPerSec(speed);
    const pulseScale = options?.pulseScale ?? 1;

    const tick = () => {
      const now = Date.now();
      const dt = (now - last) / 1000;
      last = now;
      angleRef.current = (angleRef.current + dps * dt) % 360;
      const elapsed = (now - t0Ref.current) / 1000;
      const opacity = computeOrbRimMotionOpacity(elapsed, speed) * pulseScale;
      ref.current?.setNativeProps?.({
        style: {
          transform: [{ rotate: `${angleRef.current}deg` }],
          opacity: Math.max(0.05, Math.min(1, opacity)),
        },
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [speed, active, options?.reverse, options?.pulseScale]);

  return ref;
}

/** @deprecated Use useOrbRimMotionRef */
export function useOrbSpinRef(speed = 42, active = true): RefObject<View | null> {
  return useOrbRimMotionRef(speed, active);
}
