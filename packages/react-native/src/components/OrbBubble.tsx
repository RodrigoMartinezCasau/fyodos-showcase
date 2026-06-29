/**
 * OrbBubble (React Native) — the orb's "thought bubble": a short, screen-aware
 * CTA rendered in a full-screen sibling overlay (like the keyboard chip) and
 * anchored to the orb's measured box on its FREE corner. Tapping it opens the
 * text panel. Purely presentational; the parent decides when to show it.
 */
import React from 'react';
import { Dimensions, Pressable, StyleSheet, Text } from 'react-native';
import {
  resolveBubblePadding,
  resolveBubbleShapeStyle,
  type OrbDeployment,
  type ResolvedBubbleTheme,
} from '@fiodos/core';

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
  const { fontPx, padV, padH, approxHeight } = resolveBubblePadding(theme);
  const shapeStyle = resolveBubbleShapeStyle(theme, approxHeight);

  const horizontal =
    deployment.horizontal === 'left'
      ? { right: Math.max(8, win.width - orbRect.x + 10) }
      : { left: orbRect.x + orbRect.w + 10 };
  const vertical =
    deployment.vertical === 'up'
      ? { top: orbRect.y }
      : { bottom: Math.max(8, win.height - (orbRect.y + orbRect.h)) };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? text}
      onPress={onPress}
      style={({ pressed }) => [
        styles.root,
        horizontal,
        vertical,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text
        style={[
          styles.text,
          {
            fontSize: fontPx,
            lineHeight: Math.round(fontPx * 1.25),
            color: theme.textColor,
            backgroundColor: theme.backgroundColor,
            borderColor: theme.borderColor,
            borderWidth: theme.borderWidth,
            borderRadius: shapeStyle.borderRadius,
            borderTopLeftRadius: shapeStyle.borderTopLeftRadius,
            borderTopRightRadius: shapeStyle.borderTopRightRadius,
            borderBottomLeftRadius: shapeStyle.borderBottomLeftRadius,
            borderBottomRightRadius: shapeStyle.borderBottomRightRadius,
            paddingVertical: padV,
            paddingHorizontal: padH,
          },
        ]}
      >
        {text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    zIndex: 2147483000,
    maxWidth: 280,
  },
  pressed: {
    opacity: 0.88,
  },
  text: {
    fontWeight: '500',
    lineHeight: undefined,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 8,
    elevation: 6,
  },
});
