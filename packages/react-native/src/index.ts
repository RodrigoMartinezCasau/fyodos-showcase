/**
 * @fiodos/react-native — React Native bindings for the Fiodos agent.
 *
 * Main entry: depends only on react + react-native. Expo-specific adapters
 * (voice, expo-router navigation, AsyncStorage) live under
 * '@fiodos/react-native/expo' so Metro only resolves Expo packages in apps
 * that use them.
 */

// Configuration
export type {
  AgentPhase,
  AgentTimings,
  FiodosAgentConfig,
  FiodosVoiceActivationConfig,
  TurnGateVerdict,
} from './config/types';
export { DEFAULT_AGENT_TIMINGS } from './config/types';

// Provider + orchestrator
export { FiodosProvider, useFiodosRuntime } from './provider/FiodosProvider';
export type { FiodosRuntime } from './provider/FiodosProvider';
export { useAgent } from './hooks/useAgent';
export type { AgentExchange, UseAgentOptions, UseAgentResult } from './hooks/useAgent';

// Agent-to-agent: human approval of STRICT actions (uses the app credential,
// never an external agent token — see the hook's security note).
export { usePendingExternalApprovals } from './hooks/usePendingExternalApprovals';
export type {
  PendingExternalApproval,
  UsePendingExternalApprovalsOptions,
  UsePendingExternalApprovalsResult,
} from './hooks/usePendingExternalApprovals';

// Screen context
export type { AgentScreenSnapshot, ScreenContextStore } from './context/screenContextStore';
export { createScreenContextStore } from './context/screenContextStore';
export {
  useAgentScreenContext,
  useAgentScreenContextOwner,
  createFocusedScreenContextHook,
} from './context/hooks';

// Bridges (app state in React Contexts → imperative handlers)
export { createBridge } from './bridge/createBridge';
export type { Bridge } from './bridge/createBridge';
export { useRegisterBridge } from './bridge/useRegisterBridge';
export { createUiRegistry } from './bridge/createUiRegistry';
export type { UiRegistry } from './bridge/createUiRegistry';

// Backend HTTP client
export { createFiodosBackendClient, buildManifestPayload } from './api/backendClient';
export type { FiodosBackendClientOptions } from './api/backendClient';
export { createFiodosTelemetry } from './api/backendTelemetry';
export type { FiodosTelemetryOptions } from './api/backendTelemetry';
export { AgentApiError, isAgentApiError } from './api/errors';
export type { AgentApiErrorCode } from './api/errors';

// Navigation (react-navigation adapter is dependency-free — structural ref)
export { createReactNavigationAdapter } from './navigation/reactNavigation';
export type {
  ReactNavigationAdapterOptions,
  ReactNavigationContainerRefLike,
} from './navigation/reactNavigation';
export { parseRouteString, normalizePathname } from './navigation/parseRoute';

// Voice session (for custom UIs over a VoiceAdapter)
export { useSpeechSession } from './voice/useSpeechSession';
export type {
  SpeechSession,
  SpeechSessionOptions,
  SpeechSessionState,
} from './voice/useSpeechSession';
export {
  loadVoiceActivationOptIn,
  saveVoiceActivationOptIn,
  clearVoiceActivationOptIn,
  voiceActivationPrefsKey,
} from './voice/voiceActivationPrefs';
export { resolveVoiceActivationConfig } from './voice/resolveVoiceActivationConfig';
export type {
  PublishedVoiceActivation,
  ResolvedVoiceActivationConfig,
  ResolveVoiceActivationOptions,
} from './voice/resolveVoiceActivationConfig';
export { useVoiceActivationOptIn } from './voice/useVoiceActivationOptIn';
export { useWakeWordActivation } from './voice/useWakeWordActivation';
export type {
  VoiceActivationRuntimeConfig,
  UseWakeWordActivationOptions,
} from './voice/useWakeWordActivation';

// Haptics (unified orb feedback; baseline RN Vibration impl)
export { createRnOrbHaptics } from './haptics';

// UI
export { AgentOrb } from './components/AgentOrb';
export type { AgentOrbProps } from './components/AgentOrb';
export { AgentLayer } from './components/AgentLayer';
export type { AgentLayerProps } from './components/AgentLayer';
export { VoiceWaveform } from './components/VoiceWaveform';
export type { VoiceWaveformProps } from './components/VoiceWaveform';
export { ActionConfirmationModal } from './components/ActionConfirmationModal';
export type { ActionConfirmationModalProps } from './components/ActionConfirmationModal';
export { ConsentModal } from './components/ConsentModal';
export type { ConsentModalProps } from './components/ConsentModal';
export { VoiceActivationSettings } from './components/VoiceActivationSettings';
export type { VoiceActivationSettingsProps } from './components/VoiceActivationSettings';
export { AgentTextBubble } from './components/AgentTextBubble';
export type { AgentTextBubbleProps } from './components/AgentTextBubble';
export { resolveImageDataUrlForDisplay, isDisplayableImageUri } from './utils/imageUri';
export {
  DEFAULT_MODAL_THEME,
  DEFAULT_ORB_THEME,
} from './components/theme';
export type { AgentModalTheme, AgentOrbTheme } from './components/theme';

// UI i18n
export type { AgentUiMessages } from './i18n/types';
export { resolveUiMessages, BUILT_IN_UI_CATALOGS } from './i18n/resolve';
export type { ResolveUiMessagesOptions } from './i18n/resolve';
export { uiEn, uiEs } from './i18n/catalogs';
