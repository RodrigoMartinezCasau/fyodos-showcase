/**
 * React Native orb haptics. Maps the unified @fiodos/core haptic events to
 * short, subtle taps whose strength follows the developer's dashboard intensity
 * (0–100).
 *
 * Two backends, best-to-worst:
 *   1. `expo-haptics` (when installed): crisp, GENTLE impact styles. This is the
 *      preferred path on iOS, where the bare `Vibration` API fires a single
 *      fixed, disproportionately STRONG system buzz that ignores duration — the
 *      exact "too strong" feel we want to avoid.
 *   2. `Vibration` (always available): the pattern duration is scaled by the
 *      intensity so Android taps get lighter as the slider drops.
 *
 * Silent degradation throughout: if nothing is available or intensity is 0, it
 * does nothing.
 */
import { Vibration } from 'react-native';
import {
  NOOP_ORB_HAPTICS,
  orbHapticWebPattern,
  orbHapticImpactLevel,
  orbHapticIntensityFactor,
  type OrbHaptics,
  type OrbHapticEvent,
  type OrbHapticImpactLevel,
} from '@fiodos/core';

/** expo-haptics surface we use (optional dependency, loaded defensively). */
interface ExpoHapticsModule {
  ImpactFeedbackStyle: { Soft?: unknown; Light: unknown; Medium: unknown };
  impactAsync: (style: unknown) => Promise<void>;
}

/** Load expo-haptics if the app has it; otherwise null (→ Vibration fallback). */
function loadExpoHaptics(): ExpoHapticsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('expo-haptics') as ExpoHapticsModule;
    if (mod && typeof mod.impactAsync === 'function' && mod.ImpactFeedbackStyle) return mod;
  } catch {
    /* not installed → fall back to Vibration */
  }
  return null;
}

function expoStyleFor(mod: ExpoHapticsModule, level: OrbHapticImpactLevel): unknown | null {
  switch (level) {
    case 'none':
      return null;
    case 'soft':
      return mod.ImpactFeedbackStyle.Soft ?? mod.ImpactFeedbackStyle.Light;
    case 'light':
      return mod.ImpactFeedbackStyle.Light;
    case 'medium':
      return mod.ImpactFeedbackStyle.Medium;
    default:
      return mod.ImpactFeedbackStyle.Light;
  }
}

/**
 * Baseline RN haptics, scaled by the developer's `intensity` (0–100). Prefers
 * expo-haptics for gentle impacts (crucial on iOS); falls back to the scaled
 * Vibration pattern. `intensity` may be a number or a getter so the orb can
 * track a live-updating published config.
 */
export function createRnOrbHaptics(
  intensity?: number | (() => number | null | undefined) | null,
): OrbHaptics {
  const readIntensity = (): number | null | undefined =>
    typeof intensity === 'function' ? intensity() : intensity;

  const expo = loadExpoHaptics();

  if (expo) {
    return {
      trigger(event: OrbHapticEvent): void {
        try {
          const level = orbHapticImpactLevel(event, readIntensity());
          const style = expoStyleFor(expo, level);
          if (style != null) void expo.impactAsync(style).catch(() => {});
        } catch {
          /* haptics are best-effort and must never break the orb */
        }
      },
    };
  }

  if (!Vibration || typeof Vibration.vibrate !== 'function') return NOOP_ORB_HAPTICS;
  return {
    trigger(event: OrbHapticEvent): void {
      try {
        if (orbHapticIntensityFactor(readIntensity()) <= 0) return;
        // Reuse the shared, intensity-scaled pattern (ms number / array). On
        // Android the duration is honoured (a lighter tap as intensity drops).
        Vibration.vibrate(orbHapticWebPattern(event, readIntensity()));
      } catch {
        /* haptics are best-effort and must never break the orb */
      }
    },
  };
}
