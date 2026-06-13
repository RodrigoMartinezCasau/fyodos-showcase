/**
 * Passive wake-word listening lifecycle — starts/stops based on consent,
 * developer config, user opt-in and agent phase.
 *
 * Audio is processed on-device via the platform STT module; no continuous
 * audio stream is sent to Fiodos servers during wake-word listening.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultWakePhrasesForLocale, type VoiceAdapter } from '@fyodos/core';
import type { ConsentManager } from '@fyodos/core';
import type { TelemetryAdapter } from '@fyodos/core';
import type { NavigationAdapter } from '@fyodos/core';

export interface VoiceActivationRuntimeConfig {
  /** Developer offers wake-word in this app (manifest / dashboard). */
  developerEnabled: boolean;
  /** User opt-in — must resolve true for listening to start. Default: false. */
  isUserOptedIn?: () => boolean | Promise<boolean>;
  /** Override wake phrases; defaults from agent locale. */
  phrases?: string[];
}

export interface UseWakeWordActivationOptions {
  enabled: boolean;
  voice: VoiceAdapter;
  sttLocale: string;
  agentLocale: string;
  voiceActivation?: VoiceActivationRuntimeConfig;
  phase: string;
  consent: ConsentManager;
  telemetry: TelemetryAdapter;
  navigation: NavigationAdapter;
  onWakeDetected: (trailingCommand: string) => void;
}

export function useWakeWordActivation({
  enabled,
  voice,
  sttLocale,
  agentLocale,
  voiceActivation,
  phase,
  consent,
  telemetry,
  navigation,
  onWakeDetected,
}: UseWakeWordActivationOptions): { wakeWordListening: boolean } {
  const [wakeWordListening, setWakeWordListening] = useState(false);
  const onWakeRef = useRef(onWakeDetected);
  onWakeRef.current = onWakeDetected;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const startingRef = useRef(false);

  const developerEnabled = voiceActivation?.developerEnabled === true;
  const phrases =
    voiceActivation?.phrases?.length
      ? voiceActivation.phrases
      : defaultWakePhrasesForLocale(agentLocale);

  const stopWakeWord = useCallback(() => {
    startingRef.current = false;
    voice.stopWakeWordDetection?.();
    setWakeWordListening(false);
  }, [voice]);

  const shouldListen = useCallback(async (): Promise<boolean> => {
    if (!enabled || !developerEnabled) return false;
    if (!voice.supportsWakeWordDetection?.()) return false;
    if (phaseRef.current !== 'idle') return false;
    if (!(await consent.hasConsented())) return false;
    const optedIn = voiceActivation?.isUserOptedIn
      ? await voiceActivation.isUserOptedIn()
      : false;
    return optedIn === true;
  }, [consent, developerEnabled, enabled, voice, voiceActivation]);

  const startWakeWord = useCallback(async () => {
    if (startingRef.current) return;
    if (!(await shouldListen())) {
      stopWakeWord();
      return;
    }
    if (voice.isWakeWordListening?.()) {
      setWakeWordListening(true);
      return;
    }
    startingRef.current = true;
    try {
      await voice.startWakeWordDetection?.(
        { locale: sttLocale, phrases },
        {
          onDetected: (command: string) => {
            setWakeWordListening(false);
            telemetry.logEvent({
              eventType: 'wake_word_detected',
              currentRoute: navigation.getCurrentRoute(),
            });
            onWakeRef.current(command);
          },
          onError: () => {
            setWakeWordListening(false);
            startingRef.current = false;
          },
        },
      );
      if (voice.isWakeWordListening?.()) setWakeWordListening(true);
    } catch {
      setWakeWordListening(false);
    } finally {
      startingRef.current = false;
    }
  }, [navigation, phrases, shouldListen, sttLocale, stopWakeWord, telemetry, voice]);

  // Start/stop when phase or config changes.
  useEffect(() => {
    if (phase !== 'idle') {
      stopWakeWord();
      return;
    }
    void startWakeWord();
    return () => {
      stopWakeWord();
    };
  }, [phase, developerEnabled, enabled, startWakeWord, stopWakeWord]);

  // Re-evaluate opt-in periodically when idle (user may toggle in settings).
  useEffect(() => {
    if (phase !== 'idle' || !developerEnabled) return;
    const id = setInterval(() => {
      void shouldListen().then((ok) => {
        if (!ok) stopWakeWord();
        else if (phaseRef.current === 'idle') void startWakeWord();
      });
    }, 4000);
    return () => clearInterval(id);
  }, [developerEnabled, phase, shouldListen, startWakeWord, stopWakeWord]);

  return { wakeWordListening };
}
