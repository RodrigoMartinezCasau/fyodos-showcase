/**
 * OrbBubble (React Native) — the orb's "thought bubble": a short, screen-aware
 * CTA rendered in a full-screen sibling overlay (like the keyboard chip) and
 * anchored to the orb's measured box on its FREE side. Tapping it opens the
 * text panel. Purely presentational; the parent decides when to show it.
 *
 * NOTE: unlike the web bubble, the native apps do NOT animate (marquee) the
 * text. The moving text proved unreliable on device (measurement races made it
 * disappear), so on apps we render a single static line that grows to fit the
 * phrase up to a viewport-derived cap and truncates with an ellipsis beyond
 * that. The web keeps its CSS marquee.
 */
import React from 'react';
import { Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  resolveBubblePadding,
  resolveBubbleShapeStyle,
  type OrbDeployment,
  type ResolvedBubbleTheme,
} from '@fiodos/core';

// Same model as the web bubble: cap at 280px or 70% of the viewport.
const BUBBLE_MAX_WIDTH_PX = 280;
const BUBBLE_VIEWPORT_FRACTION = 0.7;

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

  const maxWidth = Math.min(BUBBLE_MAX_WIDTH_PX, win.width * BUBBLE_VIEWPORT_FRACTION);

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
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? text}
        onPress={onPress}
        style={({ pressed }) => [styles.shadow, pressed ? styles.pressed : null]}
      >
        <View
          style={[
            styles.clip,
            cornerRadii,
            {
              height: approxHeight,
              maxWidth,
              paddingHorizontal: padH,
              backgroundColor: theme.backgroundColor,
              borderColor: theme.borderColor,
              borderWidth: theme.borderWidth,
            },
          ]}
        >
          <Text numberOfLines={1} ellipsizeMode="tail" style={textStyle}>
            {text}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    zIndex: 2147483000,
    maxWidth: BUBBLE_MAX_WIDTH_PX,
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
});
