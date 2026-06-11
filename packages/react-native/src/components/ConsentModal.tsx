/**
 * Voice-assistant consent modal (Apple 5.1.2(i) + GDPR). Shown the first
 * time the user taps the orb; until they accept, no speech recognition runs
 * and nothing is sent to AI providers.
 *
 * Copy comes from the locale UI catalog by default. Integrators SHOULD
 * override `paragraphs` to name the concrete AI providers and data categories
 * their app shares (GDPR transparency requirement).
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { DEFAULT_MODAL_THEME, type AgentModalTheme } from './theme';

export interface ConsentModalProps {
  visible: boolean;
  onAccept: () => void;
  onDecline: () => void;
  title: string;
  paragraphs: string[];
  acceptLabel: string;
  declineLabel: string;
  theme?: Partial<AgentModalTheme>;
}

export function ConsentModal({
  visible,
  onAccept,
  onDecline,
  title,
  paragraphs,
  acceptLabel,
  declineLabel,
  theme,
}: ConsentModalProps) {
  const t = { ...DEFAULT_MODAL_THEME, ...theme };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDecline}>
      <View style={[styles.backdrop, { backgroundColor: t.backdropColor }]}>
        <View
          style={[
            styles.card,
            { backgroundColor: t.cardBackgroundColor, borderColor: t.cardBorderColor },
          ]}
        >
          <Text style={[styles.title, { color: t.titleColor }]}>{title}</Text>
          {paragraphs.map((paragraph, i) => (
            <Text key={i} style={[styles.body, { color: t.bodyColor }]}>
              {paragraph}
            </Text>
          ))}
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: t.primaryButtonColor },
              pressed && styles.pressed,
            ]}
            onPress={onAccept}
          >
            <Text style={[styles.primaryLabel, { color: t.primaryLabelColor }]}>
              {acceptLabel}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.secondaryButton,
              { backgroundColor: t.secondaryButtonColor },
              pressed && styles.pressed,
            ]}
            onPress={onDecline}
          >
            <Text style={[styles.secondaryLabel, { color: t.secondaryLabelColor }]}>
              {declineLabel}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 22,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  primaryButton: {
    marginTop: 6,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryLabel: {
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryButton: {
    marginTop: 10,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.85,
  },
});
