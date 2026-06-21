/**
 * Internal hook: wraps a VoiceAdapter's recognition into the speech-session
 * state machine the orchestrator depends on.
 *
 * States mirror the production-hardened flow:
 *   idle → recording → transcribing → (transcript | nothing) → idle
 *
 * The volume level is intentionally CONSTANT while recording: the waveform
 * generates its own motion on the UI thread. (A real-volume interval at 7 Hz
 * used to re-render the whole orb tree and lag heavy screens.)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceAdapter } from '@fiodos/core';

export type SpeechSessionState = 'idle' | 'recording' | 'transcribing';

export interface SpeechSessionOptions {
  adapter: VoiceAdapter;
  /** STT locale — always explicit, from the SDK config. */
  locale: string;
  maxSeconds: number;
  onTranscript: (text: string) => void;
  /** Recognition error (permission denied, native failure, unavailable). */
  onError?: (error: unknown) => void;
}

export interface SpeechSession {
  state: SpeechSessionState;
  interimText: string;
  volumeLevel: number;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
}

export function useSpeechSession(options: SpeechSessionOptions): SpeechSession {
  const { adapter, locale, maxSeconds } = options;
  const [state, setState] = useState<SpeechSessionState>('idle');
  const [interimText, setInterimText] = useState('');
  const [volumeLevel, setVolumeLevel] = useState(0);

  const stateRef = useRef<SpeechSessionState>('idle');
  const onTranscriptRef = useRef(options.onTranscript);
  onTranscriptRef.current = options.onTranscript;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;

  const setStateSafe = useCallback((next: SpeechSessionState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const resetToIdle = useCallback(() => {
    setStateSafe('idle');
    setInterimText('');
    setVolumeLevel(0);
  }, [setStateSafe]);

  const start = useCallback(async () => {
    if (stateRef.current !== 'idle') return;
    setInterimText('');
    setStateSafe('recording');
    setVolumeLevel(0.85);

    await adapter.startListening(
      { locale, continuous: true, maxSeconds },
      {
        onInterim: (text) => setInterimText(text),
        onFinal: (text) => {
          resetToIdle();
          if (text.trim()) onTranscriptRef.current(text);
        },
        onEnd: () => {
          // End without a final transcript path (or after it): release state.
          if (stateRef.current !== 'idle') resetToIdle();
        },
        onError: (error) => {
          resetToIdle();
          onErrorRef.current?.(error);
        },
      },
    );
  }, [adapter, locale, maxSeconds, resetToIdle, setStateSafe]);

  const stop = useCallback(() => {
    if (stateRef.current !== 'recording') return;
    setStateSafe('transcribing');
    setVolumeLevel(0);
    adapter.stopListening();
  }, [adapter, setStateSafe]);

  const cancel = useCallback(() => {
    adapter.cancelListening();
    resetToIdle();
  }, [adapter, resetToIdle]);

  useEffect(
    () => () => {
      adapter.cancelListening();
    },
    [adapter],
  );

  return { state, interimText, volumeLevel, start, stop, cancel };
}
