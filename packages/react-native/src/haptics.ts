/**
 * React Native orb haptics. Uses the always-available `Vibration` API (no extra
 * native dependency), mapping the unified @fiodos/core haptic events to short,
 * subtle taps. Silent degradation: if vibration is unavailable or disabled, it
 * simply does nothing.
 *
 * Apps that want crisp iOS-style impact haptics can still pass `onPressFeedback`
 * (e.g. expo-haptics) to <AgentOrb />; that runs in addition to this baseline.
 */
import { Vibration } from 'react-native';
import {
  NOOP_ORB_HAPTICS,
  orbHapticWebPattern,
  type OrbHaptics,
  type OrbHapticEvent,
} from '@fiodos/core';

/** Baseline RN haptics via the Vibration API, with fully silent degradation. */
export function createRnOrbHaptics(): OrbHaptics {
  if (!Vibration || typeof Vibration.vibrate !== 'function') return NOOP_ORB_HAPTICS;
  return {
    trigger(event: OrbHapticEvent): void {
      try {
        // Reuse the shared pattern (ms number / array). On Android the duration
        // is honoured (a light tap); on iOS the pattern triggers the default
        // short vibration. Either way it stays brief.
        Vibration.vibrate(orbHapticWebPattern(event));
      } catch {
        /* haptics are best-effort and must never break the orb */
      }
    },
  };
}
