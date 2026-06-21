import { useEffect, useRef, useState } from 'react';
import { computeOrbSpinDegPerSec } from '@fiodos/core';

/** Continuous rim rotation (deg) — rAF instead of Animated (Fabric-safe on RN 0.81). */
export function useOrbSpinAngle(speed = 42, active = true): number {
  const [angle, setAngle] = useState(0);
  const angleRef = useRef(0);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = Date.now();
    const degPerSec = computeOrbSpinDegPerSec(speed);

    const tick = () => {
      const now = Date.now();
      const dt = (now - last) / 1000;
      last = now;
      let next = angleRef.current + degPerSec * dt;
      if (next >= 360) next -= 360;
      angleRef.current = next;
      setAngle(next);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [speed, active]);

  return angle;
}
