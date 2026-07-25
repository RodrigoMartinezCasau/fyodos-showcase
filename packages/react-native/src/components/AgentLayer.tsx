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
import {
  resolveBubbleTheme,
  resolveOrbLayerInsets,
  type OrbScreenPosition,
  type ResolvedBubbleTheme,
} from '@fiodos/core';
import { useFiodosRuntime } from '../provider/FiodosProvider';
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
   * as @fiodos/core's resolveOrbLayerInsets and the web/native orbs), so the host
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
  const { config } = useFiodosRuntime();
  const { width, height } = useWindowDimensions();
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  // Dashboard master switch (`orbEnabled`), polled from GET /v1/client/config.
  // Defaults to true (visible) while loading / on error / when nothing is
  // published, so the orb is never hidden by accident. When the developer turns
  // it off in the dashboard, the orb disappears here on the next poll — no host
  // code change — and reappears when switched back on.
  const remote = useRemotePublishedConfig();
  const remoteEnabled = remote.enabled;

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
    visible && remoteEnabled && (!hideWhenKeyboardOpen || !keyboardOpen || textPanelOpen);

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
        bubbleTheme={remote.bubbleTheme}
        bubbleEnabled={remote.bubbleEnabled}
        voiceInputEnabled={remote.voiceInputEnabled}
        voiceOutputEnabled={remote.voiceOutputEnabled}
        conversationRetentionMinutes={remote.conversationRetentionMinutes}
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

interface RemotePublishedConfig {
  /** Master orb visibility (`orbEnabled`). */
  enabled: boolean;
  /** Resolved thought-bubble theme (defaults filled). */
  bubbleTheme: ResolvedBubbleTheme;
  /** Thought-bubble on/off (`bubbleEnabled`). */
  bubbleEnabled: boolean;
  /** Listening on/off (`voiceInputEnabled`). False → tap opens keyboard. */
  voiceInputEnabled: boolean;
  /** Speaking on/off (`voiceOutputEnabled`). False → text-only replies. */
  voiceOutputEnabled: boolean;
  /**
   * Idle context retention in minutes (`conversationRetentionMinutes`).
   * 0 = never clear; null = not published (the SDK's 30-minute default).
   */
  conversationRetentionMinutes: number | null;
}

/**
 * Polls the dashboard-published config (GET /v1/client/config) for the master
 * visibility switch `orbEnabled` and the thought-bubble theme/on-off, the SAME
 * channel used for orb appearance on web/Flutter/Android. `orbEnabled` is false
 * ONLY when the developer explicitly turned the orb off; everything defaults to
 * visible/enabled while loading, on error, or when nothing is published.
 */
function useRemotePublishedConfig(pollMs = 12_000): RemotePublishedConfig {
  const { config } = useFiodosRuntime();
  const [state, setState] = useState<RemotePublishedConfig>({
    enabled: true,
    bubbleTheme: resolveBubbleTheme(null),
    bubbleEnabled: true,
    voiceInputEnabled: true,
    voiceOutputEnabled: true,
    conversationRetentionMinutes: null,
  });

  useEffect(() => {
    const fetcher = config.backend.fetchPublishedConfig;
    if (!fetcher) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetcher.call(config.backend);
        if (cancelled) return;
        const pub = res.published;
        setState({
          enabled: pub ? pub.orbEnabled !== false : true,
          bubbleTheme: resolveBubbleTheme(pub?.bubbleTheme),
          bubbleEnabled: pub ? pub.bubbleEnabled !== false : true,
          voiceInputEnabled: pub ? pub.voiceInputEnabled !== false : true,
          voiceOutputEnabled: pub ? pub.voiceOutputEnabled !== false : true,
          conversationRetentionMinutes:
            typeof pub?.conversationRetentionMinutes === 'number'
              ? pub.conversationRetentionMinutes
              : null,
        });
      } catch {
        // Transient failure (timeout, network blip, backend redeploy…): KEEP
        // the last-known state instead of resetting to defaults, so a long-
        // lived app never silently reverts the published configuration.
      }
    };
    void load();
    const id = setInterval(() => void load(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [config.backend, pollMs]);

  return state;
}
