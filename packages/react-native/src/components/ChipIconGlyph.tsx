import React from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
import type { KeyboardChipIcon } from '@fyodos/core';

/** Preset chip icon — simple SVG shapes (reliable on iOS, matches dashboard). */
export function ChipIconGlyph({
  icon = 'keyboard',
  size,
  color,
}: {
  icon?: KeyboardChipIcon;
  size: number;
  color: string;
}) {
  const stroke = Math.max(1.5, size * 0.1);

  if (icon === 'pen') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path
          d="M4 20h4l10.5-10.5a1.5 1.5 0 0 0 0-2.12l-2.38-2.38a1.5 1.5 0 0 0-2.12 0L4 15.5V20z"
          stroke={color}
          strokeWidth={stroke}
          strokeLinejoin="round"
        />
        <Path
          d="M13.5 6.5l4 4"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
      </Svg>
    );
  }

  if (icon === 'chat') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path
          d="M5 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H10l-4 3.5V6z"
          stroke={color}
          strokeWidth={stroke}
          strokeLinejoin="round"
        />
        <Path d="M9 10h6M9 13h4" stroke={color} strokeWidth={stroke} strokeLinecap="round" />
      </Svg>
    );
  }

  // keyboard — outline + key dots (no fragile micro-strokes)
  const keys: Array<[number, number]> = [
    [8, 11],
    [11, 11],
    [14, 11],
    [17, 11],
    [8, 14],
    [11, 14],
    [14, 14],
    [17, 14],
  ];

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect
        x="4"
        y="7"
        width="16"
        height="11"
        rx="2"
        stroke={color}
        strokeWidth={stroke}
      />
      {keys.map(([cx, cy]) => (
        <Rect
          key={`${cx}-${cy}`}
          x={cx - 0.6}
          y={cy - 0.6}
          width="1.2"
          height="1.2"
          rx="0.2"
          fill={color}
        />
      ))}
    </Svg>
  );
}
