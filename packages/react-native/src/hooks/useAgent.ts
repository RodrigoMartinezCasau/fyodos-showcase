/**
 * useAgent — the agent orchestrator (hold-to-talk → STT → backend → action →
 * TTS), ported from a production app and fully decoupled from it.
 *
 * Phase machine: idle / listening / thinking / speaking / confirming.
 *
 * Production hardening preserved verbatim:
 * - THINKING WATCHDOG: 'thinking' can never outlive the watchdog. Root cause:
 *   stopping the recording sets phase='thinking' BEFORE the transcript
 *   exists; if the native STT emits neither 'end' nor 'error' (seen on iOS
 *   after several recognition+TTS sessions), no path resets the phase and the
 *   orb ignores taps forever. The watchdog guarantees recovery.
 * - 'confirming' is a SEPARATE phase from 'thinking' on purpose: the watchdog
 *   must not kill the voice-confirmation window, and the normal turn cycle
 *   does not apply to it.
 * - Double validation: the confirmation source of truth is the MANIFEST,
 *   never the LLM's requireConfirmation flag.
 * - Precheck (context + idempotency) BEFORE showing the confirmation modal.
 * - The structured screen snapshot is captured AT INVOCATION: execute actions
 *   operate on what the user was viewing when they spoke.
 * - If an execute action turns out idempotent or fails, the LLM's reply
 *   ("Done!") would be false → the handler's real message is spoken instead
 *   with device TTS.
 * - Negation wins ties in voice confirmation; ambiguous re-asks ONCE.
 * - Tap decision (modal) always wins over the voice window.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildBubbleExchangeWindow,
  BUBBLE_PAGE_EXCHANGES,
  classifyConfirmationReply,
  conversationRetentionOptions,
  classifyStrictConfirmationReply,
  combineContexts,
  createConversationSession,
  formatMessage,
  persistConversationSession,
  prepareConversationForTurn,
  recordConversationExchange,
  restoreConversationSession,
  stripWakePhrase,
  defaultWakePhrasesForLocale,
  type AgentAction,
  type AgentScreenContext,
  type AgentTurnResult,
  type ChainStepInfo,
} from '@fiodos/core';
import { isAgentApiError } from '../api/errors';
import { buildManifestPayload } from '../api/backendClient';
import type { AgentPhase } from '../config/types';
import { useFiodosRuntime } from '../provider/FiodosProvider';
import { useSpeechSession } from '../voice/useSpeechSession';
import { useWakeWordActivation } from '../voice/useWakeWordActivation';

declare const __DEV__: boolean;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type PendingConfirmation = {
  action: AgentAction;
  context: AgentScreenContext;
  userMessage: string;
  routeAtInvocation: string | null;
  latencyMs: number;
  latencySttMs: number | null;
  wasTruncated: boolean;
  contextChars: number;
  redactions: string[];
  /** 2 for actions declaring doubleConfirmation; 1 otherwise. */
  remainingConfirmations: number;
  /**
   * Voice resolution mode from the MANIFEST (dashboard-governed):
   * 'standard' yes/no, 'strict' exact phrase, 'disabled' tap-only.
   */
  voiceMode: 'standard' | 'strict' | 'disabled';
  /** Strict mode: the exact phrase that confirms (null otherwise). */
  strictPhrase: string | null;
  /** Turn started from typed text in silent mode: no TTS, no voice window. */
  silent: boolean;
};

/** The current exchange, for the text bubble UI (no persistent history). */
export interface AgentExchange {
  userText: string;
  replyText: string;
}

export interface UseAgentOptions {
  enabled?: boolean;
  /**
   * Idle context retention from the dashboard (minutes; 0 = never clear;
   * null/undefined = the 30-minute default).
   */
  conversationRetentionMinutes?: number | null;
}

/**
 * How the pending consent flow was entered. When the user accepts consent the
 * agent resumes the SAME flow: voice re-opens the microphone, text re-submits
 * the typed message.
 */
type ConsentEntry = { mode: 'voice' } | { mode: 'text'; text: string; speak?: boolean };

export interface UseAgentResult {
  phase: AgentPhase;
  isListening: boolean;
  showWaveform: boolean;
  showThinking: boolean;
  isBusy: boolean;
  volumeLevel: number;
  /** Whether speech recognition is available (mic granted + STT module up). */
  voiceAvailable: boolean;
  toggleListening: () => Promise<void>;
  /**
   * Text entry point: runs a full agent turn from typed text instead of a
   * voice transcription. From the moment there is a text to send, the flow is
   * IDENTICAL to a voice turn (same consent, gate, context capture, backend
   * call, action pipeline and confirmations). By default the reply is NOT
   * spoken (silent text mode — the bubble shows it); pass { speak: true } to
   * also play TTS. Confirmations in silent mode are tap-only (modal).
   */
  submitTextTurn: (text: string, options?: { speak?: boolean }) => Promise<void>;
  /** Current exchange (user message + agent reply) for the text bubble UI. */
  lastExchange: AgentExchange | null;
  /** Paged window of recent user+reply pairs while session memory is active. */
  recentExchanges: AgentExchange[];
  /** Older messages exist beyond the mounted window (scroll up to load them). */
  hasOlderExchanges: boolean;
  /** An older page is being loaded (show the loading row at the top). */
  loadingOlderExchanges: boolean;
  /** Page one more block of older session messages into the bubble. */
  loadOlderExchanges: () => void;
  /** Collapse the bubble history back to the initial page (bubble closed). */
  resetExchangeWindow: () => void;
  cancelAll: () => void;
  consentModalVisible: boolean;
  acceptConsent: () => Promise<void>;
  declineConsent: () => void;
  confirmationModalVisible: boolean;
  confirmationMessage: string;
  /** Strict-action only: the exact phrase to say by voice (display hint). */
  confirmationVoiceHint: string | null;
  confirmPendingAction: () => Promise<void>;
  cancelPendingAction: () => void;
  /** Passive wake-word listening is active (discrete privacy indicator). */
  wakeWordListening: boolean;
}

function devLog(invocationId: number, step: string, extra?: string): void {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;
  // eslint-disable-next-line no-console
  console.log(
    `[fyodos][#${invocationId}][${new Date().toISOString().slice(11, 23)}] ${step}${extra ? ` — ${extra}` : ''}`,
  );
}

export function useAgent({
  enabled = true,
  conversationRetentionMinutes = null,
}: UseAgentOptions = {}): UseAgentResult {
  const runtime = useFiodosRuntime();
  const {
    config,
    messages,
    ui,
    lexicon,
    sanitizer,
    telemetry,
    consent,
    executor,
    timings,
    chaining,
    screenStore,
    notifyError,
    getTtsVoice,
  } = runtime;
  const { voice, backend, navigation, manifest } = {
    voice: config.voice,
    backend: config.backend,
    navigation: config.navigation,
    manifest: config.manifest,
  };
  const ttsLocale = config.ttsLocale ?? config.sttLocale;

  const [phase, setPhase] = useState<AgentPhase>('idle');
  const [consentModalVisible, setConsentModalVisible] = useState(false);
  /**
   * Sensitive 'execute' action awaiting modal confirmation. Resolved OUTSIDE
   * the turn: the turn ends by speaking the confirmation question (so the
   * thinking watchdog never kills it) and execution happens later, from the
   * modal buttons or the voice window.
   */
  const [pendingConfirmationMessage, setPendingConfirmationMessage] = useState<string | null>(
    null,
  );
  /**
   * Visible voice hint for STRICT confirmations: tells the user the EXACT
   * phrase to say (the tap button always works too). Null for non-strict
   * actions. Discoverability only — never relaxes the strict requirement.
   */
  const [pendingConfirmationVoiceHint, setPendingConfirmationVoiceHint] = useState<string | null>(
    null,
  );
  const pendingConfirmationRef = useRef<PendingConfirmation | null>(null);
  /** Voice confirmation window active: transcripts answer it, never start turns. */
  const confirmationVoiceActiveRef = useRef(false);
  /** Already re-asked once after an ambiguous reply (max one retry). */
  const confirmationReaskedRef = useRef(false);
  const confirmationTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** Current exchange shown by the text bubble (current turn only — light). */
  const [lastExchange, setLastExchange] = useState<AgentExchange | null>(null);
  /** Current turn started from typed text in silent mode (no TTS). */
  const silentTurnRef = useRef(false);
  /** Cross-refs breaking the handleTranscript ↔ confirmation-helpers cycle. */
  const beginConfirmationWindowRef = useRef<(() => Promise<void>) | null>(null);
  const confirmPendingActionRef = useRef<(() => Promise<void>) | null>(null);
  const cancelPendingActionRef = useRef<(() => void) | null>(null);
  // ── Autonomous chaining state (Phase 2: pause/resume across confirmation) ──
  // A chain that pauses on a sensitive action parks its state here; the
  // confirmation handler resumes it via runChainLoopRef after the user confirms.
  const chainStateRef = useRef<{
    userMessage: string;
    step: number;
    lastStep?: ChainStepInfo;
    visitedKeys: Set<string>;
    pendingKey?: string;
    pendingStep?: ChainStepInfo;
  } | null>(null);
  const runChainLoopRef = useRef<
    | ((state: {
        userMessage: string;
        step: number;
        lastStep?: ChainStepInfo;
        visitedKeys: Set<string>;
      }) => Promise<void>)
    | null
  >(null);
  const pendingConfirmationMessageRef = useRef<string | null>(null);
  useEffect(() => {
    pendingConfirmationMessageRef.current = pendingConfirmationMessage;
  }, [pendingConfirmationMessage]);

  const phaseRef = useRef<AgentPhase>('idle');
  const abortRef = useRef<AbortController | null>(null);
  const awaitingTranscriptRef = useRef(false);
  const pendingEndRef = useRef(false);
  /** When the user stopped talking — to measure STT latency. */
  const sttStopAtRef = useRef<number | null>(null);
  const invocationIdRef = useRef(0);
  /** Which flow (voice or typed text) the consent modal interrupted. */
  const consentEntryRef = useRef<ConsentEntry | null>(null);
  /** In-memory session conversation (bounded window + summary for token cost). */
  const conversationRef = useRef(createConversationSession());
  // Idle retention from the dashboard, kept in a ref so async turn flows always
  // read the latest published value (undefined = 30-minute default).
  const conversationOptionsRef = useRef<ReturnType<typeof conversationRetentionOptions>>(undefined);
  conversationOptionsRef.current = conversationRetentionOptions(conversationRetentionMinutes);
  const retentionMinutesRef = useRef<number | null>(null);
  retentionMinutesRef.current =
    typeof conversationRetentionMinutes === 'number' ? conversationRetentionMinutes : null;
  // Bumped when the persisted conversation is rehydrated, so the exchange
  // window recomputes even though lastExchange did not change.
  const [conversationEpoch, setConversationEpoch] = useState(0);

  // ── Conversation persistence (survives app restarts) ────────────────────────
  const persistConversation = useCallback(() => {
    void persistConversationSession(
      config.storage,
      config.manifest.appId,
      conversationRef.current,
      retentionMinutesRef.current,
    );
  }, [config.storage, config.manifest.appId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const restored = await restoreConversationSession(config.storage, config.manifest.appId);
      if (cancelled || !restored) return;
      const current = conversationRef.current;
      // Never clobber turns the user already made while the restore resolved.
      if (current.turns.length > 0 || current.uiArchive?.length) return;
      current.turns = restored.turns;
      current.summary = restored.summary;
      current.uiArchive = restored.uiArchive;
      current.lastActivityAt = restored.lastActivityAt;
      setConversationEpoch((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [config.storage, config.manifest.appId]);
  /**
   * Opaque conversation/session id for analytics correlation (NEVER content).
   * Stable for this hook instance — lets the backend count distinct sessions.
   */
  const sessionIdRef = useRef(
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  );
  /** The session-start analytics event is emitted lazily, on the first turn. */
  const sessionStartedRef = useRef(false);

  const onPhaseChangeRef = useRef(config.onPhaseChange);
  onPhaseChangeRef.current = config.onPhaseChange;

  const setPhaseSafe = useCallback((next: AgentPhase) => {
    const previous = phaseRef.current;
    if (previous === next) return;
    phaseRef.current = next;
    setPhase(next);
    // App lifecycle hook (e.g. pause the app's own audio while the agent is
    // active so it neither bleeds into the mic nor mixes with the TTS).
    try {
      onPhaseChangeRef.current?.(next, previous);
    } catch {
      /* app hook must never break the agent */
    }
  }, []);

  const stopSpeech = useCallback(() => {
    voice.stopPlayback();
  }, [voice]);

  const speakReply = useCallback(
    async (reply: string, audioBase64?: string | null) => {
      if (!reply.trim()) {
        setPhaseSafe('idle');
        return;
      }
      // Silent text mode: the bubble shows the reply, nothing is spoken.
      if (silentTurnRef.current) {
        setPhaseSafe('idle');
        return;
      }
      setPhaseSafe('speaking');
      stopSpeech();

      // ONE consistent voice across the whole conversation. The main turn
      // reply arrives with server audio (the configured/cloud voice). For any
      // text the CLIENT generates (action feedback, confirmation questions,
      // cancellations, re-asks) there is no server audio, so we synthesize it
      // with the SAME server voice via previewTts — otherwise it would fall to
      // the device (OS) voice and the agent would switch voices mid-dialogue.
      // An empty voice id lets the backend apply its own default, matching the
      // voice used for the main reply. Device TTS stays as the last resort.
      let audio = audioBase64 ?? null;
      if (!audio?.length) {
        audio = await backend.previewTts(getTtsVoice() ?? '', reply);
      }

      if (audio?.length) {
        try {
          await voice.playAudioBase64Mp3(audio);
          if (phaseRef.current === 'speaking') setPhaseSafe('idle');
          return;
        } catch {
          // Server TTS playback failed → degrade to device TTS below.
        }
      }
      if (phaseRef.current !== 'speaking') return;
      await voice.speakWithDeviceTts(reply, { locale: ttsLocale });
      if (phaseRef.current === 'speaking') setPhaseSafe('idle');
    },
    [backend, getTtsVoice, setPhaseSafe, stopSpeech, ttsLocale, voice],
  );

  const notifyApiError = useCallback(
    (e: unknown): void => {
      if (!isAgentApiError(e)) {
        notifyError(ui.genericError);
        return;
      }
      switch (e.code) {
        case 'unauthorized':
          notifyError(ui.sessionExpired);
          return;
        case 'quota_exceeded':
          if (config.onQuotaExceeded) config.onQuotaExceeded();
          else notifyError(ui.quotaExceeded);
          return;
        case 'rate_limited':
          notifyError(ui.rateLimited);
          return;
        case 'network':
          notifyError(ui.noConnection);
          return;
        case 'not_found':
        case 'server_error':
          notifyError(ui.serverUnavailable);
          return;
        default:
          notifyError(ui.genericError);
      }
    },
    [config, notifyError, ui],
  );

  const handleTranscript = useCallback(
    async (text: string) => {
      const turnId = invocationIdRef.current;
      awaitingTranscriptRef.current = false;
      const sttLatencyMs = sttStopAtRef.current != null ? Date.now() - sttStopAtRef.current : null;
      sttStopAtRef.current = null;
      const msg = text.trim();
      devLog(turnId, 'transcript', `${msg.length} chars, stt=${sttLatencyMs ?? '?'}ms`);
      if (!enabled) {
        setPhaseSafe('idle');
        return;
      }
      if (msg.length < timings.minTranscriptChars) {
        setPhaseSafe('idle');
        telemetry.logEvent({
          eventType: 'agent_stt_empty',
          userMessage: msg || undefined,
          currentRoute: navigation.getCurrentRoute(),
          latencySttMs: sttLatencyMs,
        });
        notifyError(ui.sttTooShort);
        return;
      }

      setPhaseSafe('thinking');
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const startedAt = Date.now();
      const routeAtInvocation = navigation.getCurrentRoute();
      devLog(turnId, 'request start', `route=${routeAtInvocation ?? '?'}`);
      // First real turn of this session → one countable "conversation".
      if (!sessionStartedRef.current) {
        sessionStartedRef.current = true;
        telemetry.logEvent({
          eventType: 'agent_session_started',
          sessionId: sessionIdRef.current,
          currentRoute: routeAtInvocation,
        });
      }
      telemetry.logEvent({
        eventType: 'agent_invoked',
        userMessage: msg,
        sessionId: sessionIdRef.current,
        currentRoute: routeAtInvocation,
      });

      try {
        // Structured snapshot at invocation time: 'execute' actions operate
        // on what the user was viewing WHEN THEY SPOKE, even if they scroll
        // while the backend responds.
        const screenSnapshotAtInvocation = screenStore.getSnapshot();
        // User context first (stable); screen context absorbs the cut.
        // Sanitization applies ONLY to app-provided context — the user's own
        // transcription is never redacted.
        const rawContext = combineContexts(
          config.getUserContextText?.() ?? null,
          screenStore.getText(),
          {
            truncationSuffix: messages.contextTruncationSuffix,
            maxChars: config.contextMaxChars,
          },
        );
        const { sanitized, redactions } = rawContext
          ? sanitizer(rawContext)
          : { sanitized: null, redactions: [] as string[] };
        const contextChars = sanitized?.length ?? 0;
        if (redactions.length) devLog(turnId, 'context redacted', redactions.join(','));

        const conversation = prepareConversationForTurn(
          conversationRef.current,
          Date.now(),
          conversationOptionsRef.current,
        );

        const result = await backend.sendTurn(
          {
            message: msg,
            language: config.locale,
            voice: getTtsVoice(),
            screenContext: sanitized ?? undefined,
            currentRoute: routeAtInvocation ?? undefined,
            conversationHistory: conversation.history,
            conversationSummary: conversation.summary ?? undefined,
            sessionId: sessionIdRef.current,
            ...buildManifestPayload(manifest),
          },
          { signal: controller.signal },
        );
        const { reply, audioBase64, action, wasTruncated } = result;
        devLog(
          turnId,
          'response',
          `${Date.now() - startedAt}ms, action=${action?.intent ?? action?.type ?? 'none'}, truncated=${wasTruncated}`,
        );
        if (controller.signal.aborted) return;
        if (!reply.trim()) {
          notifyError(ui.emptyReply);
          setPhaseSafe('idle');
          return;
        }
        config.onTurnCompleted?.();

        const screenContextAtInvocation: AgentScreenContext =
          screenSnapshotAtInvocation?.context ?? {};

        // Resolve ONE backend turn's action into what gets spoken and whether
        // the autonomous chain may advance. A pending sensitive confirmation is
        // staged as a side-effect (refs) and ALWAYS pauses the chain. Shared by
        // the first turn and every continuation so both follow the exact same
        // security path (manifest is the source of truth for confirmation).
        const applyAction = async (
          res: AgentTurnResult,
          actx: {
            routeAtInvocation: string | null;
            sttLatencyMs: number | null;
            startedAt: number;
            screenContext: AgentScreenContext;
            redactions: string[];
            contextChars: number;
          },
        ): Promise<{
          spokenReply: string;
          spokenAudio: string | null | undefined;
          canContinue: boolean;
          lastStep?: ChainStepInfo;
          actionKey?: string;
          hasPending?: boolean;
          pendingInProgress?: boolean;
          pendingStep?: ChainStepInfo;
          pendingKey?: string;
        }> => {
          const { reply: aReply, audioBase64: aAudio, action, wasTruncated } = res;
          const latencyMs = Date.now() - actx.startedAt;
          // What gets spoken: by default the LLM reply with its TTS. If an
          // execute action is idempotent or fails, the LLM reply would be false
          // → speak the handler's real message with device TTS instead.
          let spokenReply = aReply;
          let spokenAudio: string | null | undefined = aAudio;
          let canContinue = false;
          let lastStep: ChainStepInfo | undefined;
          let actionKey: string | undefined;
          let hasPending = false;
          let pendingInProgress = false;
          let pendingStep: ChainStepInfo | undefined;
          let pendingKey: string | undefined;

          if (action && action.type === 'navigate') {
            const actionStartedAt = Date.now();
            const navResult = await executor.execute(action);
            telemetry.logEvent({
              eventType: navResult.success ? 'navigation_executed' : 'navigation_failed',
              userMessage: msg,
              intentDetected: action.intent ?? null,
              actionExecuted: { type: action.type, intent: action.intent ?? null },
              currentRoute: actx.routeAtInvocation,
              latencyMs,
              latencySttMs: actx.sttLatencyMs,
              latencyActionMs: Date.now() - actionStartedAt,
              wasTruncated,
              contextChars: actx.contextChars,
              redactionsApplied: actx.redactions,
            });
            if (navResult.success) {
              lastStep = {
                type: 'navigate',
                intent: action.intent ?? '',
                label: manifest.routes.find((r) => r.intent === action.intent)?.label,
                success: true,
              };
              actionKey = `navigate:${action.intent ?? ''}`;
              canContinue = res.taskStatus === 'in_progress';
            }
          } else if (action && action.type === 'execute') {
            const executeContext: AgentScreenContext = actx.screenContext;
            // Confirmation source of truth: the MANIFEST, never the LLM
            // (double validation — the backend instructs, the client enforces).
            const manifestAction = manifest.actions.find((a) => a.intent === action.intent);
            const needsConfirmation = manifestAction?.requireConfirmation === true;

            if (needsConfirmation) {
              // Precheck (context + idempotency) BEFORE bothering with the
              // modal: asking to apply an already-applied state answers
              // directly.
              const pre = await executor.precheck(action, executeContext);
              if (pre.kind === 'done') {
                const preResult = pre.result;
                telemetry.logEvent({
                  eventType: preResult.recoverable
                    ? 'action_needs_context'
                    : preResult.idempotent
                      ? 'action_idempotent'
                      : preResult.success
                        ? 'action_executed'
                        : 'action_failed',
                  userMessage: msg,
                  intentDetected: action.intent ?? null,
                  actionExecuted: {
                    type: action.type,
                    intent: action.intent ?? null,
                    ...(preResult.error ? { error: preResult.error } : {}),
                  },
                  currentRoute: actx.routeAtInvocation,
                  latencyMs,
                  latencySttMs: actx.sttLatencyMs,
                  wasTruncated,
                  contextChars: actx.contextChars,
                  redactionsApplied: actx.redactions,
                });
                // Recoverable (screen/context) gap: keep the assistant's guiding
                // reply ("which item?" / it will navigate), never override it
                // with a refusal. Only terminal results speak the engine message.
                if (preResult.message && !preResult.recoverable) {
                  spokenReply = preResult.message;
                  spokenAudio = null;
                }
              } else {
                // Canonical question from the manifest; LLM's only as fallback.
                const confirmationMessage =
                  manifestAction?.confirmationMessageTemplate ??
                  action.confirmationMessage ??
                  messages.confirmationFallbackQuestion;
                // Voice resolution mode is dashboard/manifest-governed:
                // 'disabled' actions can ONLY be confirmed by tapping.
                const voiceMode = manifestAction?.voiceConfirmation ?? 'standard';
                const strictPhrase =
                  voiceMode === 'strict'
                    ? (manifestAction?.confirmationPhrase ??
                      formatMessage(messages.strictConfirmationPhraseTemplate, {
                        label: (manifestAction?.label ?? action.intent ?? '').toLowerCase(),
                      }))
                    : null;
                pendingConfirmationRef.current = {
                  action,
                  context: executeContext,
                  userMessage: msg,
                  routeAtInvocation: actx.routeAtInvocation,
                  latencyMs,
                  latencySttMs: actx.sttLatencyMs,
                  wasTruncated,
                  contextChars: actx.contextChars,
                  redactions: actx.redactions,
                  remainingConfirmations: manifestAction?.doubleConfirmation === true ? 2 : 1,
                  voiceMode,
                  strictPhrase,
                  silent: silentTurnRef.current,
                };
                confirmationReaskedRef.current = false;
                setPendingConfirmationMessage(confirmationMessage);
                // Strict actions: surface the exact phrase in the modal too, so
                // the user can DISCOVER it (until now it was only spoken). This
                // is display-only and never weakens the strict requirement.
                setPendingConfirmationVoiceHint(
                  voiceMode === 'strict' && strictPhrase && !silentTurnRef.current
                    ? formatMessage(messages.strictConfirmationModalHint, { phrase: strictPhrase })
                    : null,
                );
                // Countable, content-free analytics: a sensitive confirmation was
                // requested (completion is tracked when the action runs).
                telemetry.logEvent({
                  eventType: 'action_confirmation_requested',
                  intentDetected: action.intent ?? null,
                  sessionId: sessionIdRef.current,
                  currentRoute: actx.routeAtInvocation,
                });
                devLog(turnId, 'confirmation modal shown', `${action.intent} (voice=${voiceMode})`);
                // The question is spoken (the prompt instructs the LLM that its
                // reply BE the question; if it strayed, the modal still shows
                // the canonical text). The chain PAUSES here: canContinue stays
                // false, so no autonomous step runs until the user confirms.
                spokenReply = aReply;
                // If the model wants to keep going after this sensitive step,
                // the chain will RESUME once the user confirms (Phase 2).
                hasPending = true;
                pendingInProgress = res.taskStatus === 'in_progress';
                pendingStep = {
                  type: 'execute',
                  intent: action.intent ?? '',
                  label: manifestAction?.label,
                  success: true,
                };
                pendingKey = `execute:${action.intent ?? ''}`;
              }
            } else {
              const actionStartedAt = Date.now();
              const execResult = await executor.execute(action, executeContext);
              telemetry.logEvent({
                eventType: execResult.recoverable
                  ? 'action_needs_context'
                  : execResult.idempotent
                    ? 'action_idempotent'
                    : execResult.success
                      ? 'action_executed'
                      : 'action_failed',
                userMessage: msg,
                intentDetected: action.intent ?? null,
                actionExecuted: {
                  type: action.type,
                  intent: action.intent ?? null,
                  ...(execResult.error ? { error: execResult.error } : {}),
                },
                currentRoute: actx.routeAtInvocation,
                latencyMs,
                latencySttMs: actx.sttLatencyMs,
                latencyActionMs: Date.now() - actionStartedAt,
                wasTruncated,
                contextChars: actx.contextChars,
                redactionsApplied: actx.redactions,
              });
              if (execResult.recoverable) {
                // Screen/context gap that the agent can resolve by guiding or
                // navigating: keep the assistant's reply, never speak a refusal.
              } else if (
                execResult.success &&
                execResult.message &&
                typeof execResult.data?.ttsVoiceOverride === 'string'
              ) {
                // Voice-change pattern: the feedback must sound WITH the new
                // voice (the LLM audio carries the old one). Short synthesis;
                // if it fails, speakReply degrades to device TTS.
                spokenReply = execResult.message;
                spokenAudio = await backend.previewTts(
                  execResult.data.ttsVoiceOverride,
                  execResult.message,
                );
              } else if (execResult.message) {
                // FEEDBACK GUARANTEE: when the handler reports a real outcome
                // (success, idempotent or failure), speak ITS message instead of
                // the LLM's optimistic "Done" — the handler is the ground truth
                // that the action actually completed. Force device TTS (the LLM
                // audio no longer matches the spoken text).
                spokenReply = execResult.message;
                spokenAudio = null;
              }
              if (execResult.success && !execResult.recoverable) {
                lastStep = {
                  type: 'execute',
                  intent: action.intent ?? '',
                  label: manifestAction?.label,
                  success: true,
                };
                actionKey = `execute:${action.intent ?? ''}`;
                canContinue = res.taskStatus === 'in_progress';
              }
            }
          } else {
            telemetry.logEvent({
              eventType: 'question_only',
              userMessage: msg,
              currentRoute: actx.routeAtInvocation,
              latencyMs,
              latencySttMs: actx.sttLatencyMs,
              wasTruncated,
              contextChars: actx.contextChars,
              redactionsApplied: actx.redactions,
            });
          }
          return {
            spokenReply,
            spokenAudio,
            canContinue,
            lastStep,
            actionKey,
            hasPending,
            pendingInProgress,
            pendingStep,
            pendingKey,
          };
        };

        // ── Autonomous continuation loop (opt-in; OFF by default) ────────────
        // Extracted so confirmPendingAction can RESUME this exact chain after a
        // sensitive step is confirmed. Every continuation goes through the SAME
        // applyAction path, so disabled capabilities, confidentiality and
        // sensitive confirmations all still apply per step.
        const runChainLoop = async (cs: {
          userMessage: string;
          step: number;
          lastStep?: ChainStepInfo;
          visitedKeys: Set<string>;
        }): Promise<void> => {
          let step = cs.step;
          let lastStep = cs.lastStep;
          const visitedKeys = cs.visitedKeys;
          while (step < chaining.maxSteps) {
            step += 1;
            if (chaining.dwellMs > 0) await sleep(chaining.dwellMs);
            if (pendingConfirmationRef.current) return; // paused elsewhere

            const stepStartedAt = Date.now();
            const routeNow = navigation.getCurrentRoute();
            const snap = screenStore.getSnapshot();
            const rawCtx2 = combineContexts(
              config.getUserContextText?.() ?? null,
              screenStore.getText(),
              {
                truncationSuffix: messages.contextTruncationSuffix,
                maxChars: config.contextMaxChars,
              },
            );
            const { sanitized: san2, redactions: red2 } = rawCtx2
              ? sanitizer(rawCtx2)
              : { sanitized: null, redactions: [] as string[] };
            const conv2 = prepareConversationForTurn(
              conversationRef.current,
              Date.now(),
              conversationOptionsRef.current,
            );
            setPhaseSafe('thinking');
            const ctrl = new AbortController();
            abortRef.current = ctrl;

            let stepResult: AgentTurnResult;
            try {
              stepResult = await backend.sendTurn(
                {
                  message: cs.userMessage,
                  language: config.locale,
                  voice: getTtsVoice(),
                  screenContext: san2 ?? undefined,
                  currentRoute: routeNow ?? undefined,
                  conversationHistory: conv2.history,
                  conversationSummary: conv2.summary ?? undefined,
                  sessionId: sessionIdRef.current,
                  isContinuation: true,
                  chainStep: step,
                  lastStep,
                  ...buildManifestPayload(manifest),
                },
                { signal: ctrl.signal },
              );
            } catch (e) {
              const interrupted = ctrl.signal.aborted;
              if (!interrupted) {
                if (isAgentApiError(e) && e.code === 'timeout') notifyError(ui.turnFailed);
                else notifyApiError(e);
              }
              setPhaseSafe('idle');
              telemetry.logEvent({
                eventType: 'agent_chain_aborted',
                sessionId: sessionIdRef.current,
                chainStep: step,
                chainAbortReason: interrupted ? 'user_interrupt' : 'error',
              });
              return;
            }
            if (ctrl.signal.aborted) {
              telemetry.logEvent({
                eventType: 'agent_chain_aborted',
                sessionId: sessionIdRef.current,
                chainStep: step,
                chainAbortReason: 'user_interrupt',
              });
              return;
            }
            if (!stepResult.reply.trim()) {
              telemetry.logEvent({
                eventType: 'agent_chain_completed',
                sessionId: sessionIdRef.current,
                chainStep: step,
              });
              return;
            }

            const oc = await applyAction(stepResult, {
              routeAtInvocation: routeNow,
              sttLatencyMs: null,
              startedAt: stepStartedAt,
              screenContext: snap?.context ?? {},
              redactions: red2,
              contextChars: san2?.length ?? 0,
            });
            setLastExchange({ userText: cs.userMessage, replyText: oc.spokenReply });
            recordConversationExchange(
              conversationRef.current,
              cs.userMessage,
              oc.spokenReply,
              Date.now(),
              conversationOptionsRef.current,
            );
            persistConversation();
            await speakReply(oc.spokenReply, oc.spokenAudio);
            telemetry.logEvent({
              eventType: 'agent_chain_step',
              intentDetected: oc.lastStep?.intent ?? oc.pendingStep?.intent ?? null,
              sessionId: sessionIdRef.current,
              chainStep: step,
            });

            // A sensitive action surfaced: ALWAYS pause for confirmation. Park
            // the chain so confirmPendingAction can resume it (only if the model
            // wants to keep going); a rejection stops it cleanly.
            if (pendingConfirmationRef.current) {
              chainStateRef.current = oc.pendingInProgress
                ? {
                    userMessage: cs.userMessage,
                    step,
                    lastStep,
                    visitedKeys,
                    pendingKey: oc.pendingKey,
                    pendingStep: oc.pendingStep,
                  }
                : null;
              await beginConfirmationWindowRef.current?.();
              return;
            }
            // No-progress guard: repeating a step already taken stops the chain.
            if (oc.actionKey && visitedKeys.has(oc.actionKey)) {
              telemetry.logEvent({
                eventType: 'agent_chain_aborted',
                sessionId: sessionIdRef.current,
                chainStep: step,
                chainAbortReason: 'no_progress',
              });
              return;
            }
            if (oc.actionKey) visitedKeys.add(oc.actionKey);
            if (!oc.canContinue) {
              telemetry.logEvent({
                eventType: 'agent_chain_completed',
                sessionId: sessionIdRef.current,
                chainStep: step,
              });
              return;
            }
            lastStep = oc.lastStep;
          }
          // Hit the hard step cap while still wanting to continue.
          telemetry.logEvent({
            eventType: 'agent_chain_aborted',
            sessionId: sessionIdRef.current,
            chainStep: step,
            chainAbortReason: 'max_steps',
          });
        };
        // Expose the loop so confirmPendingAction can resume this exact chain.
        if (chaining.enabled) runChainLoopRef.current = runChainLoop;

        const first = await applyAction(result, {
          routeAtInvocation,
          sttLatencyMs,
          startedAt,
          screenContext: screenContextAtInvocation,
          redactions,
          contextChars,
        });

        // The bubble shows the exchange in text (voice and text turns alike).
        setLastExchange({ userText: msg, replyText: first.spokenReply });
        recordConversationExchange(
          conversationRef.current,
          msg,
          first.spokenReply,
          Date.now(),
          conversationOptionsRef.current,
        );
        persistConversation();
        await speakReply(first.spokenReply, first.spokenAudio);
        // Voice confirmation: after speaking the question, listen for the
        // reply for a few seconds. The modal stays visible as the tactile
        // fallback and its decision always wins. Respects the action's
        // voice mode ('disabled' → tap only) and silent text mode.
        if (pendingConfirmationRef.current) {
          await beginConfirmationWindowRef.current?.();
          // If the first step is a sensitive action AND the model wants to keep
          // going, park the chain so it RESUMES after the user confirms.
          if (chaining.enabled && first.pendingInProgress) {
            telemetry.logEvent({
              eventType: 'agent_chain_started',
              sessionId: sessionIdRef.current,
              chainStep: 1,
            });
            chainStateRef.current = {
              userMessage: msg,
              step: 1,
              lastStep: first.pendingStep,
              visitedKeys: new Set<string>(),
              pendingKey: first.pendingKey,
              pendingStep: first.pendingStep,
            };
          }
        } else if (chaining.enabled && first.canContinue) {
          telemetry.logEvent({
            eventType: 'agent_chain_started',
            sessionId: sessionIdRef.current,
            chainStep: 1,
          });
          const visitedKeys = new Set<string>();
          if (first.actionKey) visitedKeys.add(first.actionKey);
          await runChainLoop({
            userMessage: msg,
            step: 1,
            lastStep: first.lastStep,
            visitedKeys,
          });
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        devLog(turnId, 'ERROR', e instanceof Error ? e.message : String(e));
        if (isAgentApiError(e) && e.code === 'timeout') {
          telemetry.logEvent({
            eventType: 'agent_timeout',
            userMessage: msg,
            currentRoute: routeAtInvocation,
            latencyMs: Date.now() - startedAt,
          });
          notifyError(ui.turnFailed);
          setPhaseSafe('idle');
          return;
        }
        notifyApiError(e);
        setPhaseSafe('idle');
      }
    },
    [
      backend,
      chaining,
      config,
      enabled,
      executor,
      getTtsVoice,
      manifest,
      messages,
      navigation,
      notifyApiError,
      notifyError,
      sanitizer,
      screenStore,
      setPhaseSafe,
      speakReply,
      telemetry,
      timings.minTranscriptChars,
      ui,
    ],
  );

  const handleTranscriptRef = useRef(handleTranscript);
  useEffect(() => {
    handleTranscriptRef.current = handleTranscript;
  }, [handleTranscript]);

  const handleConfirmationTranscriptRef = useRef<((text: string) => Promise<void>) | null>(null);

  const onTranscriptReady = useCallback((text: string) => {
    // While a confirmation is pending (active window or late transcript with
    // the modal still visible), the transcript answers the question — it
    // never starts a new turn against the backend.
    if (confirmationVoiceActiveRef.current || pendingConfirmationRef.current) {
      void handleConfirmationTranscriptRef.current?.(text);
      return;
    }
    void handleTranscriptRef.current(text);
  }, []);

  const onSpeechError = useCallback(
    (error: unknown) => {
      awaitingTranscriptRef.current = false;
      const code = error instanceof Error ? error.message : '';
      if (phaseRef.current === 'listening' || phaseRef.current === 'thinking') {
        setPhaseSafe('idle');
      }
      if (code === 'permission_denied') {
        notifyError(ui.micPermissionDenied);
      } else if (code === 'recognition_unavailable') {
        telemetry.logEvent({
          eventType: 'agent_stt_failed',
          currentRoute: navigation.getCurrentRoute(),
        });
        notifyError(ui.sttUnavailable);
      }
      // Other native errors: state already reset; the watchdog and the
      // no-transcript timers surface the user-facing message if needed.
    },
    [navigation, notifyError, setPhaseSafe, telemetry, ui],
  );

  const speech = useSpeechSession({
    adapter: voice,
    locale: config.sttLocale,
    maxSeconds: timings.maxListeningSeconds,
    onTranscript: onTranscriptReady,
    onError: onSpeechError,
  });
  const voiceState = speech.state;
  const voiceStateRef = useRef(voiceState);
  useEffect(() => {
    voiceStateRef.current = voiceState;
  }, [voiceState]);

  const requestStopRecording = useCallback(() => {
    awaitingTranscriptRef.current = true;
    sttStopAtRef.current = Date.now();
    setPhaseSafe('thinking');
    speech.stop();
  }, [setPhaseSafe, speech]);

  // ── Voice confirmation window ───────────────────────────────────────────────
  // 'confirming' phase lives OUTSIDE the turn cycle: it does not trigger the
  // thinking watchdog and transcripts route to the pending question.

  const clearConfirmationTimers = useCallback(() => {
    for (const t of confirmationTimersRef.current) clearTimeout(t);
    confirmationTimersRef.current = [];
  }, []);

  /**
   * Closes the listening window WITHOUT resolving the confirmation: the modal
   * stays visible so the user can decide with the buttons (timeout, STT
   * error…).
   */
  const endConfirmationVoiceWindow = useCallback(
    (reason: string) => {
      if (!confirmationVoiceActiveRef.current) return;
      confirmationVoiceActiveRef.current = false;
      clearConfirmationTimers();
      speech.cancel();
      devLog(invocationIdRef.current, 'confirmation window end', reason);
      if (phaseRef.current === 'confirming') setPhaseSafe('idle');
    },
    [clearConfirmationTimers, setPhaseSafe, speech],
  );

  /** Opens the listening window for the pending confirmation. */
  const beginConfirmationVoiceWindow = useCallback(() => {
    if (!pendingConfirmationRef.current) return;
    if (confirmationVoiceActiveRef.current) return;
    // No real STT (simulator/managed environments): tactile modal only.
    if (!voice.isRecognitionAvailable()) return;
    confirmationVoiceActiveRef.current = true;
    setPhaseSafe('confirming');
    devLog(invocationIdRef.current, 'confirmation window start');
    void speech.start();
    const stopTimer = setTimeout(() => {
      // Window over: close the recording; if the user said something, the
      // transcript arrives within the grace period. Otherwise keep the modal.
      speech.stop();
      const graceTimer = setTimeout(
        () => endConfirmationVoiceWindow('timeout without transcript'),
        timings.confirmationTranscriptGraceMs,
      );
      confirmationTimersRef.current.push(graceTimer);
    }, timings.confirmationVoiceWindowMs);
    confirmationTimersRef.current.push(stopTimer);
  }, [
    endConfirmationVoiceWindow,
    setPhaseSafe,
    speech,
    timings.confirmationTranscriptGraceMs,
    timings.confirmationVoiceWindowMs,
    voice,
  ]);

  /**
   * Voice-confirmation entry point. Enforces the per-action policy BEFORE any
   * microphone is opened:
   * - silent text turns → tap-only (the user chose a no-audio channel);
   * - voiceMode 'disabled' (dashboard) → tap-only, no exceptions;
   * - voiceMode 'strict' → speak the exact-phrase instruction first, then
   *   open the window (a loose "yes" will not confirm — see the classifier).
   */
  const startConfirmationVoiceFlow = useCallback(async () => {
    const pending = pendingConfirmationRef.current;
    if (!pending) return;
    if (pending.silent || pending.voiceMode === 'disabled') return;
    if (pending.voiceMode === 'strict' && pending.strictPhrase) {
      await speakReply(
        formatMessage(messages.strictConfirmationInstruction, { phrase: pending.strictPhrase }),
        null,
      );
      // The user may have decided via modal while the instruction played.
      if (!pendingConfirmationRef.current) return;
    }
    beginConfirmationVoiceWindow();
  }, [beginConfirmationVoiceWindow, messages.strictConfirmationInstruction, speakReply]);

  useEffect(() => {
    beginConfirmationWindowRef.current = startConfirmationVoiceFlow;
  }, [startConfirmationVoiceFlow]);

  /** Resolves the transcript of the confirmation window. */
  const handleConfirmationTranscript = useCallback(
    async (text: string) => {
      confirmationVoiceActiveRef.current = false;
      clearConfirmationTimers();
      const trimmed = text.trim();
      if (phaseRef.current === 'confirming') setPhaseSafe('idle');
      // The user may have decided via modal while the transcript arrived.
      const pending = pendingConfirmationRef.current;
      if (!pending) return;
      // Safety net: a stray transcript can NEVER resolve a tap-only
      // confirmation (voice disabled in the dashboard, or silent text mode).
      if (pending.voiceMode === 'disabled' || pending.silent) return;

      if (trimmed.length < 2) {
        // Noise/empty → like a timeout: the modal remains available.
        return;
      }
      const strict = pending.voiceMode === 'strict' && pending.strictPhrase != null;
      const reply = strict
        ? classifyStrictConfirmationReply(trimmed, pending.strictPhrase as string, lexicon)
        : classifyConfirmationReply(trimmed, lexicon);
      devLog(
        invocationIdRef.current,
        'confirmation reply',
        `${reply}${strict ? ' (strict)' : ''}: "${trimmed}"`,
      );
      if (reply === 'affirmative') {
        await confirmPendingActionRef.current?.();
        return;
      }
      if (reply === 'negative') {
        cancelPendingActionRef.current?.();
        return;
      }
      // Ambiguous: re-ask ONCE and listen again; after that, modal only.
      // When in doubt, never execute.
      if (!confirmationReaskedRef.current) {
        confirmationReaskedRef.current = true;
        if (strict) {
          await speakReply(
            `${messages.strictConfirmationNotMatched} ${formatMessage(
              messages.strictConfirmationInstruction,
              { phrase: pending.strictPhrase as string },
            )}`,
            null,
          );
        } else {
          const question = pendingConfirmationMessageRef.current ?? ui.confirmationSayYesNo;
          await speakReply(`${messages.confirmationNotUnderstood} ${question}`, null);
        }
        if (pendingConfirmationRef.current) beginConfirmationVoiceWindow();
      }
    },
    [
      beginConfirmationVoiceWindow,
      clearConfirmationTimers,
      lexicon,
      messages.confirmationNotUnderstood,
      messages.strictConfirmationInstruction,
      messages.strictConfirmationNotMatched,
      setPhaseSafe,
      speakReply,
      ui.confirmationSayYesNo,
    ],
  );

  useEffect(() => {
    handleConfirmationTranscriptRef.current = handleConfirmationTranscript;
  }, [handleConfirmationTranscript]);

  // Latency shortcut: if the interim text is already a clear resolution
  // (yes/no — or the exact phrase in strict mode), close the recording
  // immediately (the final transcript arrives on 'end').
  useEffect(() => {
    if (!confirmationVoiceActiveRef.current) return;
    const pending = pendingConfirmationRef.current;
    if (!pending) return;
    const t = speech.interimText.trim();
    if (t.length < 2) return;
    const verdict =
      pending.voiceMode === 'strict' && pending.strictPhrase != null
        ? classifyStrictConfirmationReply(t, pending.strictPhrase, lexicon)
        : classifyConfirmationReply(t, lexicon);
    if (verdict === 'ambiguous') return;
    speech.stop();
  }, [speech, lexicon]);

  const beginListening = useCallback(async () => {
    if (!enabled) return;
    // Explicit consent (Apple 5.1.2(i) + GDPR): nothing leaves the device
    // until the user accepts. The modal continues the flow.
    if (!(await consent.hasConsented())) {
      consentEntryRef.current = { mode: 'voice' };
      setConsentModalVisible(true);
      return;
    }
    // App-level per-turn gate (quota, plan limits) — injected, optional.
    if (config.gateTurn) {
      const verdict = config.gateTurn();
      if (!verdict.ok) {
        if (verdict.message) notifyError(verdict.message);
        return;
      }
    }
    if (!voice.isRecognitionAvailable()) {
      telemetry.logEvent({
        eventType: 'agent_stt_failed',
        currentRoute: navigation.getCurrentRoute(),
      });
      notifyError(ui.sttUnavailable);
      return;
    }
    if (phaseRef.current === 'thinking') return;
    if (phaseRef.current === 'speaking') {
      stopSpeech();
      setPhaseSafe('idle');
    }
    invocationIdRef.current += 1;
    devLog(invocationIdRef.current, 'beginListening');
    pendingEndRef.current = false;
    awaitingTranscriptRef.current = false;
    silentTurnRef.current = false; // voice turn → spoken replies
    abortRef.current?.abort();
    setPhaseSafe('listening');
    await speech.start();
    // If STT never started (permission denied, module down), the session
    // state never leaves 'idle' and no effect fires → the phase would stay
    // 'listening' forever. Deferred check releases it.
    setTimeout(() => {
      if (phaseRef.current === 'listening' && voiceStateRef.current === 'idle') {
        devLog(invocationIdRef.current, 'reset idle', 'STT did not start');
        setPhaseSafe('idle');
      }
    }, 1000);
  }, [config, consent, enabled, navigation, notifyError, setPhaseSafe, speech, stopSpeech, telemetry, ui, voice]);

  const wakePhrases =
    config.voiceActivation?.phrases?.length
      ? config.voiceActivation.phrases
      : defaultWakePhrasesForLocale(config.locale);

  const handleWakeDetected = useCallback(
    async (trailingCommand: string) => {
      voice.stopWakeWordDetection?.();
      const command = stripWakePhrase(trailingCommand, wakePhrases) || trailingCommand.trim();
      if (command.length >= timings.minTranscriptChars) {
        invocationIdRef.current += 1;
        devLog(invocationIdRef.current, 'wakeWordDetected', `command=${command.length} chars`);
        silentTurnRef.current = false;
        await handleTranscriptRef.current(command);
        return;
      }
      devLog(invocationIdRef.current + 1, 'wakeWordDetected', 'opening mic');
      await beginListening();
    },
    [beginListening, timings.minTranscriptChars, voice, wakePhrases],
  );

  const { wakeWordListening } = useWakeWordActivation({
    enabled,
    voice,
    sttLocale: config.sttLocale,
    agentLocale: config.locale,
    voiceActivation: config.voiceActivation,
    phase,
    consent,
    telemetry,
    navigation,
    onWakeDetected: (cmd) => {
      void handleWakeDetected(cmd);
    },
  });

  const endListening = useCallback(() => {
    if (phaseRef.current !== 'listening') return;
    if (voiceStateRef.current === 'recording' || voiceStateRef.current === 'transcribing') {
      requestStopRecording();
      return;
    }
    pendingEndRef.current = true;
  }, [requestStopRecording]);

  /**
   * TEXT ENTRY POINT (interaction-modes roadmap): starts a turn from typed
   * text. Same gates as a voice turn (consent first, then the app's per-turn
   * gate) and the same downstream pipeline — from here on, a typed message
   * and a voice transcription are indistinguishable.
   *
   * No STT is involved: a turn or confirmation already in progress keeps
   * priority and the call is ignored (mirrors toggleListening's guards).
   */
  const submitTextTurn = useCallback(
    async (text: string, options?: { speak?: boolean }) => {
      if (!enabled) return;
      const msg = text.trim();
      if (!msg) return;
      if (!(await consent.hasConsented())) {
        consentEntryRef.current = { mode: 'text', text: msg, speak: options?.speak };
        setConsentModalVisible(true);
        return;
      }
      if (config.gateTurn) {
        const verdict = config.gateTurn();
        if (!verdict.ok) {
          if (verdict.message) notifyError(verdict.message);
          return;
        }
      }
      if (
        phaseRef.current === 'thinking' ||
        phaseRef.current === 'confirming' ||
        phaseRef.current === 'listening'
      ) {
        return;
      }
      if (phaseRef.current === 'speaking') {
        stopSpeech();
        setPhaseSafe('idle');
      }
      invocationIdRef.current += 1;
      devLog(invocationIdRef.current, 'submitTextTurn', `${msg.length} chars`);
      pendingEndRef.current = false;
      awaitingTranscriptRef.current = false;
      sttStopAtRef.current = null;
      // Text turns are silent by default: the bubble shows the reply.
      silentTurnRef.current = options?.speak !== true;
      abortRef.current?.abort();
      await handleTranscriptRef.current(msg);
    },
    [config, consent, enabled, notifyError, setPhaseSafe, stopSpeech],
  );

  useEffect(() => {
    if (!pendingEndRef.current) return;
    if (voiceStateRef.current === 'recording' || voiceStateRef.current === 'transcribing') {
      pendingEndRef.current = false;
      requestStopRecording();
    }
  }, [voiceState, requestStopRecording]);

  useEffect(() => {
    if (awaitingTranscriptRef.current) return;
    if (phaseRef.current !== 'listening') return;
    if (voiceState !== 'idle') return;
    setPhaseSafe('idle');
  }, [voiceState, setPhaseSafe]);

  useEffect(() => {
    if (!awaitingTranscriptRef.current) return;
    if (voiceState !== 'idle') return;
    const t = setTimeout(() => {
      if (!awaitingTranscriptRef.current) return;
      awaitingTranscriptRef.current = false;
      if (phaseRef.current === 'thinking') {
        telemetry.logEvent({
          eventType: 'agent_stt_empty',
          currentRoute: navigation.getCurrentRoute(),
        });
        notifyError(ui.sttNoTranscript);
        setPhaseSafe('idle');
      }
    }, 1200);
    return () => clearTimeout(t);
  }, [voiceState, navigation, notifyError, setPhaseSafe, telemetry, ui]);

  // WATCHDOG: 'thinking' may never outlive the limit. Covers native STT hangs
  // (neither 'end' nor 'error' → nobody resets the phase) and any unhandled
  // error path. Without it the orb locks up because toggleListening ignores
  // taps while thinking.
  useEffect(() => {
    if (phase !== 'thinking') return;
    const t = setTimeout(() => {
      if (phaseRef.current !== 'thinking') return;
      devLog(invocationIdRef.current, 'WATCHDOG reset', `thinking > ${timings.thinkingWatchdogMs}ms`);
      awaitingTranscriptRef.current = false;
      pendingEndRef.current = false;
      abortRef.current?.abort();
      speech.cancel();
      telemetry.logEvent({
        eventType: 'agent_watchdog_reset',
        currentRoute: navigation.getCurrentRoute(),
        latencyMs: timings.thinkingWatchdogMs,
      });
      notifyError(ui.turnFailed);
      setPhaseSafe('idle');
    }, timings.thinkingWatchdogMs);
    return () => clearTimeout(t);
  }, [phase, navigation, notifyError, setPhaseSafe, speech, telemetry, timings.thinkingWatchdogMs, ui]);

  const cancelAll = useCallback(() => {
    pendingEndRef.current = false;
    awaitingTranscriptRef.current = false;
    voice.stopWakeWordDetection?.();
    // Close the confirmation listening window if open; the pending modal
    // stays visible so the user can decide with the buttons.
    endConfirmationVoiceWindow('cancelAll');
    abortRef.current?.abort();
    speech.cancel();
    stopSpeech();
    setPhaseSafe('idle');
  }, [endConfirmationVoiceWindow, setPhaseSafe, speech, stopSpeech]);

  useEffect(
    () => () => {
      pendingEndRef.current = false;
      awaitingTranscriptRef.current = false;
      confirmationVoiceActiveRef.current = false;
      for (const t of confirmationTimersRef.current) clearTimeout(t);
      confirmationTimersRef.current = [];
      abortRef.current?.abort();
      voice.cancelListening();
      voice.stopWakeWordDetection?.();
      voice.stopPlayback();
    },
    [voice],
  );

  const isListening =
    phase === 'listening' && (voiceState === 'recording' || voiceState === 'transcribing');
  // The waveform also shows during the voice confirmation window.
  const showWaveform =
    (phase === 'listening' || phase === 'confirming') && voiceState === 'recording';
  const showThinking = phase === 'thinking' || (phase === 'listening' && voiceState === 'transcribing');

  const toggleListening = useCallback(async () => {
    if (!enabled || showThinking) return;
    // During confirmation, the decision belongs to the modal or the voice —
    // the orb never starts new turns (the modal backdrop blocks taps anyway).
    if (phaseRef.current === 'confirming') return;
    if (phaseRef.current === 'listening') {
      endListening();
      return;
    }
    if (phaseRef.current === 'speaking') {
      stopSpeech();
    }
    await beginListening();
  }, [beginListening, enabled, endListening, showThinking, stopSpeech]);

  /** The user accepted consent: persist and resume the interrupted flow. */
  const acceptConsent = useCallback(async () => {
    setConsentModalVisible(false);
    try {
      await consent.grant();
    } catch {
      /* flow continues; the modal returns if persistence failed */
    }
    telemetry.logEvent({
      eventType: 'agent_consent_granted',
      currentRoute: navigation.getCurrentRoute(),
    });
    const entry = consentEntryRef.current;
    consentEntryRef.current = null;
    if (entry?.mode === 'text') {
      await submitTextTurn(entry.text, { speak: entry.speak });
    } else {
      await beginListening();
    }
  }, [beginListening, consent, navigation, submitTextTurn, telemetry]);

  /** The user declined consent: STT never starts. */
  const declineConsent = useCallback(() => {
    setConsentModalVisible(false);
    consentEntryRef.current = null;
    telemetry.logEvent({
      eventType: 'agent_consent_declined',
      currentRoute: navigation.getCurrentRoute(),
    });
  }, [navigation, telemetry]);

  /**
   * Speaks the result of a confirmed action (outside the turn): tries server
   * TTS with the active voice and degrades to device TTS.
   */
  const speakActionFeedback = useCallback(
    async (text: string) => {
      // Silent text mode: the bubble shows the feedback; skip the TTS
      // synthesis round-trip entirely.
      if (silentTurnRef.current) return;
      // speakReply now synthesizes client-generated text with the server voice
      // itself (single-voice guarantee), so feedback goes through the same path.
      await speakReply(text, null);
    },
    [speakReply],
  );

  /**
   * The user confirmed (modal button OR affirmative voice reply). Actions
   * declaring doubleConfirmation require a second confirmation before
   * actually executing.
   */
  const confirmPendingAction = useCallback(async () => {
    endConfirmationVoiceWindow('confirmation resolved');
    const pending = pendingConfirmationRef.current;
    if (!pending) {
      setPendingConfirmationMessage(null);
      setPendingConfirmationVoiceHint(null);
      return;
    }

    if (pending.remainingConfirmations > 1) {
      pending.remainingConfirmations -= 1;
      confirmationReaskedRef.current = false;
      const secondQuestion = messages.doubleConfirmationQuestion;
      setPendingConfirmationMessage(secondQuestion);
      setLastExchange((prev) =>
        prev ? { ...prev, replyText: secondQuestion } : prev,
      );
      devLog(invocationIdRef.current, 'double confirmation requested', pending.action.intent);
      // The second question is spoken and the voice flow reopens (same
      // policy: strict instruction, disabled → tap only); the modal stays
      // visible with the new text as the tactile fallback.
      await speakReply(secondQuestion, null);
      if (pendingConfirmationRef.current) await startConfirmationVoiceFlow();
      return;
    }

    pendingConfirmationRef.current = null;
    setPendingConfirmationMessage(null);
    setPendingConfirmationVoiceHint(null);

    const { action, context } = pending;
    const actionStartedAt = Date.now();
    const result = await executor.execute(action, context);
    telemetry.logEvent({
      eventType: result.idempotent
        ? 'action_idempotent'
        : result.success
          ? 'action_executed'
          : 'action_failed',
      userMessage: pending.userMessage,
      intentDetected: action.intent ?? null,
      actionExecuted: {
        type: action.type,
        intent: action.intent ?? null,
        confirmed: true,
        ...(result.error ? { error: result.error } : {}),
      },
      currentRoute: pending.routeAtInvocation,
      latencyMs: pending.latencyMs,
      latencySttMs: pending.latencySttMs,
      latencyActionMs: Date.now() - actionStartedAt,
      wasTruncated: pending.wasTruncated,
      contextChars: pending.contextChars,
      redactionsApplied: pending.redactions,
    });
    if (result.message) {
      setLastExchange((prev) => (prev ? { ...prev, replyText: result.message! } : prev));
      await speakActionFeedback(result.message);
    }

    // RESUME the autonomous chain if this sensitive action paused one — the
    // human confirmation requirement is fully preserved: the chain only
    // advances past a sensitive step AFTER the user confirmed and it executed.
    const chainState = chainStateRef.current;
    if (chainState) {
      chainStateRef.current = null;
      if (result.success && chaining.enabled) {
        telemetry.logEvent({
          eventType: 'agent_chain_step',
          intentDetected: action.intent ?? null,
          sessionId: sessionIdRef.current,
          chainStep: chainState.step,
        });
        if (chainState.pendingKey) chainState.visitedKeys.add(chainState.pendingKey);
        await runChainLoopRef.current?.({
          userMessage: chainState.userMessage,
          step: chainState.step,
          lastStep: chainState.pendingStep ?? chainState.lastStep,
          visitedKeys: chainState.visitedKeys,
        });
      } else if (!result.success) {
        telemetry.logEvent({
          eventType: 'agent_chain_aborted',
          sessionId: sessionIdRef.current,
          chainAbortReason: 'error',
        });
      }
    }
  }, [
    chaining,
    endConfirmationVoiceWindow,
    executor,
    messages.doubleConfirmationQuestion,
    speakActionFeedback,
    speakReply,
    startConfirmationVoiceFlow,
    telemetry,
  ]);

  /** The user cancelled (button, tap outside, back, or "no"): nothing runs. */
  const cancelPendingAction = useCallback(() => {
    endConfirmationVoiceWindow('confirmation cancelled');
    const pending = pendingConfirmationRef.current;
    pendingConfirmationRef.current = null;
    setPendingConfirmationMessage(null);
    setPendingConfirmationVoiceHint(null);
    // Declining a sensitive action stops any chain it was part of, cleanly.
    const chainState = chainStateRef.current;
    chainStateRef.current = null;
    if (chainState) {
      telemetry.logEvent({
        eventType: 'agent_chain_aborted',
        sessionId: sessionIdRef.current,
        chainAbortReason: 'user_interrupt',
      });
    }
    if (!pending) return;
    telemetry.logEvent({
      eventType: 'action_cancelled',
      userMessage: pending.userMessage,
      intentDetected: pending.action.intent ?? null,
      actionExecuted: { type: pending.action.type, intent: pending.action.intent ?? null },
      currentRoute: pending.routeAtInvocation,
    });
    // Immediate, cheap feedback: device TTS (one-word phrase). In silent
    // text mode speakReply is a no-op and the bubble shows it instead.
    setLastExchange((prev) => (prev ? { ...prev, replyText: messages.cancelled } : prev));
    void speakReply(messages.cancelled, null);
  }, [endConfirmationVoiceWindow, messages.cancelled, speakReply, telemetry]);

  // Cross-refs: the voice window resolves with the SAME functions as the
  // modal buttons (the tactile decision always wins).
  useEffect(() => {
    confirmPendingActionRef.current = confirmPendingAction;
    cancelPendingActionRef.current = cancelPendingAction;
  }, [confirmPendingAction, cancelPendingAction]);

  // ── Paged bubble history ─────────────────────────────────────────────────────
  // The bubble mounts one page (5 exchanges) and grows a page at a time when the
  // user scrolls to the top; loading is deferred behind a short spinner so old
  // messages stream in on demand and never all mount at once.
  const [exchangeWindowSize, setExchangeWindowSize] = useState(BUBBLE_PAGE_EXCHANGES);
  const [loadingOlderExchanges, setLoadingOlderExchanges] = useState(false);
  const loadOlderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (loadOlderTimerRef.current) clearTimeout(loadOlderTimerRef.current);
    },
    [],
  );

  const exchangeWindow = useMemo(
    () =>
      buildBubbleExchangeWindow(
        conversationRef.current,
        lastExchange,
        exchangeWindowSize,
        conversationRetentionOptions(conversationRetentionMinutes),
      ),
    // conversationEpoch: recompute after the persisted session is rehydrated.
    [lastExchange, exchangeWindowSize, conversationRetentionMinutes, conversationEpoch],
  );
  const recentExchanges = exchangeWindow.exchanges;
  const hasOlderExchanges = exchangeWindow.hasOlder;

  const loadOlderExchanges = useCallback(() => {
    if (loadOlderTimerRef.current || !hasOlderExchanges) return;
    setLoadingOlderExchanges(true);
    loadOlderTimerRef.current = setTimeout(() => {
      loadOlderTimerRef.current = null;
      setExchangeWindowSize((size) => size + BUBBLE_PAGE_EXCHANGES);
      setLoadingOlderExchanges(false);
    }, 350);
  }, [hasOlderExchanges]);

  const resetExchangeWindow = useCallback(() => {
    if (loadOlderTimerRef.current) {
      clearTimeout(loadOlderTimerRef.current);
      loadOlderTimerRef.current = null;
    }
    setLoadingOlderExchanges(false);
    setExchangeWindowSize(BUBBLE_PAGE_EXCHANGES);
  }, []);

  return {
    phase,
    isListening,
    showWaveform,
    showThinking,
    isBusy: showThinking || phase === 'speaking',
    volumeLevel: speech.volumeLevel,
    voiceAvailable: voice.isRecognitionAvailable(),
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
    confirmationModalVisible: pendingConfirmationMessage !== null,
    confirmationMessage: pendingConfirmationMessage ?? '',
    confirmationVoiceHint: pendingConfirmationVoiceHint,
    confirmPendingAction,
    cancelPendingAction,
    wakeWordListening,
  };
}
