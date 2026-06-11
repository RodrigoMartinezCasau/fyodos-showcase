/**
 * FyodosProvider — resolves the SDK runtime from the integrator's config and
 * exposes it to useAgent(), the screen-context hooks and the UI components.
 *
 * Everything locale-dependent is resolved here ONCE (message catalogs, UI
 * catalog, confirmation lexicon) with the explicit-locale policy: unknown
 * locales throw at mount, never silently fall back to another language.
 */
import React, { createContext, useContext, useMemo } from 'react';
import { Alert } from 'react-native';
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
} from '@fyodos/core';
import type { AgentTimings, FyodosAgentConfig } from '../config/types';
import { DEFAULT_AGENT_TIMINGS } from '../config/types';
import { resolveUiMessages } from '../i18n/resolve';
import type { AgentUiMessages } from '../i18n/types';
import {
  createScreenContextStore,
  type ScreenContextStore,
} from '../context/screenContextStore';

export interface FyodosRuntime {
  config: FyodosAgentConfig;
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

const FyodosContext = createContext<FyodosRuntime | null>(null);

export function FyodosProvider({
  config,
  children,
}: {
  config: FyodosAgentConfig;
  children: React.ReactNode;
}) {
  const runtime = useMemo<FyodosRuntime>(() => {
    const manifestCheck = validateManifest(config.manifest);
    if (!manifestCheck.valid) {
      throw new Error(
        `[fyodos] Invalid manifest for "${config.manifest.appId}":\n- ` +
          manifestCheck.errors.join('\n- '),
      );
    }

    const messages = resolveMessages(config.locale, config.messages);
    const ui = resolveUiMessages(config.locale, config.uiMessages);
    const lexicon = config.confirmationLexicon ?? resolveConfirmationLexicon(config.locale);
    const sanitizer = config.sanitizer ?? createSanitizer();
    const telemetry = createSafeTelemetry(config.telemetry);
    const consent = createConsentManager({
      storage: config.storage,
      appId: config.manifest.appId,
      version: config.consentVersion,
    });
    const executor = createActionExecutor({
      manifest: config.manifest,
      registries: config.registries,
      navigation: config.navigation,
      messages,
      isAuthenticated: config.isAuthenticated,
    });
    const screenStore = createScreenContextStore({
      getCurrentRoute: () => config.navigation.getCurrentRoute(),
      routeFallback: config.routeContextFallback,
    });
    const notifyError =
      config.notifyError ?? ((message: string) => Alert.alert(ui.errorTitle, message));
    const getTtsVoice = () =>
      typeof config.ttsVoice === 'function' ? config.ttsVoice() : config.ttsVoice;

    return {
      config,
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

  return <FyodosContext.Provider value={runtime}>{children}</FyodosContext.Provider>;
}

export function useFyodosRuntime(): FyodosRuntime {
  const runtime = useContext(FyodosContext);
  if (!runtime) {
    throw new Error('[fyodos] FyodosProvider is missing above this component.');
  }
  return runtime;
}
