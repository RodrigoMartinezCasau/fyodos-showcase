/**
 * AgentTextBubble — the orb's text channel: a small, contained conversation
 * bubble anchored near the orb (an expansion of the orb, NOT a full chat).
 *
 * Lightness rules (the SDK must never tax the host app):
 * - Mounted ONLY while open (zero cost when closed).
 * - Shows the CURRENT exchange only — no persistent history, no list
 *   virtualization, no chat framework.
 * - Grows with the reply up to a max height, then scrolls INSIDE the bubble;
 *   the host app stays visible behind.
 *
 * Rendered in a transparent Modal so the system keyboard never displaces the
 * host app's layout and the bubble floats above everything, still anchored to
 * the orb's corner.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { OrbDeployment } from '@fiodos/core';
import type { AgentExchange } from '../hooks/useAgent';
import { DEFAULT_MODAL_THEME, type AgentModalTheme } from './theme';

export interface AgentTextBubbleProps {
  visible: boolean;
  onClose: () => void;
  onSend: (text: string) => void;
  /** Cancel the in-flight turn (pressing STOP while busy). */
  onCancel?: () => void;
  /** Paged window of recent exchanges while session memory is active. */
  exchanges: AgentExchange[];
  /** Older messages exist beyond the mounted window (scroll up to load them). */
  hasOlderExchanges?: boolean;
  /** An older page is being loaded — show the loading row at the top. */
  loadingOlderExchanges?: boolean;
  /** Page one more block of older session messages in (scroll-to-top). */
  onLoadOlder?: () => void;
  /** A turn is in flight: the send button becomes a STOP button. */
  busy: boolean;
  accentColor: string;
  theme?: Partial<AgentModalTheme>;
  /** Anchor: distance from the bottom/right edges (mirrors the orb layer). */
  bottom: number;
  right: number;
  /** Free-side deployment so the bubble never clips off screen. */
  deployment?: OrbDeployment;
  placeholder: string;
  sendLabel: string;
  closeLabel: string;
  /** Pre-fill when opened from the thought-bubble CTA. */
  seedText?: string | null;
  /** Submit the seed as soon as the panel opens. */
  autoSendSeed?: boolean;
  onSeedConsumed?: () => void;
  /**
   * Ephemeral screen-aware greeting shown as an assistant message below the
   * history (the thought bubble's question moved into the panel). The parent
   * clears it when the user sends their first message — it never persists.
   */
  greetingText?: string | null;
  /**
   * Temporarily hide the panel's native Modal WITHOUT unmounting it (the draft
   * and exchange are preserved). Used when another native Modal must take over
   * the screen — iOS only presents ONE Modal at a time, so a second one (e.g.
   * the consent modal) opened while this is visible would not appear (the
   * screen just goes black and the turn silently stalls). The parent flips this
   * on while that modal is up and off again afterwards, so the reply still
   * lands here.
   */
  suppressed?: boolean;
}

export function AgentTextBubble({
  visible,
  onClose,
  onSend,
  onCancel,
  exchanges,
  hasOlderExchanges = false,
  loadingOlderExchanges = false,
  onLoadOlder,
  busy,
  accentColor,
  theme,
  placeholder,
  sendLabel,
  closeLabel,
  seedText,
  autoSendSeed = false,
  onSeedConsumed,
  greetingText,
  suppressed = false,
}: AgentTextBubbleProps) {
  const t = { ...DEFAULT_MODAL_THEME, ...theme };
  // Send button follows the conversation accent (dashboard), falling back to
  // the orb accent so older configs keep working.
  const sendButtonColor = theme?.primaryButtonColor ?? accentColor;
  const [draft, setDraft] = useState('');
  const inputRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);
  const seedAppliedRef = useRef(false);

  // Scroll bookkeeping for the paged history: new messages scroll to the end,
  // but when an older page is PREPENDED (scroll-to-top pagination) the reading
  // position stays anchored instead of jumping back to the bottom.
  const exchangesSignature = exchanges
    .map((ex) => `${ex.userText}\u0000${ex.replyText}`)
    .join('\u0001');
  const renderedSigRef = useRef('');
  const contentHeightRef = useRef(0);
  const scrollOffsetRef = useRef(0);
  const handleContentSizeChange = (_w: number, h: number) => {
    const prev = renderedSigRef.current;
    if (exchangesSignature !== prev) {
      const prepended =
        prev.length > 0 &&
        exchangesSignature.length > prev.length &&
        exchangesSignature.endsWith(prev);
      renderedSigRef.current = exchangesSignature;
      if (prepended) {
        const fromBottom = contentHeightRef.current - scrollOffsetRef.current;
        scrollRef.current?.scrollTo({ y: Math.max(0, h - fromBottom), animated: false });
      } else {
        scrollRef.current?.scrollToEnd({ animated: true });
      }
    }
    contentHeightRef.current = h;
  };

  // Open → focus the input so the system keyboard slides up immediately.
  useEffect(() => {
    if (!visible) {
      seedAppliedRef.current = false;
      setDraft('');
      return;
    }
    if (seedAppliedRef.current) return;
    const text = seedText?.trim();
    if (text) {
      seedAppliedRef.current = true;
      setDraft(text);
      onSeedConsumed?.();
      if (autoSendSeed && !busy) {
        const timer = setTimeout(() => {
          onSend(text);
          setDraft('');
        }, 80);
        return () => clearTimeout(timer);
      }
    }
    const timer = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(timer);
  }, [visible, seedText, autoSendSeed, busy, onSend, onSeedConsumed]);

  if (!visible) return null;

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    onSend(text);
  };

  return (
    <Modal visible={!suppressed} transparent animationType="fade" onRequestClose={onClose}>
      {/* Tapping outside the bubble closes it; the app stays visible behind. */}
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={closeLabel} />
      {/* The conversation bar is ALWAYS anchored to the bottom of the screen,
          just above the keyboard (KeyboardAvoidingView), and centred
          horizontally — never tied to the orb's position. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={[styles.avoider, { justifyContent: 'flex-end', alignItems: 'center' }]}
        pointerEvents="box-none"
      >
        <View
          style={[
            styles.bubble,
            {
              backgroundColor: t.cardBackgroundColor,
              borderColor: t.cardBorderColor,
              borderRadius: t.borderRadius ?? 18,
              marginBottom: 16,
            },
          ]}
        >
          {/* Close button overlaid at the corner — in line with the first message,
              exactly like the dashboard preview (no extra header row/space). */}
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={closeLabel}
            hitSlop={8}
            style={styles.closeBtn}
          >
            <Text style={[styles.closeIcon, { color: t.bodyColor }]}>×</Text>
          </Pressable>
          <ScrollView
            ref={scrollRef}
            style={styles.exchangeScroll}
            contentContainerStyle={styles.exchange}
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={16}
            onScroll={(e) => {
              const y = e.nativeEvent.contentOffset.y;
              scrollOffsetRef.current = y;
              // Reaching the top with older messages available pages the next block in.
              if (y <= 12 && hasOlderExchanges && !loadingOlderExchanges) {
                onLoadOlder?.();
              }
            }}
            onContentSizeChange={handleContentSizeChange}
          >
            {loadingOlderExchanges ? (
              <View style={styles.olderLoaderRow}>
                <ActivityIndicator size="small" color={t.bodyColor} />
              </View>
            ) : null}
            {exchanges.map((ex, index) => (
              <View
                key={`${index}-${ex.userText}`}
                style={[styles.exchangeBlock, index < exchanges.length - 1 ? styles.exchangeBlockGap : null]}
              >
                <Text
                  style={[
                    styles.userText,
                    { color: t.bodyColor },
                    // First row shares the line with the overlaid × — keep clear of it.
                    index === 0 ? styles.userTextFirst : null,
                  ]}
                  selectable
                >
                  {ex.userText}
                </Text>
                {ex.replyText ? (
                  <Text style={[styles.replyText, { color: t.titleColor }]} selectable>
                    {ex.replyText}
                  </Text>
                ) : null}
              </View>
            ))}
            {greetingText ? (
              // Ephemeral screen greeting — assistant styling, below the
              // history, vanishes with the user's first message.
              <Text
                style={[
                  styles.replyText,
                  { color: t.titleColor },
                  // Empty panel: keep clear of the overlaid × on the first line.
                  exchanges.length === 0 ? styles.userTextFirst : null,
                ]}
                selectable
              >
                {greetingText}
              </Text>
            ) : null}
          </ScrollView>
          {busy ? (
            <View style={styles.busyRow}>
              <ActivityIndicator size="small" color={sendButtonColor} />
            </View>
          ) : null}

          <View style={[styles.inputRow, { borderTopColor: t.cardBorderColor }]}>
            <TextInput
              ref={inputRef}
              value={draft}
              onChangeText={setDraft}
              placeholder={placeholder}
              placeholderTextColor={t.bodyColor}
              style={[styles.input, { color: t.titleColor }]}
              multiline
              maxLength={500}
              onSubmitEditing={send}
              blurOnSubmit
              returnKeyType="send"
            />
            <Pressable
              onPress={() => {
                // STOP (cancel) while a turn is processing; SEND otherwise.
                if (busy) {
                  onCancel?.();
                  return;
                }
                send();
              }}
              disabled={!busy && !draft.trim()}
              accessibilityRole="button"
              accessibilityLabel={busy ? closeLabel : sendLabel}
              style={({ pressed }) => [
                styles.sendBtn,
                {
                  backgroundColor: sendButtonColor,
                  borderRadius: t.sendButtonRadius ?? 16,
                  opacity: !busy && !draft.trim() ? 0.35 : pressed ? 0.8 : 1,
                },
              ]}
            >
              {busy ? (
                <View style={styles.stopSquare} />
              ) : (
                <Text style={styles.sendIcon}>↑</Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  avoider: {
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
  },
  bubble: {
    width: 300,
    maxWidth: '88%',
    maxHeight: 340,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  closeBtn: {
    position: 'absolute',
    top: 4,
    right: 6,
    zIndex: 1,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeIcon: {
    fontSize: 18,
    lineHeight: 18,
    opacity: 0.75,
  },
  exchangeBlock: {
    gap: 8,
  },
  exchangeBlockGap: {
    marginBottom: 10,
  },
  exchangeScroll: {
    flexGrow: 0,
  },
  exchange: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 8,
  },
  userText: {
    fontSize: 13,
    lineHeight: 18,
    opacity: 0.75,
  },
  userTextFirst: {
    paddingRight: 22,
  },
  replyText: {
    fontSize: 15,
    lineHeight: 21,
  },
  busyRow: {
    paddingVertical: 8,
    alignItems: 'center',
  },
  olderLoaderRow: {
    paddingBottom: 6,
    alignItems: 'center',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
    maxHeight: 90,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  sendBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendIcon: {
    color: '#000',
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 20,
  },
  stopSquare: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: '#000',
  },
});
