/**
 * OrbBubble (React Native) — the orb's "thought bubble": a short, screen-aware
 * CTA rendered in a full-screen sibling overlay (like the keyboard chip) and
 * anchored to the orb's measured box on its FREE corner. Tapping it opens the
 * text panel. Purely presentational; the parent decides when to show it.
 *
 * The CTA stays on ONE line at its NATURAL font size and a CONSTANT height.
 * When the phrase is too long to fit the max width, the text scrolls (marquee,
 * right-to-left, looping) instead of shrinking the font or truncating.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  resolveBubblePadding,
  resolveBubbleShapeStyle,
  type OrbDeployment,
  type ResolvedBubbleTheme,
} from '@fiodos/core';

const BUBBLE_MAX_WIDTH = 280;
const MARQUEE_GAP = 48;
const MARQUEE_SPEED_PX_PER_S = 60;

export function OrbBubble({
  text,
  theme,
  deployment,
  orbRect,
  onPress,
  accessibilityLabel,
}: {
  text: string;
  theme: ResolvedBubbleTheme;
  deployment: OrbDeployment;
  orbRect: { x: number; y: number; w: number; h: number };
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  const win = Dimensions.get('window');
  const { fontPx, padH, approxHeight } = resolveBubblePadding(theme);
  const shapeStyle = resolveBubbleShapeStyle(theme, approxHeight);

  const maxWidth = Math.min(BUBBLE_MAX_WIDTH, win.width * 0.7);
  const innerMax = maxWidth - padH * 2 - theme.borderWidth * 2;
  const [textW, setTextW] = useState(0);
  const overflow = textW > 0 && textW > innerMax;
  const tx = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    tx.stopAnimation();
    tx.setValue(0);
    if (!overflow) return;
    const distance = textW + MARQUEE_GAP;
    const duration = Math.max(4000, (distance / MARQUEE_SPEED_PX_PER_S) * 1000);
    const loop = Animated.loop(
      Animated.timing(tx, {
        toValue: -distance,
        duration,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [overflow, textW, tx]);

  const horizontal =
    deployment.horizontal === 'left'
      ? { right: Math.max(8, win.width - orbRect.x + 10) }
      : { left: orbRect.x + orbRect.w + 10 };
  const vertical =
    deployment.vertical === 'up'
      ? { top: orbRect.y }
      : { top: Math.max(8, orbRect.y + orbRect.h - approxHeight) };

  const textStyle = {
    fontWeight: '500' as const,
    fontSize: fontPx,
    lineHeight: Math.round(fontPx * 1.25),
    color: theme.textColor,
  };

  const cornerRadii = {
    borderRadius: shapeStyle.borderRadius,
    borderTopLeftRadius: shapeStyle.borderTopLeftRadius,
    borderTopRightRadius: shapeStyle.borderTopRightRadius,
    borderBottomLeftRadius: shapeStyle.borderBottomLeftRadius,
    borderBottomRightRadius: shapeStyle.borderBottomRightRadius,
  };

  return (
    <View style={[styles.root, horizontal, vertical, { maxWidth }]}>
      {/* Off-screen probe: measures the natural single-line text width. */}
      <View style={styles.probeLayer} pointerEvents="none">
        <Text
          numberOfLines={1}
          style={textStyle}
          onLayout={(e) => setTextW(e.nativeEvent.layout.width)}
        >
          {text}
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? text}
        onPress={onPress}
        style={({ pressed }) => [
          styles.shadow,
          cornerRadii,
          {
            maxWidth,
            backgroundColor: theme.backgroundColor,
          },
          pressed ? styles.pressed : null,
        ]}
      >
        <View
          style={[
            styles.clip,
            cornerRadii,
            {
              height: approxHeight,
              maxWidth,
              width: overflow ? maxWidth : undefined,
              paddingHorizontal: padH,
              borderColor: theme.borderColor,
              borderWidth: theme.borderWidth,
            },
          ]}
        >
          {overflow ? (
            <Animated.View
              style={[styles.track, { transform: [{ translateX: tx }] }]}
            >
              <Text numberOfLines={1} style={[textStyle, { marginRight: MARQUEE_GAP }]}>
                {text}
              </Text>
              <Text numberOfLines={1} style={[textStyle, { marginRight: MARQUEE_GAP }]}>
                {text}
              </Text>
            </Animated.View>
          ) : (
            <Text numberOfLines={1} style={textStyle}>
              {text}
            </Text>
          )}
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    zIndex: 2147483000,
    maxWidth: BUBBLE_MAX_WIDTH,
  },
  probeLayer: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 9999,
    opacity: 0,
  },
  pressed: {
    opacity: 0.88,
  },
  shadow: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 8,
    elevation: 6,
  },
  clip: {
    overflow: 'hidden',
    justifyContent: 'center',
  },
  track: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
