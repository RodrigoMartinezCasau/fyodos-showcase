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
  MessageCatalog,
  NavigationAdapter,
  Sanitizer,
  StorageAdapter,
  TelemetryAdapter,
  VoiceAdapter,
} from '@fyodos/core';
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

/** Verdict of the app's per-turn gate (quota, plan limits…). */
export type TurnGateVerdict =
  | { ok: true }
  | {
      ok: false;
      /** Spoken/shown to the user. Omit to block silently (app shows its own UI). */
      message?: string;
    };

export interface FyodosAgentConfig {
  /** The app manifest (validated with validateManifest at integration time). */
  manifest: AppManifest;

  /** Agent locale (reply language, message catalogs). MANDATORY — no default. */
  locale: string;
  /** Speech recognition locale, e.g. 'en-US', 'es-ES'. MANDATORY — no default. */
  sttLocale: string;
  /** Device-TTS fallback locale. Defaults to sttLocale. */
  ttsLocale?: string;

  // ── Adapters (dependency inversion — see @fyodos/core) ────────────────────
  navigation: NavigationAdapter;
  registries: ActionRegistries;
  backend: AgentBackendClient;
  voice: VoiceAdapter;
  storage: StorageAdapter;
  telemetry?: TelemetryAdapter;
  /** Host auth check, required by manifest actions declaring requiresAuth. */
  isAuthenticated?: () => boolean;

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

  /**
   * Wake-word voice activation ("Oye, …" / "Hello, …").
   * When omitted, resolved automatically from manifest.policies and
   * `publishedVoiceActivation` (dashboard publish).
   */
  voiceActivation?: FyodosVoiceActivationConfig;

  /**
   * Live overrides from GET /v1/client/config (dashboard publish).
   * Merged over manifest.policies for voice activation.
   */
  publishedVoiceActivation?: {
    voiceActivationOffered?: boolean;
    voiceActivationPhrase?: string;
  };
}

export interface FyodosVoiceActivationConfig {
  /** Developer enables this capability for their app. Default: false. */
  developerEnabled: boolean;
  /** Optional extra opt-in (e.g. integrator settings toggle). Omitted = assistant consent suffices. */
  isUserOptedIn?: () => boolean | Promise<boolean>;
  /** Override wake phrases; defaults from manifest / published phrase. */
  phrases?: string[];
  /** Resolved wake-word name (auto-filled by FyodosProvider). */
  wakePhraseName?: string;
  /** Display form, e.g. «Oye, MiApp» (auto-filled by FyodosProvider). */
  displayPhrase?: string;
  /** Consent paragraph when offered (auto-filled by FyodosProvider). */
  consentParagraph?: string;
}
