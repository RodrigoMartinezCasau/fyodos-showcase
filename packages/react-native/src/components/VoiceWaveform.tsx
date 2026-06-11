/**
 * Animated audio visualizer for the recording state. 9 vertical bars reacting
 * to the volume level (0–1); gentle "breathing" animation when silent.
 *
 * PERFORMANCE (heavy-screen lag fix, preserved from production):
 * - Animates `scaleY` with useNativeDriver: the animation runs on the UI
 *   thread and never competes with the app's JS thread.
 * - The loop is created ONCE; volume enters via ref. Re-creating the interval
 *   per volume change used to fire 9 JS springs at 7 Hz.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

const BAR_COUNT = 9;

/** Relative base heights — bell shape, tallest at the center. */
const BASE_PROFILE = [0.25, 0.45, 0.65, 0.85, 1.0, 0.85, 0.65, 0.45, 0.25];

/** Phase offsets so idle bars oscillate independently. */
const IDLE_PHASES = [0, 0.7, 1.4, 2.1, 2.8, 2.1, 1.4, 0.7, 0.0];

/** Loop tick (ms). Native springs interpolate between ticks. */
const TICK_MS = 120;

export interface VoiceWaveformProps {
  /** Normalized volume level 0–1. */
  volume: number;
  /** Bar color (theme accent). */
  color: string;
  /** Total component height in px. */
  height?: number;
}

export const VoiceWaveform = React.memo(function VoiceWaveform({
  volume,
  color,
  height = 32,
}: VoiceWaveformProps) {
  const MIN_H = 3;
  const MAX_H = height;
  const minScale = MIN_H / MAX_H;

  // scaleY 0–1 over fixed-height bars (native-driver compatible).
  const bars = useRef(
    Array.from({ length: BAR_COUNT }, () => new Animated.Value(minScale)),
  ).current;

  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  const tickRef = useRef(0);

  useEffect(() => {
    const animate = () => {
      tickRef.current += 0.22;
      const t = tickRef.current;
      const vol = volumeRef.current;
      bars.forEach((bar, i) => {
        let target: number;
        if (vol < 0.05) {
          const sine = (Math.sin(t + (IDLE_PHASES[i] ?? 0)) + 1) / 2;
          target = minScale + sine * (0.22 - minScale);
        } else {
          // Volume-reactive + per-bar noise to simulate live speech.
          const noise =
            Math.sin(t * 2.3 + (IDLE_PHASES[i] ?? 0)) * 0.18 + 0.82 + Math.random() * 0.18;
          target = minScale + vol * (BASE_PROFILE[i] ?? 0.5) * (1 - minScale) * noise;
        }

        Animated.spring(bar, {
          toValue: Math.min(1, Math.max(minScale, target)),
          useNativeDriver: true,
          tension: vol < 0.05 ? 40 : 120,
          friction: 6,
          overshootClamping: true,
        }).start();
      });
    };

    const interval = setInterval(animate, TICK_MS);
    animate();
    return () => clearInterval(interval);
    // Single loop: volume via ref, never re-create the interval per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, minScale]);

  return (
    <View style={[styles.container, { height }]}>
      {bars.map((scaleY, i) => (
        <Animated.View
          key={i}
          style={[styles.bar, { backgroundColor: color, height: MAX_H, transform: [{ scaleY }] }]}
        />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  bar: {
    width: 3,
    borderRadius: 2,
  },
});
