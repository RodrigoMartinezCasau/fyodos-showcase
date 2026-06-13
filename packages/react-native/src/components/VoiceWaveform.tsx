/**
 * Animated audio visualizer for the recording state.
 * Uses height animation (no native driver) — scaleY + native driver crashes on RN 0.81 Fabric.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

const BAR_COUNT = 9;
const BASE_PROFILE = [0.25, 0.45, 0.65, 0.85, 1.0, 0.85, 0.65, 0.45, 0.25];
const IDLE_PHASES = [0, 0.7, 1.4, 2.1, 2.8, 2.1, 1.4, 0.7, 0.0];
const TICK_MS = 120;

export interface VoiceWaveformProps {
  volume: number;
  color: string;
  height?: number;
}

export const VoiceWaveform = React.memo(function VoiceWaveform({
  volume,
  color,
  height = 32,
}: VoiceWaveformProps) {
  const MIN_H = 3;
  const MAX_H = height;

  const bars = useRef(
    Array.from({ length: BAR_COUNT }, () => new Animated.Value(MIN_H)),
  ).current;

  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const tickRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    const animate = () => {
      if (cancelled) return;
      tickRef.current += 0.22;
      const t = tickRef.current;
      const vol = volumeRef.current;

      bars.forEach((bar, i) => {
        let normalized: number;
        if (vol < 0.05) {
          const sine = (Math.sin(t + (IDLE_PHASES[i] ?? 0)) + 1) / 2;
          normalized = 0.08 + sine * 0.14;
        } else {
          const noise =
            Math.sin(t * 2.3 + (IDLE_PHASES[i] ?? 0)) * 0.18 + 0.82 + Math.random() * 0.18;
          normalized = vol * (BASE_PROFILE[i] ?? 0.5) * noise;
        }
        const targetH = MIN_H + normalized * (MAX_H - MIN_H);
        Animated.timing(bar, {
          toValue: Math.min(MAX_H, Math.max(MIN_H, targetH)),
          duration: TICK_MS,
          useNativeDriver: false,
        }).start();
      });
    };

    const interval = setInterval(animate, TICK_MS);
    animate();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [bars, MAX_H]);

  return (
    <View style={[styles.container, { height: MAX_H }]}>
      {bars.map((barHeight, i) => (
        <Animated.View
          key={i}
          style={[styles.bar, { backgroundColor: color, height: barHeight }]}
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
