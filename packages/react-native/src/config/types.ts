/**
 * SDK configuration — the single place where an app plugs everything in.
 *
 * Every host-app coupling of the original orchestrator is now an explicit
 * field here: manifest, adapters, locale, user context, quota gating, phase
 * lifecycle, error surface. The SDK has no implicit knowledge of any app.
 */
import type {
  ActionRegistries,
  AgentBackendClient,
  AgentMessages,
  AppManifest,
  ConfirmationLexicon,
  CredentialAutofillAdapter,
  MessageCatalog,
  NavigationAdapter,
  Sanitizer,
  StorageAdapter,
  TelemetryAdapter,
  VoiceAdapter,
} from '@fiodos/core';
import type { AgentUiMessages } from '../i18n/types';

export type AgentPhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'confirming';

/** Production-hardened timing values. Override only with good reason. */
export interface AgentTimings {
  /**
   * Watchdog: 'thinking' may never outlive this. Covers native STT sessions
   * that emit neither 'end' nor 'error' and any unhandled error path —
   * without it the orb can lock up forever.
   */
  thinkingWatchdogMs: number;
  /** Hard cap on a listening session. */
  maxListeningSeconds: number;
  /** Voice-confirmation listening window after speaking the question. */
  confirmationVoiceWindowMs: number;
  /** Grace period for a late transcript after the window closes. */
  confirmationTranscriptGraceMs: number;
  /**
   * Transcripts shorter than this are treated as noise. Kept at 2 so natural
   * short answers to the agent's own questions ("sí", "no", "ok", "ya") are
   * NEVER rejected as "too short" — they are valid turns, usually replies that
   * conversation memory resolves in context. (Matches the web SDK and the
   * confirmation-window threshold.)
   */
  minTranscriptChars: number;
}

export const DEFAULT_AGENT_TIMINGS: AgentTimings = {
  thinkingWatchdogMs: 20_000,
  maxListeningSeconds: 60,
  confirmationVoiceWindowMs: 8_000,
  confirmationTranscriptGraceMs: 3_000,
  minTranscriptChars: 2,
};

/**
 * Autonomous multi-step chaining. OFF by default: with `enabled: false` the orb
 * behaves exactly as before (one action per turn). When ON, after a successful
 * navigate/execute whose backend `task_status` is "in_progress", the orb takes
 * the next step on its own — capped at `maxSteps`, with no-progress detection,
 * and sensitive-confirmation pauses (which ALWAYS require the user).
 */
export interface AgentChaining {
  /** Master switch. Default false (retrocompatible). */
  enabled: boolean;
  /** Hard cap on steps per user request (safety). Default 6. */
  maxSteps: number;
  /** Pause between chained steps so the user can see each screen (ms). */
  dwellMs: number;
}

export const DEFAULT_AGENT_CHAINING: AgentChaining = {
  enabled: false,
  maxSteps: 6,
  dwellMs: 450,
};

/** Verdict of the app's per-turn gate (quota, plan limits…). */
export type TurnGateVerdict =
  | { ok: true }
  | {
      ok: false;
      /** Spoken/shown to the user. Omit to block silently (app shows its own UI). */
      message?: string;
    };

export interface FiodosAgentConfig {
  /** The app manifest (validated with validateManifest at integration time). */
  manifest: AppManifest;

  /** App locale (UI catalogs + fallback when user message language is ambiguous). MANDATORY — no default. */
  locale: string;
  /** Speech recognition locale, e.g. 'en-US', 'es-ES'. MANDATORY — no default. */
  sttLocale: string;
  /** Device-TTS fallback locale. Defaults to sttLocale. */
  ttsLocale?: string;

  // ── Adapters (dependency inversion — see @fiodos/core) ────────────────────
  navigation: NavigationAdapter;
  registries: ActionRegistries;
  backend: AgentBackendClient;
  voice: VoiceAdapter;
  storage: StorageAdapter;
  telemetry?: TelemetryAdapter;
  /** Host auth check, required by manifest actions declaring requiresAuth. */
  isAuthenticated?: () => boolean | null | undefined;
  /**
   * Platform saved-credential service powering the built-in SMART SIGN-IN
   * flow. React Native has no built-in default (keychain access needs a
   * native module): plug an adapter backed by e.g. react-native-keychain /
   * expo-secure-store + expo-local-authentication and the orb will fill the
   * app's login action from it (after the OS biometric prompt) instead of
   * collecting credentials in chat.
   */
  credentialAutofill?: CredentialAutofillAdapter | null;
  /**
   * Host end-user identity. Conversation memory is namespaced per identity
   * (hashed LOCALLY, never sent by this module): logout/account switches swap
   * to that identity's own conversation instead of leaking the previous one.
   */
  getUserId?: () => string | null;

  // ── Language / catalogs ────────────────────────────────────────────────────
  messages?: {
    catalogs?: Record<string, MessageCatalog>;
    overrides?: Partial<AgentMessages>;
  };
  uiMessages?: {
    catalogs?: Record<string, AgentUiMessages>;
    overrides?: Partial<AgentUiMessages>;
  };
  /** Yes/no word lists. Defaults to the built-in lexicon for `locale`. */
  confirmationLexicon?: ConfirmationLexicon;

  // ── Context ────────────────────────────────────────────────────────────────
  /**
   * Stable per-user context sent on every turn (the app decides what the
   * agent should know about the current user, in the agent's language).
   */
  getUserContextText?: () => string | null;
  /** PII sanitizer. Defaults to createSanitizer() — universal patterns only. */
  sanitizer?: Sanitizer;
  /** Combined context budget in chars (default: core's 1500). */
  contextMaxChars?: number;
  /**
   * Fallback context when no screen registered a snapshot: describe the
   * screen from the current route (labels are the app's, in its language).
   */
  routeContextFallback?: (route: string | null) => string | null;

  // ── App lifecycle hooks ────────────────────────────────────────────────────
  /**
   * Per-turn gate evaluated before listening starts (quota, plan limits).
   * Absent → always allowed.
   */
  gateTurn?: () => TurnGateVerdict;
  /** Called after a successful turn (use accounting, badges…). */
  onTurnCompleted?: () => void;
  /**
   * Phase transitions — e.g. pause the app's own audio while the agent
   * listens or speaks, resume on 'idle'.
   */
  onPhaseChange?: (phase: AgentPhase, previous: AgentPhase) => void;
  /** Error surface. Default: React Native Alert with the UI catalog title. */
  notifyError?: (message: string) => void;
  /** Called when the backend reports the usage quota exceeded. */
  onQuotaExceeded?: () => void;

  // ── Voice ──────────────────────────────────────────────────────────────────
  /** Server TTS voice id (static or live getter for preference contexts). */
  ttsVoice?: string | (() => string | undefined);

  /** Consent re-prompt version (bump when the consent scope changes). */
  consentVersion?: number;
  /** Timing overrides. */
  timings?: Partial<AgentTimings>;
  /** Autonomous multi-step chaining. OFF unless explicitly enabled. */
  chaining?: Partial<AgentChaining>;

  /**
   * Wake-word voice activation ("Oye, …" / "Hello, …").
   * When omitted, resolved automatically from manifest.policies and
   * `publishedVoiceActivation` (dashboard publish).
   */
  voiceActivation?: FiodosVoiceActivationConfig;

  /**
   * Live overrides from GET /v1/client/config (dashboard publish).
   * Merged over manifest.policies for voice activation.
   */
  publishedVoiceActivation?: {
    voiceActivationOffered?: boolean;
    voiceActivationPhrase?: string;
    /** Hidden phonetic variants generated at publish time (extra triggers). */
    voiceActivationPhrases?: string[];
  };
}

export interface FiodosVoiceActivationConfig {
  /** Developer enables this capability for their app. Default: false. */
  developerEnabled: boolean;
  /** Optional extra opt-in (e.g. integrator settings toggle). Omitted = assistant consent suffices. */
  isUserOptedIn?: () => boolean | Promise<boolean>;
  /** Override wake phrases; defaults from manifest / published phrase. */
  phrases?: string[];
  /** Resolved wake-word name (auto-filled by FiodosProvider). */
  wakePhraseName?: string;
  /** Display form, e.g. «Oye, MiApp» (auto-filled by FiodosProvider). */
  displayPhrase?: string;
  /** Consent paragraph when offered (auto-filled by FiodosProvider). */
  consentParagraph?: string;
}
