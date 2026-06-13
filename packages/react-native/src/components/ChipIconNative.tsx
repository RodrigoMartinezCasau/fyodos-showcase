import React from 'react';
import Svg, { G, Line, Path, Polygon, Rect } from 'react-native-svg';
import {
  chipIconCenterOffset,
  chipIconSpec,
  normalizeKeyboardChipIcon,
  type KeyboardChipIcon,
} from '@fyodos/core';

/** Preset chip icon — centered in viewBox (matches ChipIconSvg + rasterized PNG). */
export function ChipIconNative({
  icon = 'keyboard',
  size,
  color,
}: {
  icon?: KeyboardChipIcon;
  size: number;
  color: string;
}) {
  const preset = normalizeKeyboardChipIcon(icon);
  const spec = chipIconSpec(preset);
  const strokeW = 1.8;
  const { x: ox, y: oy } = chipIconCenterOffset(spec);

  const inner = (() => {
    if (spec.keyboardFrame && spec.keyDots) {
      const f = spec.keyboardFrame;
      return (
        <>
          <Rect
            x={f.x}
            y={f.y}
            width={f.w}
            height={f.h}
            rx={f.rx}
            stroke={color}
            strokeWidth={strokeW}
          />
          {spec.keyDots.map(([cx, cy]) => (
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
        </>
      );
    }

    if (spec.chatFrame && spec.chatLines) {
      const f = spec.chatFrame;
      const cx = f.x + f.w / 2;
      const baseY = f.y + f.h;
      const lineStroke = Math.max(1.15, strokeW * 0.65);
      const tail = spec.chatTail;
      return (
        <>
          <Rect
            x={f.x}
            y={f.y}
            width={f.w}
            height={f.h}
            rx={f.rx}
            stroke={color}
            strokeWidth={strokeW}
          />
          {tail ? (
            <Polygon
              points={`${tail.left},${baseY} ${tail.tipX},${tail.tipY} ${tail.right},${baseY}`}
              fill={color}
            />
          ) : null}
          {spec.chatLines.map((line) => (
            <Line
              key={line.y}
              x1={cx - line.w / 2}
              y1={line.y}
              x2={cx + line.w / 2}
              y2={line.y}
              stroke={color}
              strokeWidth={lineStroke}
              strokeLinecap="round"
            />
          ))}
        </>
      );
    }

    return spec.paths.map((p, i) => (
      <Path
        key={i}
        d={p.d}
        stroke={color}
        fill="none"
        strokeWidth={strokeW}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ));
  })();

  return (
    <Svg width={size} height={size} viewBox={spec.viewBox} fill="none">
      <G transform={`translate(${ox}, ${oy})`}>{inner}</G>
    </Svg>
  );
}
