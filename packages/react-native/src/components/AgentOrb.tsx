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
import React, { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import type { OrbLogoTransform } from '@fyodos/core';
import {
  chipBorderRadius,
  chipIconBaseSizePx,
  normalizeChipIconScale,
  normalizeKeyboardChipIcon,
  normalizeOrbGlowIntensity,
  resolveChipIconColor,
  resolveInnerBorderStrokeColor,
  resolveOrbBackgroundColor,
} from '@fyodos/core';
import { ChipIconNative } from './ChipIconNative';
import { ChipIconScaled } from './ChipIconScaled';
import { OutwardDoubleBorder, resolveRnOutwardBorderLayout } from './OutwardDoubleBorder';
import { useAgent } from '../hooks/useAgent';
import { useFyodosRuntime } from '../provider/FyodosProvider';
import { resolveImageDataUrlForDisplay, isDisplayableImageUri } from '../utils/imageUri';
import { ActionConfirmationModal } from './ActionConfirmationModal';
import { AgentTextBubble } from './AgentTextBubble';
import { ConsentModal } from './ConsentModal';
import { OrbThinkingSpinner } from './OrbThinkingSpinner';
import { VoiceWaveform } from './VoiceWaveform';
import { OrbVisual } from './OrbVisual';
import { DEFAULT_ORB_THEME, type AgentModalTheme, type AgentOrbTheme } from './theme';

export interface AgentOrbProps {
  enabled?: boolean;
  theme?: Partial<AgentOrbTheme>;
  modalTheme?: Partial<AgentModalTheme>;
  /** Idle icon when no logoDataUrl. Default: a small accent dot. */
  icon?: React.ReactNode;
  /** Published logo — rendered inside OrbVisual above fill (transparent PNG safe). */
  logoDataUrl?: string | null;
  logoTransform?: Partial<OrbLogoTransform> | null;
  /** Press feedback hook (e.g. haptics). */
  onPressFeedback?: () => void;
  /** Override the consent copy (recommended: name your AI providers). */
  consentParagraphs?: string[];
  /** Show the keyboard chip / text bubble channel. Default true. */
  textInputEnabled?: boolean;
  /** Extra consent paragraph when wake-word activation is offered by the developer. */
  consentWakeWordParagraph?: string;
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
  logoDataUrl,
  logoTransform,
  onPressFeedback,
  consentParagraphs,
  consentWakeWordParagraph,
  textInputEnabled = true,
  textPanelOffset,
  onTextPanelStateChange,
}: AgentOrbProps) {
  const { ui } = useFyodosRuntime();
  const t = {
    ...DEFAULT_ORB_THEME,
    ...theme,
    backgroundColor: resolveOrbBackgroundColor({
      colorKey: theme?.colorKey,
      accentColor: theme?.accentColor,
      backgroundColor: theme?.backgroundColor,
    }),
  };
  const {
    phase,
    showWaveform,
    showThinking,
    isListening,
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
    wakeWordListening,
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
  const chip = t.keyboardChip ?? {};
  const chipSize = chip.size ?? 30;
  const chipShape = chip.shape ?? 'circle';
  const chipCornerRadius = chipShape === 'circle' ? 'circle' as const : chipBorderRadius(chipShape, chipSize);
  const chipBg = chip.backgroundColor ?? t.backgroundColor;
  const chipBorder = chip.borderColor ?? t.accentColor;
  const chipIconColor = resolveChipIconColor(chip.iconColor, chipBg, t.accentColor);
  const chipIconPreset = normalizeKeyboardChipIcon(chip.icon);
  const chipIconScale = normalizeChipIconScale(chip.iconScale ?? 1);
  const chipIconBase = chipIconBaseSizePx(chipSize);
  const chipLayout = resolveRnOutwardBorderLayout(
    chipSize,
    chip.borderWidth ?? 100,
    chip.innerBorderWidth,
  );
  const orbLayout = resolveRnOutwardBorderLayout(
    t.size,
    t.glowIntensity,
    t.innerBorderWidth,
  );
  const chipInteriorColor = resolveInnerBorderStrokeColor(chip.innerBorderColor);
  const rawChipIcon = chip.iconImageDataUrl?.trim() || null;
  const [chipIconUri, setChipIconUri] = useState<string | null>(null);
  const [chipIconFailed, setChipIconFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setChipIconFailed(false);
    if (!rawChipIcon) {
      setChipIconUri(null);
      return;
    }
    void resolveImageDataUrlForDisplay(rawChipIcon, 'fyodos-chip-icon.png').then((uri) => {
      if (!cancelled) setChipIconUri(uri);
    });
    return () => {
      cancelled = true;
    };
  }, [rawChipIcon]);

  const showChipImage = isDisplayableImageUri(chipIconUri) && !chipIconFailed;

  const consentCopy = [
    ...(consentParagraphs ?? [ui.consentBody, ui.consentBodySecondary]),
    ...(consentWakeWordParagraph ? [consentWakeWordParagraph] : []),
  ];

  return (
    <>
      <ConsentModal
        visible={consentModalVisible}
        onAccept={() => void acceptConsent()}
        onDecline={declineConsent}
        title={ui.consentTitle}
        paragraphs={consentCopy}
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
              right: orbLayout.totalPx + 10,
              top: (orbLayout.totalPx - chipLayout.totalPx) / 2,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <OutwardDoubleBorder
            fillDiameter={chipSize}
            cornerRadius={chipCornerRadius}
            exteriorColor={chipBorder}
            exteriorWidthSlider={chip.borderWidth ?? 100}
            interiorColor={chipInteriorColor}
            interiorWidthSlider={chip.innerBorderWidth}
            fillColor={chipBg}
          >
            <ChipIconScaled chipSize={chipSize} baseSize={chipIconBase} scale={chipIconScale}>
              {showChipImage ? (
                <Image
                  source={{ uri: chipIconUri! }}
                  style={{ width: chipIconBase, height: chipIconBase, alignSelf: 'center' }}
                  resizeMode="contain"
                  accessibilityIgnoresInvertColors
                  onError={() => setChipIconFailed(true)}
                />
              ) : (
                <ChipIconNative icon={chipIconPreset} size={chipIconBase} color={chipIconColor} />
              )}
            </ChipIconScaled>
          </OutwardDoubleBorder>
        </Pressable>
      ) : null}
      <View style={{ width: orbLayout.totalPx, height: orbLayout.totalPx, alignItems: 'center', justifyContent: 'center' }}>
        {wakeWordListening ? (
          <View
            accessibilityLabel={ui.wakeWordListeningLabel}
            accessibilityRole="text"
            style={[
              styles.wakeIndicator,
              {
                top: -2,
                right: -2,
                borderColor: t.accentColor,
                backgroundColor: t.backgroundColor,
              },
            ]}
          >
            <View style={[styles.wakeDot, { backgroundColor: t.accentColor }]} />
          </View>
        ) : null}
        <Pressable
          onPress={handlePress}
          disabled={!enabled || showThinking}
          accessibilityRole="button"
          accessibilityLabel={ui.orbAccessibilityLabel}
          accessibilityHint={isListening ? ui.orbHintListening : ui.orbHintIdle}
          style={({ pressed }) => [{ opacity: pressed && enabled && !showThinking ? 0.92 : 1 }]}
        >
          <OrbVisual
            size={t.size}
            theme={t}
            logoDataUrl={logoDataUrl}
            logoTransform={logoTransform}
            showLogo={!showThinking && !showWaveform}
            speaking={phase === 'speaking'}
          >
            {showThinking ? (
              <OrbThinkingSpinner
                orbSizePx={t.size}
                color={t.waveformColor ?? t.accentColor}
              />
            ) : showWaveform ? (
              <VoiceWaveform
                volume={volumeLevel}
                color={t.waveformColor ?? t.accentColor}
                height={t.waveformHeight}
              />
            ) : logoDataUrl ? null : (
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
          </OrbVisual>
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  keyboardChip: {
    position: 'absolute',
    alignItems: 'stretch',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 4,
  },
  wakeIndicator: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  wakeDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
});
