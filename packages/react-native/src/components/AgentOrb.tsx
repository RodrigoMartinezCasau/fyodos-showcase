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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Image, PanResponder, Pressable, StyleSheet, View } from 'react-native';
import type { OrbDeployment, OrbLogoTransform, ResolvedBubbleTheme } from '@fiodos/core';
import {
  chipBorderRadius,
  chipIconBaseSizePx,
  matchRouteIntent,
  normalizeChipIconScale,
  normalizeKeyboardChipIcon,
  normalizeOrbGlowIntensity,
  resolveBubblePrompt,
  resolveBubbleTheme,
  resolveChipIconColor,
  resolveInnerBorderStrokeColor,
  resolveOrbBackgroundColor,
  resolveOrbDeployment,
  viewportPixelsToOrbScreenPosition,
  ORB_LAYOUT_MARGIN,
} from '@fiodos/core';
import { createRnOrbHaptics, type OrbHapticsFactory } from '../haptics';
import { ChipIconNative } from './ChipIconNative';
import { ChipIconScaled } from './ChipIconScaled';
import { OutwardDoubleBorder, resolveRnOutwardBorderLayout } from './OutwardDoubleBorder';
import { useAgent } from '../hooks/useAgent';
import { useFiodosRuntime } from '../provider/FiodosProvider';
import { resolveImageDataUrlForDisplay, isDisplayableImageUri } from '../utils/imageUri';
import { ActionConfirmationModal } from './ActionConfirmationModal';
import { AgentTextBubble } from './AgentTextBubble';
import { ConsentModal } from './ConsentModal';
import { OrbBubble } from './OrbBubble';
import { OrbThinkingSpinner } from './OrbThinkingSpinner';
import { VoiceWaveform } from './VoiceWaveform';
import { OrbVisual } from './OrbVisual';
import { DEFAULT_ORB_THEME, type AgentModalTheme, type AgentOrbTheme } from './theme';
import { FiodosOrbMark } from './FiodosOrbMark';

export interface AgentOrbProps {
  enabled?: boolean;
  theme?: Partial<AgentOrbTheme>;
  modalTheme?: Partial<AgentModalTheme>;
  /** Idle icon when no logoDataUrl. Default: the neutral Fiodos brand mark. */
  icon?: React.ReactNode;
  /** Published logo — rendered inside OrbVisual above fill (transparent PNG safe). */
  logoDataUrl?: string | null;
  logoTransform?: Partial<OrbLogoTransform> | null;
  /** Press feedback hook (e.g. haptics). */
  onPressFeedback?: () => void;
  /**
   * Override the orb haptics engine. Defaults to the baseline RN `Vibration`
   * engine; the Expo entry injects a gentler, intensity-scaled expo-haptics
   * engine here. Receives an intensity getter (0–100, live from the config).
   */
  hapticsFactory?: OrbHapticsFactory;
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
  /** Published thought-bubble theme. Null/absent → defaults. */
  bubbleTheme?: ResolvedBubbleTheme | null;
  /** Dashboard on/off for the thought bubble. Default true. */
  bubbleEnabled?: boolean;
  /**
   * Dashboard on/off for listening (STT). Default true. When false, tapping
   * opens the keyboard instead of starting to listen. Independent of
   * `voiceOutputEnabled`.
   */
  voiceInputEnabled?: boolean;
  /**
   * Dashboard on/off for speaking back (TTS). Default true. When false,
   * replies are text-only and the chat opens on a voice query.
   */
  voiceOutputEnabled?: boolean;
  /**
   * Idle context retention from the dashboard (minutes; 0 = never clear;
   * null/undefined = the 30-minute default).
   */
  conversationRetentionMinutes?: number | null;
}

export function AgentOrb({
  enabled = true,
  theme,
  modalTheme,
  icon,
  logoDataUrl,
  logoTransform,
  onPressFeedback,
  hapticsFactory,
  consentParagraphs,
  consentWakeWordParagraph,
  textInputEnabled = true,
  textPanelOffset,
  onTextPanelStateChange,
  bubbleTheme,
  bubbleEnabled = true,
  voiceInputEnabled = true,
  voiceOutputEnabled = true,
  conversationRetentionMinutes = null,
}: AgentOrbProps) {
  const { ui, config, messages } = useFiodosRuntime();
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
    recentExchanges,
    hasOlderExchanges,
    loadingOlderExchanges,
    loadOlderExchanges,
    resetExchangeWindow,
    cancelAll,
    consentModalVisible,
    acceptConsent,
    declineConsent,
    confirmationModalVisible,
    confirmationMessage,
    confirmationVoiceHint,
    confirmPendingAction,
    cancelPendingAction,
    wakeWordListening,
    voiceAvailable,
  } = useAgent({ enabled, conversationRetentionMinutes, voiceOutputEnabled });

  const [textOpen, setTextOpen] = useState(false);
  const [textSeed, setTextSeed] = useState<{ text: string; autoSend: boolean } | null>(null);
  /**
   * Ephemeral panel GREETING: the screen's bubble question shown INSIDE the
   * conversation as an assistant message when the panel opens (bubble tap or
   * traditional open). Never enters the history; cleared by the user's first
   * message (or any turn starting) and on close.
   */
  const [panelGreeting, setPanelGreeting] = useState<string | null>(null);
  // A turn in flight (typed OR voice) replaces the ephemeral greeting.
  useEffect(() => {
    if (showThinking) setPanelGreeting(null);
  }, [showThinking]);
  // Mic denied/unavailable: tapping still puts the orb in the "active" visual
  // and reveals the keyboard chip — text is always available (Change 1).
  const [micFallbackActive, setMicFallbackActive] = useState(false);

  // Track the current route so the thought bubble re-resolves its CTA on
  // navigation (RN has no universal nav event → poll the adapter).
  const [currentRoute, setCurrentRoute] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      if (cancelled) return;
      try {
        setCurrentRoute(config.navigation.getCurrentRoute());
      } catch {
        /* navigation read is best-effort */
      }
    };
    read();
    const id = setInterval(read, 700);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [config.navigation]);

  const bubblePrompt = resolveBubblePrompt(
    matchRouteIntent(currentRoute, config.manifest.routes),
    messages,
    { locale: config.locale, actions: config.manifest.actions },
  );
  const resolvedBubbleTheme = bubbleTheme ?? resolveBubbleTheme(null);

  // Subtle haptics on every relevant orb interaction (silent if unsupported).
  // Strength follows the dashboard's advanced "vibration intensity" (0–100).
  // A ref-backed getter lets the (single) haptics engine track the live value
  // as the published config updates, without being recreated.
  const hapticIntensityRef = useRef<number | undefined>(t.hapticIntensity);
  hapticIntensityRef.current = t.hapticIntensity;
  const haptics = useRef(
    (hapticsFactory ?? createRnOrbHaptics)(() => hapticIntensityRef.current),
  ).current;
  const lastPhaseRef = useRef<typeof phase | null>(null);
  useEffect(() => {
    const prev = lastPhaseRef.current;
    if (phase !== prev) {
      if (phase === 'listening') haptics.trigger('listenStart');
      else if (prev === 'listening') haptics.trigger('listenStop');
      if (prev === 'thinking') haptics.trigger('response');
      lastPhaseRef.current = phase;
    }
  }, [phase, haptics]);

  const setTextPanel = useCallback(
    (open: boolean) => {
      setTextOpen(open);
      if (!open) {
        setMicFallbackActive(false);
        setTextSeed(null);
      }
      try {
        onTextPanelStateChange?.(open);
      } catch {
        /* app hook must never break the agent */
      }
    },
    [onTextPanelStateChange],
  );

  // ── Drag (finger) + smart deployment. Session-only: the orb always starts at
  // the dashboard position (host layer) and resets on remount. ────────────────
  const pan = useRef(new Animated.ValueXY()).current;
  const orbBoxRef = useRef<View>(null);
  const draggedRef = useRef(false);
  const [deployment, setDeployment] = useState<OrbDeployment>({ horizontal: 'left', vertical: 'up' });
  // The orb's measured window box. The keyboard chip is rendered in a SEPARATE
  // full-screen overlay (not nested beside the orb), positioned from this box, so
  // it is always hit-testable: a child placed outside its parent's bounds is drawn
  // but never receives touches in React Native (iOS + Android clip touches to the
  // parent frame) — which made the chip "deploy nothing" when tapped.
  const [orbRect, setOrbRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const measureDeploy = useCallback(() => {
    const node = orbBoxRef.current;
    if (!node) return;
    node.measureInWindow((x, y, w, h) => {
      if (!w || !h) return;
      // `measureInWindow` returns the LIVE on-screen box (base layout + the
      // current drag transform). The overlays (bubble/chip) are rendered in a
      // sibling layer that shares the SAME `pan` transform, so we store the
      // orb's BASE box (live minus pan); base + pan then reproduces the live
      // position EVERY FRAME with zero lag while dragging.
      const panX = (pan.x as unknown as { __getValue: () => number }).__getValue();
      const panY = (pan.y as unknown as { __getValue: () => number }).__getValue();
      setOrbRect({ x: x - panX, y: y - panY, w, h });
      const win = Dimensions.get('window');
      const pos = viewportPixelsToOrbScreenPosition({
        centerX: x + w / 2,
        centerY: y + h / 2,
        viewportWidth: win.width,
        viewportHeight: win.height,
        orbDiameter: w,
      });
      setDeployment(resolveOrbDeployment(pos));
    });
  }, [pan.x, pan.y]);

  // AssistiveTouch-style snap: after a drag the orb glides to the nearest
  // left/right edge (vertical drop position preserved). We measure the orb's
  // window box, compute the horizontal delta to the target edge and spring
  // pan.x there; pan.y is untouched so vertical travel stays free.
  const snapToNearestEdge = useCallback(() => {
    const node = orbBoxRef.current;
    if (!node) {
      measureDeploy();
      return;
    }
    node.measureInWindow((x, _y, w) => {
      if (!w) {
        measureDeploy();
        return;
      }
      const win = Dimensions.get('window');
      const centerX = x + w / 2;
      const targetCenterX =
        centerX < win.width / 2
          ? ORB_LAYOUT_MARGIN + w / 2
          : win.width - ORB_LAYOUT_MARGIN - w / 2;
      const deltaX = targetCenterX - centerX;
      const currentX = (pan.x as unknown as { __getValue: () => number }).__getValue();
      Animated.spring(pan.x, {
        toValue: currentX + deltaX,
        useNativeDriver: false,
        bounciness: 4,
        speed: 14,
      }).start(() => measureDeploy());
    });
  }, [measureDeploy, pan.x]);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.hypot(g.dx, g.dy) > 6,
      onPanResponderGrant: () => {
        pan.extractOffset();
      },
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], {
        useNativeDriver: false,
      }),
      onPanResponderRelease: () => {
        draggedRef.current = true;
        pan.flattenOffset();
        snapToNearestEdge();
      },
      onPanResponderTerminate: () => {
        pan.flattenOffset();
        snapToNearestEdge();
      },
    }),
  ).current;

  useEffect(() => {
    // Initial deployment from the dashboard-anchored position.
    const id = setTimeout(measureDeploy, 60);
    return () => clearTimeout(id);
  }, [measureDeploy]);

  const handlePress = () => {
    // Tapping the orb while it is processing CANCELS the in-flight turn (aborts
    // the request, no reply is delivered) and returns the orb to its idle icon.
    if (showThinking) {
      haptics.trigger('orbTap');
      cancelAll();
      return;
    }
    haptics.trigger('orbTap');
    try {
      onPressFeedback?.();
    } catch {
      /* feedback must never break the agent */
    }
    // Mic off: tap opens the keyboard. Speaking back is a separate switch.
    // This branch is intentionally BEFORE the voiceAvailable check so a
    // working mic is still bypassed when listening is disabled.
    if (!voiceInputEnabled && textInputEnabled) {
      setMicFallbackActive(false);
      openTextPanel();
      return;
    }
    if (voiceAvailable && voiceInputEnabled) {
      setMicFallbackActive(false);
      void toggleListening();
      // TTS off: open chat so the text reply is visible.
      if (!voiceOutputEnabled && textInputEnabled) {
        setTextPanel(true);
      }
      return;
    }
    // No microphone: skip the "active + chip" step and open the keyboard +
    // conversation bar DIRECTLY — text is the only useful channel here
    // (Change 2, unified across SDKs).
    if (textInputEnabled) {
      setMicFallbackActive(false);
      openTextPanel();
      return;
    }
    void toggleListening();
  };

  const openTextPanel = (opts?: { seed?: string; autoSend?: boolean }) => {
    // Switching channel: close the microphone before showing the keyboard.
    cancelAll();
    const seed = opts?.seed?.trim();
    setTextSeed(seed ? { text: seed, autoSend: opts?.autoSend ?? false } : null);
    // Welcome the user with this screen's bubble question as an assistant
    // message (both open paths). Ephemeral: gone with the first user message.
    setPanelGreeting(seed ? null : (bubblePrompt ?? null));
    setTextPanel(true);
  };

  // The chip appears next to the ACTIVE orb (real listening OR mic fallback),
  // stays discreet, and disappears while the bubble is open.
  const showKeyboardChip =
    textInputEnabled && !textOpen && (phase === 'listening' || micFallbackActive);
  const orbActive = showWaveform || micFallbackActive;
  // The thought bubble shows ONLY when the orb is idle and free, the dashboard
  // enabled it, and a CTA resolves for the current screen. Tap → text panel.
  const showBubble =
    bubbleEnabled &&
    !!bubblePrompt &&
    !textOpen &&
    !showThinking &&
    !orbActive &&
    phase !== 'speaking';
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

  const wakeDisplayPhrase = config.voiceActivation?.displayPhrase ?? '';
  const wakeListeningLabel = wakeDisplayPhrase
    ? ui.wakeWordListeningLabel.replace('{phrase}', wakeDisplayPhrase)
    : ui.wakeWordListeningLabel.replace('{phrase}', '…');
  const autoWakeConsent =
    config.voiceActivation?.developerEnabled && config.voiceActivation.consentParagraph
      ? config.voiceActivation.consentParagraph
      : undefined;
  const wakeConsentParagraph = consentWakeWordParagraph ?? autoWakeConsent;

  const consentCopy = [
    ...(consentParagraphs ?? [ui.consentBody, ui.consentBodySecondary]),
    ...(wakeConsentParagraph ? [wakeConsentParagraph] : []),
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
        voiceHint={confirmationVoiceHint}
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
          onClose={() => {
            setTextPanel(false);
            setPanelGreeting(null);
            // Collapse the paged history back to the initial page for next open.
            resetExchangeWindow();
          }}
          onSend={(text) => {
            haptics.trigger('send');
            // The greeting is a welcome, not part of the conversation: the
            // user's first real message replaces it.
            setPanelGreeting(null);
            void submitTextTurn(text);
          }}
          onCancel={() => {
            haptics.trigger('orbTap');
            cancelAll();
          }}
          exchanges={recentExchanges}
          hasOlderExchanges={hasOlderExchanges}
          loadingOlderExchanges={loadingOlderExchanges}
          onLoadOlder={loadOlderExchanges}
          busy={showThinking}
          accentColor={t.accentColor}
          theme={modalTheme}
          deployment={deployment}
          bottom={textPanelOffset?.bottom ?? 96}
          right={textPanelOffset?.right ?? 16}
          placeholder={ui.textInputPlaceholder}
          sendLabel={ui.textSendLabel}
          closeLabel={ui.textPanelCloseLabel}
          seedText={textSeed?.text ?? null}
          autoSendSeed={textSeed?.autoSend ?? false}
          onSeedConsumed={() => setTextSeed(null)}
          greetingText={panelGreeting}
          // iOS shows only ONE native Modal at a time: while the consent modal
          // is up, hide this panel's Modal so consent can actually appear (else
          // the screen goes black and the first turn silently stalls). `textOpen`
          // stays true, so after the user accepts, the resumed turn's reply
          // lands right back here.
          suppressed={consentModalVisible}
        />
      ) : null}
      <Animated.View
        {...panResponder.panHandlers}
        style={{
          width: orbLayout.totalPx,
          height: orbLayout.totalPx,
          transform: pan.getTranslateTransform(),
        }}
      >
        <View
          ref={orbBoxRef}
          style={{ width: orbLayout.totalPx, height: orbLayout.totalPx, alignItems: 'center', justifyContent: 'center' }}
        >
        {wakeWordListening ? (
          <View
            accessibilityLabel={wakeListeningLabel}
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
          disabled={!enabled}
          accessibilityRole="button"
          accessibilityLabel={ui.orbAccessibilityLabel}
          accessibilityHint={isListening ? ui.orbHintListening : ui.orbHintIdle}
          style={({ pressed }) => [{ opacity: pressed && enabled ? 0.92 : 1 }]}
        >
          <OrbVisual
            size={t.size}
            theme={t}
            logoDataUrl={logoDataUrl}
            logoTransform={logoTransform}
            showLogo={!showThinking && !orbActive}
            speaking={phase === 'speaking'}
          >
            {showThinking ? (
              <OrbThinkingSpinner
                orbSizePx={t.size}
                color={t.waveformColor ?? t.accentColor}
              />
            ) : orbActive ? (
              <VoiceWaveform
                volume={volumeLevel}
                color={t.waveformColor ?? t.accentColor}
                height={t.waveformHeight}
              />
            ) : logoDataUrl ? null : (
              icon ?? <FiodosOrbMark orbSize={t.size} color={t.waveformColor ?? t.accentColor} />
            )}
          </OrbVisual>
        </Pressable>
        </View>
      </Animated.View>
      {showBubble && bubblePrompt && orbRect ? (
        <Animated.View
          pointerEvents="box-none"
          style={[styles.chipOverlay, { transform: pan.getTranslateTransform() }]}
        >
          <OrbBubble
            text={bubblePrompt}
            theme={resolvedBubbleTheme}
            deployment={deployment}
            orbRect={orbRect}
            accessibilityLabel={ui.orbAccessibilityLabel}
            onPress={() => {
              haptics.trigger('orbTap');
              // The bubble's question moves INTO the panel as an assistant
              // greeting (openTextPanel shows it) — never pre-typed.
              if (textInputEnabled) openTextPanel();
              else void toggleListening();
            }}
          />
        </Animated.View>
      ) : null}
      {showKeyboardChip && orbRect ? (
        <Animated.View
          pointerEvents="box-none"
          style={[styles.chipOverlay, { transform: pan.getTranslateTransform() }]}
        >
          <Pressable
            onPress={() => {
              haptics.trigger('keyboardChip');
              openTextPanel();
            }}
            accessibilityRole="button"
            accessibilityLabel={ui.keyboardChipLabel}
            style={({ pressed }) => [
              styles.keyboardChip,
              {
                ...(deployment.horizontal === 'left'
                  ? { left: orbRect.x - chipLayout.totalPx - 10 }
                  : { left: orbRect.x + orbRect.w + 10 }),
                top: orbRect.y + (orbRect.h - chipLayout.totalPx) / 2,
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
        </Animated.View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  chipOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 130,
  },
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
