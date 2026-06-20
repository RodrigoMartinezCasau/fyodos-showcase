/**
 * AgentLayer — floating layer that positions the orb over the app's chrome.
 *
 * Visibility is the APP's decision (auth state, hidden routes, entry
 * animations…): pass `visible`. The layer adds the keyboard heuristic
 * (hide while typing) and best-effort backend warm-up when shown.
 *
 * Positioning is explicit: the app computes `bottom` with its own safe-area
 * and bottom-bar layout (no layout assumptions in the SDK).
 */
import React, { useEffect, useState } from 'react';
import { Keyboard, Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { resolveOrbLayerInsets, type OrbScreenPosition } from '@fyodos/core';
import { useFyodosRuntime } from '../provider/FyodosProvider';
import { AgentOrb, type AgentOrbProps } from './AgentOrb';

export interface AgentLayerProps {
  /** App-level visibility (auth, hidden routes…). */
  visible: boolean;
  /** Distance from the bottom edge to the orb (app computes safe areas). Used as
   *  the fallback when `screenPosition` is not provided. */
  bottom: number;
  /** Distance from the right edge. */
  right?: number;
  /**
   * Dashboard-published NORMALIZED position (0–1). When provided, the SDK places
   * the orb itself at the precise relative point on ANY screen size (same model
   * as @fyodos/core's resolveOrbLayerInsets and the web/native orbs), so the host
   * does not have to compute insets by hand. `bottom`/`right` stay as the
   * fallback when it is absent. Pass the app's safe-area insets so the position
   * stays inside notches/home indicators.
   */
  screenPosition?: OrbScreenPosition | null;
  /** Orb diameter used for the precise-position math. Default 56. */
  orbDiameter?: number;
  /** Safe-area insets for the precise-position math (default 0). */
  safeArea?: { top?: number; bottom?: number; left?: number; right?: number };
  /** Hide while the keyboard is open. Default true. */
  hideWhenKeyboardOpen?: boolean;
  /** Warm the backend up when the layer becomes visible. Default true. */
  warmUpOnVisible?: boolean;
  orbProps?: Omit<AgentOrbProps, 'enabled'>;
}

export function AgentLayer({
  visible,
  bottom,
  right = 16,
  screenPosition,
  orbDiameter = 56,
  safeArea,
  hideWhenKeyboardOpen = true,
  warmUpOnVisible = true,
  orbProps,
}: AgentLayerProps) {
  const { config } = useFyodosRuntime();
  const { width, height } = useWindowDimensions();
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  // When the dashboard position is provided, the SDK self-resolves precise insets
  // (normalized → pixels for this exact screen) so "where the developer placed it"
  // appears faithfully on any device. Otherwise we keep the host-supplied insets.
  const resolved = screenPosition
    ? resolveOrbLayerInsets({
        viewportWidth: width,
        viewportHeight: height,
        safeAreaTop: safeArea?.top ?? 0,
        safeAreaBottom: safeArea?.bottom ?? 0,
        safeAreaLeft: safeArea?.left ?? 0,
        safeAreaRight: safeArea?.right ?? 0,
        orbDiameter,
        position: screenPosition,
      })
    : null;
  const effectiveBottom = resolved ? resolved.bottom : bottom;
  const effectiveRight = resolved ? resolved.right : right;
  /**
   * The orb's own text bubble opens the system keyboard: in that case the
   * keyboard heuristic must NOT hide the layer (it would unmount the orb and
   * the bubble with it). The heuristic only applies to the APP's inputs.
   */
  const [textPanelOpen, setTextPanelOpen] = useState(false);

  useEffect(() => {
    if (!hideWhenKeyboardOpen) return;
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => setKeyboardOpen(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardOpen(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [hideWhenKeyboardOpen]);

  const effectiveVisible =
    visible && (!hideWhenKeyboardOpen || !keyboardOpen || textPanelOpen);

  useEffect(() => {
    if (!effectiveVisible || !warmUpOnVisible) return;
    void config.backend.warmUp?.();
  }, [effectiveVisible, warmUpOnVisible, config.backend]);

  if (!effectiveVisible) return null;

  return (
    // Full-screen, touch-transparent layer. The orb is anchored to its corner via
    // padding so it stays where the app placed it, but the layer spans the whole
    // screen so the keyboard chip (rendered beside the orb in a sibling overlay)
    // is never clipped out of the hit-testable area. `box-none` lets every touch
    // that doesn't land on an actual child pass through to the app behind.
    <View
      pointerEvents="box-none"
      style={[
        styles.layer,
        { paddingBottom: effectiveBottom, paddingRight: effectiveRight, alignItems: 'flex-end', justifyContent: 'flex-end' },
      ]}
    >
      <AgentOrb
        enabled={effectiveVisible}
        textPanelOffset={{ bottom: effectiveBottom + 64, right: effectiveRight }}
        onTextPanelStateChange={setTextPanelOpen}
        {...orbProps}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 120,
  },
});
