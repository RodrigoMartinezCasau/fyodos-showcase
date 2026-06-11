/**
 * AgentOrb — the floating agent button. Visual states: idle icon, recording
 * waveform, thinking spinner. Renders the consent and confirmation modals
 * wired to the orchestrator.
 *
 * Everything app-branded is a prop: accent color, icon, sizes, press
 * feedback (e.g. haptics), accessibility texts (from the locale UI catalog
 * by default).
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useAgent } from '../hooks/useAgent';
import { useFyodosRuntime } from '../provider/FyodosProvider';
import { ActionConfirmationModal } from './ActionConfirmationModal';
import { ConsentModal } from './ConsentModal';
import { VoiceWaveform } from './VoiceWaveform';
import { DEFAULT_ORB_THEME, type AgentModalTheme, type AgentOrbTheme } from './theme';

export interface AgentOrbProps {
  enabled?: boolean;
  theme?: Partial<AgentOrbTheme>;
  modalTheme?: Partial<AgentModalTheme>;
  /** Idle icon (your brand asset). Default: a small accent dot. */
  icon?: React.ReactNode;
  /** Press feedback hook (e.g. haptics). */
  onPressFeedback?: () => void;
  /** Override the consent copy (recommended: name your AI providers). */
  consentParagraphs?: string[];
}

export function AgentOrb({
  enabled = true,
  theme,
  modalTheme,
  icon,
  onPressFeedback,
  consentParagraphs,
}: AgentOrbProps) {
  const { ui } = useFyodosRuntime();
  const t = { ...DEFAULT_ORB_THEME, ...theme };
  const {
    showWaveform,
    showThinking,
    isListening,
    isBusy,
    volumeLevel,
    toggleListening,
    consentModalVisible,
    acceptConsent,
    declineConsent,
    confirmationModalVisible,
    confirmationMessage,
    confirmPendingAction,
    cancelPendingAction,
  } = useAgent({ enabled });

  const handlePress = () => {
    if (showThinking) return;
    try {
      onPressFeedback?.();
    } catch {
      /* feedback must never break the agent */
    }
    void toggleListening();
  };

  return (
    <>
      <ConsentModal
        visible={consentModalVisible}
        onAccept={() => void acceptConsent()}
        onDecline={declineConsent}
        title={ui.consentTitle}
        paragraphs={consentParagraphs ?? [ui.consentBody, ui.consentBodySecondary]}
        acceptLabel={ui.consentAccept}
        declineLabel={ui.consentDecline}
        theme={modalTheme}
      />
      <ActionConfirmationModal
        visible={confirmationModalVisible}
        message={confirmationMessage}
        onConfirm={() => void confirmPendingAction()}
        onCancel={cancelPendingAction}
        title={ui.confirmTitle}
        confirmLabel={ui.confirmLabel}
        cancelLabel={ui.cancelLabel}
        theme={modalTheme}
      />
      <Pressable
        onPress={handlePress}
        disabled={!enabled || showThinking}
        accessibilityRole="button"
        accessibilityLabel={ui.orbAccessibilityLabel}
        accessibilityHint={isListening ? ui.orbHintListening : ui.orbHintIdle}
        accessibilityState={{ selected: isListening }}
        style={({ pressed }) => [
          styles.pressable,
          {
            width: t.size,
            height: t.size,
            borderRadius: t.size / 2,
            borderColor: t.accentColor,
            borderWidth: t.borderWidth,
            backgroundColor: t.backgroundColor,
            opacity: pressed && !isBusy ? 0.92 : 1,
          },
        ]}
      >
        <View style={styles.inner}>
          {showThinking ? (
            <ActivityIndicator size="small" color={t.accentColor} />
          ) : showWaveform ? (
            <VoiceWaveform volume={volumeLevel} color={t.accentColor} height={t.waveformHeight} />
          ) : (
            icon ?? (
              <View
                style={{
                  width: t.size * 0.22,
                  height: t.size * 0.22,
                  borderRadius: t.size * 0.11,
                  backgroundColor: t.accentColor,
                }}
              />
            )
          )}
        </View>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  pressable: {
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  inner: {
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
  },
});
