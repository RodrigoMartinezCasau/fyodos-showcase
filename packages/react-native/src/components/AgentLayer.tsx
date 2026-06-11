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
import { Keyboard, Platform, StyleSheet, View } from 'react-native';
import { useFyodosRuntime } from '../provider/FyodosProvider';
import { AgentOrb, type AgentOrbProps } from './AgentOrb';

export interface AgentLayerProps {
  /** App-level visibility (auth, hidden routes…). */
  visible: boolean;
  /** Distance from the bottom edge to the orb (app computes safe areas). */
  bottom: number;
  /** Distance from the right edge. */
  right?: number;
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
  hideWhenKeyboardOpen = true,
  warmUpOnVisible = true,
  orbProps,
}: AgentLayerProps) {
  const { config } = useFyodosRuntime();
  const [keyboardOpen, setKeyboardOpen] = useState(false);

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

  const effectiveVisible = visible && (!hideWhenKeyboardOpen || !keyboardOpen);

  useEffect(() => {
    if (!effectiveVisible || !warmUpOnVisible) return;
    void config.backend.warmUp?.();
  }, [effectiveVisible, warmUpOnVisible, config.backend]);

  if (!effectiveVisible) return null;

  return (
    <View pointerEvents="box-none" style={[styles.layer, { bottom, right }]}>
      <AgentOrb enabled={effectiveVisible} {...orbProps} />
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    zIndex: 120,
  },
});
