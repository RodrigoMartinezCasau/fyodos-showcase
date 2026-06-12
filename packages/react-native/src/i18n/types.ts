/**
 * UI-level message catalog for the React Native layer (alerts, modals,
 * accessibility). Same i18n rule as the core: no privileged locale — the
 * integrator picks the locale explicitly; en/es ship built-in; any other
 * locale is registered without touching the SDK.
 */

export interface AgentUiMessages {
  /** Title of the assistant error alert. */
  errorTitle: string;
  /** Spoken transcript too short / empty (noise). */
  sttTooShort: string;
  /** Recording closed but no transcript ever arrived. */
  sttNoTranscript: string;
  /** No real speech recognition in this environment. */
  sttUnavailable: string;
  /** Microphone permission denied. */
  micPermissionDenied: string;
  /** Backend returned an empty reply. */
  emptyReply: string;
  /** Turn failed or timed out — generic retry message. */
  turnFailed: string;
  /** 401/403 from the backend. */
  sessionExpired: string;
  /** 429 rate limited. */
  rateLimited: string;
  /** Usage quota exceeded. */
  quotaExceeded: string;
  /** Network unreachable. */
  noConnection: string;
  /** 5xx / endpoint missing. */
  serverUnavailable: string;
  /** Anything else. */
  genericError: string;
  /** Re-ask suffix when the spoken confirmation was ambiguous. */
  confirmationSayYesNo: string;
  /** Confirmation modal. */
  confirmTitle: string;
  confirmLabel: string;
  cancelLabel: string;
  /**
   * Consent modal. Neutral defaults; integrators SHOULD override naming the
   * concrete AI providers they use (GDPR transparency).
   */
  consentTitle: string;
  consentBody: string;
  consentBodySecondary: string;
  consentAccept: string;
  consentDecline: string;
  /** Orb accessibility. */
  orbAccessibilityLabel: string;
  orbHintIdle: string;
  orbHintListening: string;
  /** Text bubble (typed input + text reply). */
  textInputPlaceholder: string;
  textSendLabel: string;
  textPanelCloseLabel: string;
  keyboardChipLabel: string;
}
