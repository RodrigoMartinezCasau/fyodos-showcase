/**
 * Expo orb haptics — a gentler, intensity-scaled engine for Expo apps.
 *
 * Under '/expo' so Metro only resolves the Expo packages in apps that use this
 * adapter. The native `ExpoHaptics` module is loaded OPTIONALLY (via
 * `requireOptionalNativeModule`), so it never crashes where it is not linked —
 * in that case we fall back to the baseline RN `Vibration` engine.
 *
 * Why this instead of the baseline: on iOS the bare `Vibration` API fires a
 * single fixed, disproportionately STRONG system buzz that ignores duration.
 * `ExpoHaptics.impactAsync(style)` maps to UIImpactFeedbackGenerator, giving
 * crisp, GENTLE taps whose style we pick from the dashboard intensity (0–100).
 */
import {
  orbHapticImpactLevel,
  type OrbHaptics,
  type OrbHapticEvent,
  type OrbHapticImpactLevel,
} from '@fiodos/core';
import { createRnOrbHaptics, type OrbHapticsFactory } from '../haptics';

/* eslint-disable @typescript-eslint/no-var-requires */
const { requireOptionalNativeModule } = require('expo') as {
  requireOptionalNativeModule<T>(name: string): T | null;
};
/* eslint-enable @typescript-eslint/no-var-requires */

interface ExpoHapticsNativeModule {
  impactAsync(style: string): Promise<void>;
}

// Evaluated once at module load; null when the native module is not linked, in
// which case we degrade to the baseline Vibration engine.
const ExpoHaptics = requireOptionalNativeModule<ExpoHapticsNativeModule>('ExpoHaptics');

// UIImpactFeedbackStyle string values used by expo-haptics.
function styleForLevel(level: OrbHapticImpactLevel): string | null {
  switch (level) {
    case 'none':
      return null;
    case 'soft':
      return 'soft';
    case 'light':
      return 'light';
    case 'medium':
      return 'medium';
    case 'heavy':
      return 'heavy';
    default:
      return 'light';
  }
}

/**
 * Gentle, intensity-scaled orb haptics for Expo. Falls back to the baseline RN
 * Vibration engine when the native ExpoHaptics module is unavailable.
 */
export const createExpoOrbHaptics: OrbHapticsFactory = (intensity) => {
  if (!ExpoHaptics || typeof ExpoHaptics.impactAsync !== 'function') {
    return createRnOrbHaptics(intensity);
  }
  const readIntensity = (): number | null | undefined =>
    typeof intensity === 'function' ? intensity() : intensity;
  return {
    trigger(event: OrbHapticEvent): void {
      try {
        const style = styleForLevel(orbHapticImpactLevel(event, readIntensity()));
        if (style != null) void ExpoHaptics.impactAsync(style).catch(() => {});
      } catch {
        /* haptics are best-effort and must never break the orb */
      }
    },
  };
};
