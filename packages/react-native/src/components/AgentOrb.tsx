/**
 * AgentOrb — the floating agent button. Visual states: idle icon, recording
 * waveform, thinking spinner. Renders the consent and confirmation modals
 * wired to the orchestrator.
 *
 * Text channel: while the orb is active (listening), a discreet keyboard
 * chip appears next to it. Tapping it stops the microphone and opens the
 * AgentTextBubble (typed input + text reply) — voice stays the default mode,
 * text is an opt-in expansion of the orb.
 *
 * Everything app-branded is a prop: accent color, icon, sizes, press
 * feedback (e.g. haptics), accessibility texts (from the locale UI catalog
 * by default).
 */
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAgent } from '../hooks/useAgent';
import { useFyodosRuntime } from '../provider/FyodosProvider';
import { ActionConfirmationModal } from './ActionConfirmationModal';
import { AgentTextBubble } from './AgentTextBubble';
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
  /** Show the keyboard chip / text bubble channel. Default true. */
  textInputEnabled?: boolean;
  /** Anchor of the text bubble (mirrors the orb layer offsets). */
  textPanelOffset?: { bottom: number; right: number };
  /** Notifies the layer so it does not hide the orb while typing. */
  onTextPanelStateChange?: (open: boolean) => void;
}

export function AgentOrb({
  enabled = true,
  theme,
  modalTheme,
  icon,
  onPressFeedback,
  consentParagraphs,
  textInputEnabled = true,
  textPanelOffset,
  onTextPanelStateChange,
}: AgentOrbProps) {
  const { ui } = useFyodosRuntime();
  const t = { ...DEFAULT_ORB_THEME, ...theme };
  const {
    phase,
    showWaveform,
    showThinking,
    isListening,
    isBusy,
    volumeLevel,
    toggleListening,
    submitTextTurn,
    lastExchange,
    cancelAll,
    consentModalVisible,
    acceptConsent,
    declineConsent,
    confirmationModalVisible,
    confirmationMessage,
    confirmPendingAction,
    cancelPendingAction,
  } = useAgent({ enabled });

  const [textOpen, setTextOpen] = useState(false);

  const setTextPanel = useCallback(
    (open: boolean) => {
      setTextOpen(open);
      try {
        onTextPanelStateChange?.(open);
      } catch {
        /* app hook must never break the agent */
      }
    },
    [onTextPanelStateChange],
  );

  const handlePress = () => {
    if (showThinking) return;
    try {
      onPressFeedback?.();
    } catch {
      /* feedback must never break the agent */
    }
    void toggleListening();
  };

  const openTextPanel = () => {
    // Switching channel: close the microphone before showing the keyboard.
    cancelAll();
    setTextPanel(true);
  };

  // The chip appears next to the ACTIVE orb (listening), stays discreet, and
  // disappears while the bubble is open. Voice remains the default mode.
  const showKeyboardChip = textInputEnabled && !textOpen && phase === 'listening';

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
      {textInputEnabled ? (
        <AgentTextBubble
          visible={textOpen}
          onClose={() => setTextPanel(false)}
          onSend={(text) => void submitTextTurn(text)}
          exchange={lastExchange}
          busy={showThinking}
          accentColor={t.accentColor}
          theme={modalTheme}
          bottom={textPanelOffset?.bottom ?? 96}
          right={textPanelOffset?.right ?? 16}
          placeholder={ui.textInputPlaceholder}
          sendLabel={ui.textSendLabel}
          closeLabel={ui.textPanelCloseLabel}
        />
      ) : null}
      {showKeyboardChip ? (
        <Pressable
          onPress={openTextPanel}
          accessibilityRole="button"
          accessibilityLabel={ui.keyboardChipLabel}
          style={({ pressed }) => [
            styles.keyboardChip,
            {
              right: t.size + 10,
              top: (t.size - 30) / 2,
              backgroundColor: t.backgroundColor,
              borderColor: t.accentColor,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <Text style={[styles.keyboardChipIcon, { color: t.accentColor }]}>⌨</Text>
        </Pressable>
      ) : null}
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
  keyboardChip: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 4,
  },
  keyboardChipIcon: {
    fontSize: 15,
    lineHeight: 17,
  },
});
