/**
 * OrbBubble (React Native) — the orb's "thought bubble": a short, screen-aware
 * CTA rendered in a full-screen sibling overlay (like the keyboard chip) and
 * anchored to the orb's measured box on its FREE corner. Tapping it opens the
 * text panel. Purely presentational; the parent decides when to show it.
 */
import React from 'react';
import { Dimensions, Pressable, StyleSheet, Text } from 'react-native';
import { resolveBubbleRadiusPx, type OrbDeployment, type ResolvedBubbleTheme } from '@fiodos/core';

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
  const fontPx = theme.size;
  const padV = Math.round(fontPx * 0.62);
  const padH = Math.round(fontPx * 0.95);
  const approxHeight = fontPx + padV * 2;
  const radius = resolveBubbleRadiusPx(theme, approxHeight);

  // Horizontal: free side of the orb. RN can't anchor by the right edge
  // without a width, so for the left side we anchor via `right` from the window.
  const horizontal =
    deployment.horizontal === 'left'
      ? { right: Math.max(8, win.width - orbRect.x + 10) }
      : { left: orbRect.x + orbRect.w + 10 };
  // Vertical: FREE corner — orb low → top edge; orb high → bottom edge.
  const vertical =
    deployment.vertical === 'up'
      ? { top: orbRect.y }
      : { top: Math.max(8, orbRect.y + orbRect.h - approxHeight) };

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? text}
      style={({ pressed }) => [
        styles.bubble,
        horizontal,
        vertical,
        {
          backgroundColor: theme.backgroundColor,
          borderColor: theme.borderColor,
          borderWidth: theme.borderWidth,
          borderRadius: radius,
          paddingVertical: padV,
          paddingHorizontal: padH,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text
        numberOfLines={1}
        style={{
          color: theme.textColor,
          fontSize: fontPx,
          fontWeight: '500',
          lineHeight: Math.round(fontPx * 1.25),
          flexShrink: 0,
        }}
      >
        {text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bubble: {
    position: 'absolute',
    maxWidth: 280,
    flexShrink: 0,
    alignSelf: 'flex-start',
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
});
