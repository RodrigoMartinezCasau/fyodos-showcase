import React from 'react';
import { View } from 'react-native';
import { resolveFiodosOrbMarkBars } from '@fiodos/core';

/**
 * Fiodos brand mark for the orb center (idle, no logo).
 *
 * Drawn from the shared spec in @fiodos/core (same as the dashboard web
 * preview), so the default center icon is identical across app and dashboard.
 * Tinted with the developer's "audio color" (waveformColor) — the same editor
 * that colors the listening waveform — falling back to the neutral default.
 * This is the product default; apps must NOT inject their own emoji/icon here.
 */
export function FiodosOrbMark({ orbSize, color: colorProp }: { orbSize: number; color?: string | null }) {
  const { bars, color, radius } = resolveFiodosOrbMarkBars(orbSize, colorProp);
  return (
    <View style={{ width: orbSize, height: orbSize }}>
      {bars.map((b, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: b.x,
            top: b.y,
            width: b.width,
            height: b.height,
            borderRadius: radius,
            backgroundColor: color,
          }}
        />
      ))}
    </View>
  );
}
