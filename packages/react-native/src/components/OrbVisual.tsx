/**
 * Orb — solid fill + static monochrome border.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Image, StyleSheet, View } from 'react-native';
import type { OrbLogoTransform } from '@fyodos/core';
import {
  normalizeOrbGlowIntensity,
  normalizeOrbLogoTransform,
  resolveInnerBorderStrokeColor,
  resolveOrbBackgroundColor,
} from '@fyodos/core';
import { OutwardDoubleBorder, resolveRnOutwardBorderLayout } from './OutwardDoubleBorder';
import type { AgentOrbTheme } from './theme';

const LOGO_COVER = 0.54;
/** Same 1s cycle as dashboard fy-opulse; only scale grows at peak. */
const SPEAK_PULSE_HALF_MS = 500;
const SPEAK_PULSE_MAX_SCALE = 1.14;

export function OrbVisual({
  size,
  theme,
  logoDataUrl,
  logoTransform,
  showLogo = true,
  speaking = false,
  children,
}: {
  size: number;
  theme: AgentOrbTheme;
  logoDataUrl?: string | null;
  logoTransform?: Partial<OrbLogoTransform> | null;
  showLogo?: boolean;
  speaking?: boolean;
  children?: React.ReactNode;
}) {
  const fill = resolveOrbBackgroundColor({
    colorKey: theme.colorKey,
    accentColor: theme.accentColor,
    backgroundColor: theme.backgroundColor,
  });
  const exteriorColor = theme.glowColor?.startsWith('#') ? theme.glowColor : theme.accentColor;
  const interiorColor = resolveInnerBorderStrokeColor(theme.innerBorderColor);
  const { totalPx } = resolveRnOutwardBorderLayout(
    size,
    theme.glowIntensity,
    theme.innerBorderWidth,
  );
  const t = normalizeOrbLogoTransform(logoTransform);
  const cover = size * LOGO_COVER;
  const speakPulse = useRef(new Animated.Value(0)).current;

  const showLogoImage =
    showLogo && logoDataUrl && !logoDataUrl.startsWith('data:image/svg');

  useEffect(() => {
    if (!speaking || !showLogoImage) {
      speakPulse.stopAnimation();
      speakPulse.setValue(0);
      return;
    }

    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(speakPulse, {
          toValue: 1,
          duration: SPEAK_PULSE_HALF_MS,
          useNativeDriver: true,
        }),
        Animated.timing(speakPulse, {
          toValue: 0,
          duration: SPEAK_PULSE_HALF_MS,
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [showLogoImage, speakPulse, speaking]);

  const logoScale = speakPulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, SPEAK_PULSE_MAX_SCALE],
  });

  return (
    <OutwardDoubleBorder
      fillDiameter={size}
      cornerRadius="circle"
      exteriorColor={exteriorColor}
      exteriorWidthSlider={theme.glowIntensity}
      interiorColor={interiorColor}
      interiorWidthSlider={theme.innerBorderWidth}
      fillColor={fill}
      outerGlow={normalizeOrbGlowIntensity(theme.glowIntensity) > 0}
      style={{ width: totalPx, height: totalPx, alignItems: 'center', justifyContent: 'center' }}
    >
      <View style={[styles.content, { zIndex: 1 }]}>{children}</View>

      {showLogoImage ? (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFillObject,
            styles.logoWrap,
            speaking ? { transform: [{ scale: logoScale }] } : null,
          ]}
        >
          <Image
            source={{ uri: logoDataUrl }}
            style={{
              width: cover,
              height: cover,
              backgroundColor: 'transparent',
              transform: [
                { translateX: (t.offsetX / 100) * size },
                { translateY: (t.offsetY / 100) * size },
                { rotate: `${t.rotation}deg` },
                { scaleX: (t.flipX ? -1 : 1) * t.scale },
                { scaleY: (t.flipY ? -1 : 1) * t.scale },
              ],
            }}
            resizeMode="contain"
          />
        </Animated.View>
      ) : null}
    </OutwardDoubleBorder>
  );
}

const styles = StyleSheet.create({
  content: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
});
