import React from 'react';
import { View } from 'react-native';
import { resolveFyodosOrbMarkBars } from '@fyodos/core';

/**
 * Neutral Fyodos brand mark for the orb center (idle, no logo).
 *
 * Drawn from the shared spec in @fyodos/core (same as the dashboard web
 * preview), so the default center icon is identical across app and dashboard.
 * This is the product default; apps must NOT inject their own emoji/icon here.
 */
export function FyodosOrbMark({ orbSize }: { orbSize: number }) {
  const { bars, color, radius } = resolveFyodosOrbMarkBars(orbSize);
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
