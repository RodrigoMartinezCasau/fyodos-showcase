/**
 * Double border that grows outward from a fixed fill — mirrors dashboard ChromeDoubleBorder.
 * RN borderWidth is border-box; we paint rings with nested discs instead.
 */
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  computeOutwardBorderLayout,
  normalizeOrbGlowIntensity,
} from '@fyodos/core';

function layerRadius(layerPx: number, cornerRadius: number | 'circle'): number {
  return cornerRadius === 'circle' ? layerPx / 2 : cornerRadius;
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
  const { fillPx, interiorPx, exteriorPx, totalPx, fillRadius, midPx } = computeOutwardBorderLayout(
    fillDiameter,
    normalizeOrbGlowIntensity(exteriorWidthSlider),
    interiorWidthSlider,
  );

  const fillRadiusStyle = cornerRadius === 'circle' ? fillRadius : cornerRadius;
  const midRadiusStyle = layerRadius(midPx, cornerRadius);
  const totalRadiusStyle = layerRadius(totalPx, cornerRadius);

  let content = (
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

  if (interiorPx > 0) {
    content = (
      <View
        style={{
          width: midPx,
          height: midPx,
          borderRadius: midRadiusStyle,
          backgroundColor: interiorColor,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {content}
      </View>
    );
  }

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
