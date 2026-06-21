/**
 * Double border outward from fixed fill.
 * Exterior: solid ring (reads bold on device). Interior: native border stroke.
 */
import React from 'react';
import { PixelRatio, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  computeOutwardBorderLayout,
  normalizeOrbGlowIntensity,
} from '@fiodos/core';

function layerRadius(layerPx: number, cornerRadius: number | 'circle'): number {
  return cornerRadius === 'circle' ? layerPx / 2 : cornerRadius;
}

/** RN drops subpixel strokes; at least one physical pixel when slider > 0. */
export function resolveInteriorBorderStroke(computedPx: number): number {
  if (computedPx <= 0) return 0;
  const minStroke = Math.max(StyleSheet.hairlineWidth, 1 / PixelRatio.get());
  return Math.max(computedPx, minStroke);
}

/** Layout totals after RN inner-stroke floor (for orb/chip positioning). */
export function resolveRnOutwardBorderLayout(
  fillDiameter: number,
  exteriorWidthSlider?: number | null,
  interiorWidthSlider?: number | null,
) {
  const layout = computeOutwardBorderLayout(
    fillDiameter,
    normalizeOrbGlowIntensity(exteriorWidthSlider),
    interiorWidthSlider,
  );
  const interiorStroke = resolveInteriorBorderStroke(layout.interiorPx);
  const midPx = layout.fillPx + 2 * interiorStroke;
  const totalPx = midPx + 2 * layout.exteriorPx;
  return { ...layout, interiorStroke, midPx, totalPx };
}

function parseGlowShadow(
  color: string,
  elementSizePx: number,
): Pick<ViewStyle, 'shadowColor' | 'shadowOpacity' | 'shadowRadius' | 'shadowOffset'> {
  const hex = color.replace('#', '').trim();
  const s = elementSizePx / 150;
  const shadowRadius = Math.round(48 * s);
  if (hex.length < 6) {
    return { shadowColor: color, shadowOpacity: 0.2, shadowRadius, shadowOffset: { width: 0, height: 0 } };
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return {
    shadowColor: `rgb(${r},${g},${b})`,
    shadowOpacity: 0.2,
    shadowRadius,
    shadowOffset: { width: 0, height: 0 },
  };
}

export function OutwardDoubleBorder({
  fillDiameter,
  cornerRadius = 'circle',
  exteriorColor,
  exteriorWidthSlider,
  interiorColor,
  interiorWidthSlider,
  fillColor,
  outerGlow = false,
  style,
  children,
}: {
  fillDiameter: number;
  cornerRadius?: number | 'circle';
  exteriorColor: string;
  exteriorWidthSlider?: number | null;
  interiorColor: string;
  interiorWidthSlider?: number | null;
  fillColor: string;
  outerGlow?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}) {
  const layout = computeOutwardBorderLayout(
    fillDiameter,
    normalizeOrbGlowIntensity(exteriorWidthSlider),
    interiorWidthSlider,
  );
  const { fillPx, exteriorPx, fillRadius } = layout;
  const interiorStroke = resolveInteriorBorderStroke(layout.interiorPx);
  const midPx = fillPx + 2 * interiorStroke;
  const totalPx = midPx + 2 * exteriorPx;

  const fillRadiusStyle = cornerRadius === 'circle' ? fillRadius : cornerRadius;
  const midRadiusStyle = layerRadius(midPx, cornerRadius);
  const totalRadiusStyle = layerRadius(totalPx, cornerRadius);

  const fill = (
    <View
      style={{
        width: fillPx,
        height: fillPx,
        borderRadius: fillRadiusStyle,
        backgroundColor: fillColor,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </View>
  );

  let content =
    interiorStroke > 0 ? (
      <View
        style={{
          width: midPx,
          height: midPx,
          borderRadius: midRadiusStyle,
          borderWidth: interiorStroke,
          borderColor: interiorColor,
          backgroundColor: 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {fill}
      </View>
    ) : (
      fill
    );

  if (exteriorPx > 0) {
    content = (
      <View
        style={[
          {
            width: totalPx,
            height: totalPx,
            borderRadius: totalRadiusStyle,
            backgroundColor: exteriorColor,
            alignItems: 'center',
            justifyContent: 'center',
          },
          outerGlow ? parseGlowShadow(exteriorColor, totalPx) : null,
          outerGlow ? styles.outerGlowAndroid : null,
        ]}
      >
        {content}
      </View>
    );
  }

  if (!style) return content;
  return <View style={style}>{content}</View>;
}

const styles = StyleSheet.create({
  outerGlowAndroid: {
    elevation: 6,
  },
});
