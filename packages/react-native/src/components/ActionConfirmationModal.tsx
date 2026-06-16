/**
 * Light confirmation modal for sensitive agent actions. Tap outside or the
 * back button = cancel. Texts come from the locale UI catalog (overridable
 * via props); colors from the modal theme.
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, Text } from 'react-native';
import { DEFAULT_MODAL_THEME, type AgentModalTheme } from './theme';

export interface ActionConfirmationModalProps {
  visible: boolean;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  confirmLabel: string;
  cancelLabel: string;
  theme?: Partial<AgentModalTheme>;
  /**
   * Strict-action only: the exact phrase the user must say to confirm BY VOICE.
   * Shown as a discreet hint under the message (the tap button always works).
   */
  voiceHint?: string | null;
}

export function ActionConfirmationModal({
  visible,
  message,
  onConfirm,
  onCancel,
  title,
  confirmLabel,
  cancelLabel,
  theme,
  voiceHint,
}: ActionConfirmationModalProps) {
  const t = { ...DEFAULT_MODAL_THEME, ...theme };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        style={[styles.backdrop, { backgroundColor: t.backdropColor }]}
        onPress={onCancel}
      >
        {/* Inner pressable: taps inside the card must not cancel. */}
        <Pressable
          style={[
            styles.card,
            { backgroundColor: t.cardBackgroundColor, borderColor: t.cardBorderColor },
          ]}
          onPress={() => {}}
        >
          <Text style={[styles.title, { color: t.titleColor }]}>{title}</Text>
          <Text style={[styles.body, { color: t.bodyColor }]}>{message}</Text>
          {voiceHint ? (
            <Text style={[styles.voiceHint, { color: t.bodyColor }]}>{voiceHint}</Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: t.primaryButtonColor },
              pressed && styles.pressed,
            ]}
            onPress={onConfirm}
          >
            <Text style={[styles.primaryLabel, { color: t.primaryLabelColor }]}>
              {confirmLabel}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.secondaryButton,
              { backgroundColor: t.secondaryButtonColor },
              pressed && styles.pressed,
            ]}
            onPress={onCancel}
          >
            <Text style={[styles.secondaryLabel, { color: t.secondaryLabelColor }]}>
              {cancelLabel}
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
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
  voiceHint: {
    fontSize: 13,
    lineHeight: 18,
    fontStyle: 'italic',
    opacity: 0.8,
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
