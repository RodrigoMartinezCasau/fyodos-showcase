import React from 'react';
import { View, type ViewStyle } from 'react-native';

/**
 * Uniform zoom on the whole glyph, centered in the chip.
 * Layout box = full chip diameter; icon content is centered inside baseSize.
 */
export function ChipIconScaled({
  chipSize,
  baseSize,
  scale,
  children,
  style,
}: {
  chipSize: number;
  baseSize: number;
  scale: number;
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View
      style={[
        {
          width: chipSize,
          height: chipSize,
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}
    >
      <View
        style={{
          width: baseSize,
          height: baseSize,
          alignItems: 'center',
          justifyContent: 'center',
          transform: [{ scale }],
        }}
      >
        <View
          style={{
            width: baseSize,
            height: baseSize,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {children}
        </View>
      </View>
    </View>
  );
}
