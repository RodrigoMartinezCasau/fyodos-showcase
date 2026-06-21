/**
 * FiodosProvider — resolves the SDK runtime from the integrator's config and
 * exposes it to useAgent(), the screen-context hooks and the UI components.
 *
 * Everything locale-dependent is resolved here ONCE (message catalogs, UI
 * catalog, confirmation lexicon) with the explicit-locale policy: unknown
 * locales throw at mount, never silently fall back to another language.
 */
import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { Alert, Platform } from 'react-native';
import {
  createActionExecutor,
  createConsentManager,
  createSafeTelemetry,
  createSanitizer,
  resolveConfirmationLexicon,
  resolveMessages,
  validateManifest,
  type ActionExecutor,
  type AgentMessages,
  type ConfirmationLexicon,
  type ConsentManager,
  type Sanitizer,
  type TelemetryAdapter,
} from '@fiodos/core';
import type { AgentTimings, FiodosAgentConfig } from '../config/types';
import { DEFAULT_AGENT_TIMINGS } from '../config/types';
import { resolveUiMessages } from '../i18n/resolve';
import type { AgentUiMessages } from '../i18n/types';
import {
  createScreenContextStore,
  type ScreenContextStore,
} from '../context/screenContextStore';
import { resolveVoiceActivationConfig } from '../voice/resolveVoiceActivationConfig';

function withResolvedVoiceActivation(config: FiodosAgentConfig): FiodosAgentConfig {
  if (config.voiceActivation) return config;
  return {
    ...config,
    voiceActivation: resolveVoiceActivationConfig({
      manifest: config.manifest,
      locale: config.locale,
      published: config.publishedVoiceActivation,
    }),
  };
}

export interface FiodosRuntime {
  config: FiodosAgentConfig;
  messages: AgentMessages;
  ui: AgentUiMessages;
  lexicon: ConfirmationLexicon;
  sanitizer: Sanitizer;
  telemetry: TelemetryAdapter;
  consent: ConsentManager;
  executor: ActionExecutor;
  timings: AgentTimings;
  screenStore: ScreenContextStore;
  notifyError: (message: string) => void;
  getTtsVoice: () => string | undefined;
}

const FiodosContext = createContext<FiodosRuntime | null>(null);

export function FiodosProvider({
  config,
  children,
}: {
  config: FiodosAgentConfig;
  children: React.ReactNode;
}) {
  const runtime = useMemo<FiodosRuntime>(() => {
    const resolvedConfig = withResolvedVoiceActivation(config);
    const manifestCheck = validateManifest(resolvedConfig.manifest);
    if (!manifestCheck.valid) {
      throw new Error(
        `[fyodos] Invalid manifest for "${resolvedConfig.manifest.appId}":\n- ` +
          manifestCheck.errors.join('\n- '),
      );
    }

    const messages = resolveMessages(resolvedConfig.locale, resolvedConfig.messages);
    const ui = resolveUiMessages(resolvedConfig.locale, resolvedConfig.uiMessages);
    const lexicon = resolvedConfig.confirmationLexicon ?? resolveConfirmationLexicon(resolvedConfig.locale);
    const sanitizer = resolvedConfig.sanitizer ?? createSanitizer();
    const telemetry = createSafeTelemetry(resolvedConfig.telemetry);
    const consent = createConsentManager({
      storage: resolvedConfig.storage,
      appId: resolvedConfig.manifest.appId,
      version: resolvedConfig.consentVersion,
    });
    const executor = createActionExecutor({
      manifest: resolvedConfig.manifest,
      registries: resolvedConfig.registries,
      navigation: resolvedConfig.navigation,
      messages,
      isAuthenticated: resolvedConfig.isAuthenticated,
    });
    const screenStore = createScreenContextStore({
      getCurrentRoute: () => resolvedConfig.navigation.getCurrentRoute(),
      routeFallback: resolvedConfig.routeContextFallback,
    });
    const notifyError =
      resolvedConfig.notifyError ?? ((message: string) => Alert.alert(ui.errorTitle, message));
    const getTtsVoice = () =>
      typeof resolvedConfig.ttsVoice === 'function' ? resolvedConfig.ttsVoice() : resolvedConfig.ttsVoice;

    return {
      config: resolvedConfig,
      messages,
      ui,
      lexicon,
      sanitizer,
      telemetry,
      consent,
      executor,
      timings: { ...DEFAULT_AGENT_TIMINGS, ...config.timings },
      screenStore,
      notifyError,
      getTtsVoice,
    };
  }, [config]);

  // Heartbeat: prove the orb actually booted inside the running app so the
  // dashboard onboarding can confirm a real install (manifest alone is not
  // proof). Best-effort and fired once per mount; never blocks the orb.
  useEffect(() => {
    const platform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'mobile';
    void runtime.config.backend.reportOrbSeen?.(platform);
  }, [runtime]);

  return <FiodosContext.Provider value={runtime}>{children}</FiodosContext.Provider>;
}

export function useFiodosRuntime(): FiodosRuntime {
  const runtime = useContext(FiodosContext);
  if (!runtime) {
    throw new Error('[fyodos] FiodosProvider is missing above this component.');
  }
  return runtime;
}
