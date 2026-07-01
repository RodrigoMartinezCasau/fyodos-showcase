/**
 * React Native orb haptics (BASELINE). Uses the always-available `Vibration`
 * API (no extra native dependency), scaling the shared @fiodos/core pattern by
 * the developer's dashboard intensity (0–100). Silent degradation: if vibration
 * is unavailable or intensity is 0, it does nothing.
 *
 * NOTE: on iOS the bare `Vibration` API fires a single fixed system buzz that
 * ignores duration, so it cannot be softened here. Expo apps get a gentler,
 * intensity-scaled engine instead — see `expo/expoOrbHaptics` — which is
 * injected into <AgentOrb /> via `hapticsFactory`. This baseline is the safe
 * fallback for bare React Native.
 */
import { Vibration } from 'react-native';
import {
  NOOP_ORB_HAPTICS,
  orbHapticWebPattern,
  orbHapticIntensityFactor,
  type OrbHaptics,
  type OrbHapticEvent,
} from '@fiodos/core';

/**
 * Factory for the orb haptics engine. `intensity` may be a number or a getter
 * so the engine can track a live-updating published config.
 */
export type OrbHapticsFactory = (
  intensity?: number | (() => number | null | undefined) | null,
) => OrbHaptics;

/** Baseline RN haptics via the Vibration API, scaled by intensity (0–100). */
export const createRnOrbHaptics: OrbHapticsFactory = (intensity) => {
  const readIntensity = (): number | null | undefined =>
    typeof intensity === 'function' ? intensity() : intensity;

  if (!Vibration || typeof Vibration.vibrate !== 'function') return NOOP_ORB_HAPTICS;
  return {
    trigger(event: OrbHapticEvent): void {
      try {
        if (orbHapticIntensityFactor(readIntensity()) <= 0) return;
        // Reuse the shared, intensity-scaled pattern (ms number / array). On
        // Android the duration is honoured (a lighter tap as intensity drops);
        // on iOS it triggers the default short vibration.
        Vibration.vibrate(orbHapticWebPattern(event, readIntensity()));
      } catch {
        /* haptics are best-effort and must never break the orb */
      }
    },
  };
};
