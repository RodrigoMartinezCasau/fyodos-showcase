/**
 * VoiceAdapter over the Expo stack — under '/expo' so Metro only resolves the
 * Expo packages in apps that use this adapter.
 *
 * STT: expo-speech-recognition's native module, loaded OPTIONALLY (no crash
 *      in Expo Go / environments without the module — recognition simply
 *      reports unavailable). The locale always comes from the caller.
 * TTS playback: base64 MP3 → cache file → expo-audio player (exclusive audio
 *      focus so the voice is loud and clear; one file per turn, deleted after).
 * Device TTS fallback: expo-speech, locale from the caller.
 */
import type {
  SpeechRecognitionEvents,
  StartListeningOptions,
  VoiceAdapter,
} from '@fyodos/core';

// ── Structural types for the lazily-required Expo modules ────────────────────

interface SpeechRecognitionModule {
  start(opts: { lang: string; interimResults: boolean; continuous: boolean }): void;
  stop(): void;
  abort(): void;
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
  addListener(event: string, cb: (e: unknown) => void): { remove(): void };
}

interface AudioPlayerLike {
  isLoaded: boolean;
  playing: boolean;
  muted: boolean;
  volume: number;
  replace(uri: string): void;
  play(): void;
  pause(): void;
  remove(): void;
  addListener(event: string, cb: (status: { isLoaded: boolean }) => void): { remove(): void };
}

interface ExpoAudioModule {
  createAudioPlayer(source: null, opts: { keepAudioSessionActive: boolean }): AudioPlayerLike;
  setAudioModeAsync(mode: object): Promise<void>;
  setIsAudioActiveAsync(active: boolean): Promise<void>;
}

interface ExpoFileSystemModule {
  cacheDirectory: string;
  writeAsStringAsync(uri: string, data: string, opts: { encoding: string }): Promise<void>;
  deleteAsync(uri: string, opts: { idempotent: boolean }): Promise<void>;
  EncodingType: { Base64: string };
}

interface ExpoSpeechModule {
  speak(
    text: string,
    opts: {
      language: string;
      rate?: number;
      pitch?: number;
      volume?: number;
      onDone?: () => void;
      onStopped?: () => void;
      onError?: () => void;
    },
  ): void;
  stop(): void;
}

/* eslint-disable @typescript-eslint/no-var-requires */
const { requireOptionalNativeModule } = require('expo') as {
  requireOptionalNativeModule<T>(name: string): T | null;
};
const ExpoAudio = require('expo-audio') as ExpoAudioModule;
const FileSystem = require('expo-file-system/legacy') as ExpoFileSystemModule;
const Speech = require('expo-speech') as ExpoSpeechModule;
/* eslint-enable @typescript-eslint/no-var-requires */

// Evaluated once at module load; null when the native module is not linked
// (Expo Go) — never throws, recognition just reports unavailable.
const speechModule = requireOptionalNativeModule<SpeechRecognitionModule>(
  'ExpoSpeechRecognition',
);

export interface ExpoVoiceAdapterOptions {
  /**
   * Report recognition as unavailable even if the module is linked — e.g.
   * iOS simulator, where the mic is unreliable (pass your own detection,
   * typically `__DEV__ && !Device.isDevice`).
   */
  forceRecognitionUnavailable?: boolean;
  /** Device-TTS fallback tuning. */
  deviceTtsRate?: number;
  deviceTtsPitch?: number;
  /** Cache file prefix for per-turn MP3s. */
  cacheFilePrefix?: string;
}

async function waitForPlayerLoaded(player: AudioPlayerLike, timeoutMs = 12_000): Promise<void> {
  if (player.isLoaded) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.remove();
      reject(new Error('audio_load_timeout'));
    }, timeoutMs);
    const sub = player.addListener('playbackStatusUpdate', (status) => {
      if (!status.isLoaded) return;
      clearTimeout(timer);
      sub.remove();
      resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
}

async function waitForPlaybackToFinish(player: AudioPlayerLike, maxMs = 90_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (player.playing) break;
    await sleep(40);
  }
  while (player.playing && Date.now() < deadline) {
    await sleep(80);
  }
}

/**
 * Exclusive audio focus so the assistant's voice is loud and clear
 * (`doNotMix` instead of `mixWithOthers`, which is meant for short effects
 * and plays very quietly on iPhone).
 */
async function ensureSpeakAudioMode(): Promise<void> {
  try {
    await ExpoAudio.setIsAudioActiveAsync(true);
    await ExpoAudio.setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: false,
      interruptionMode: 'doNotMix',
    });
  } catch {
    /* non-fatal: playback still works with the previous mode */
  }
}

export function createExpoVoiceAdapter(options: ExpoVoiceAdapterOptions = {}): VoiceAdapter {
  const prefix = options.cacheFilePrefix ?? 'fyodos-tts';

  // ── STT session state ───────────────────────────────────────────────────────
  let listeners: Array<{ remove(): void }> = [];
  let cancelled = false;
  let finalTranscript = '';
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Playback state ──────────────────────────────────────────────────────────
  let activePlayer: AudioPlayerLike | null = null;
  let playbackStopped = false;
  let speechEndResolver: (() => void) | null = null;

  function removeListeners(): void {
    listeners.forEach((l) => l.remove());
    listeners = [];
  }

  function clearMaxDurationTimer(): void {
    if (maxDurationTimer) {
      clearTimeout(maxDurationTimer);
      maxDurationTimer = null;
    }
  }

  function disposePlayer(): void {
    const p = activePlayer;
    activePlayer = null;
    if (!p) return;
    try {
      p.pause();
      p.remove();
    } catch {
      /* already released */
    }
  }

  const available = !options.forceRecognitionUnavailable && speechModule !== null;

  return {
    isRecognitionAvailable() {
      return available;
    },

    async startListening(opts: StartListeningOptions, events: SpeechRecognitionEvents) {
      if (!available || !speechModule) {
        events.onError?.(new Error('recognition_unavailable'));
        return;
      }

      const { granted } = await speechModule
        .requestPermissionsAsync()
        .catch(() => ({ granted: false }));
      if (!granted) {
        events.onError?.(new Error('permission_denied'));
        return;
      }

      cancelled = false;
      finalTranscript = '';

      // expo-speech-recognition does NOT emit a separate final event — the
      // final result arrives as a result with isFinal: true; deliver on 'end'.
      listeners.push(
        speechModule.addListener('result', (e: unknown) => {
          const ev = e as { results?: Array<{ transcript?: string; isFinal?: boolean }> };
          const r = ev.results?.[0];
          if (!r) return;
          const text = r.transcript ?? '';
          if (r.isFinal) {
            finalTranscript = text;
          } else {
            events.onInterim?.(text);
            if (text) finalTranscript = text;
          }
        }),
      );

      listeners.push(
        speechModule.addListener('end', () => {
          clearMaxDurationTimer();
          removeListeners();
          const transcript = finalTranscript;
          finalTranscript = '';
          if (cancelled) {
            events.onEnd?.();
            return;
          }
          if (transcript) events.onFinal?.(transcript);
          events.onEnd?.();
        }),
      );

      listeners.push(
        speechModule.addListener('error', (e: unknown) => {
          clearMaxDurationTimer();
          removeListeners();
          finalTranscript = '';
          events.onError?.(e);
        }),
      );

      if (opts.maxSeconds && opts.maxSeconds > 0) {
        maxDurationTimer = setTimeout(() => {
          maxDurationTimer = null;
          speechModule.stop();
        }, opts.maxSeconds * 1000);
      }

      speechModule.start({
        lang: opts.locale,
        interimResults: true,
        continuous: opts.continuous !== false,
      });
    },

    stopListening() {
      clearMaxDurationTimer();
      speechModule?.stop();
    },

    cancelListening() {
      cancelled = true;
      clearMaxDurationTimer();
      speechModule?.abort();
    },

    async playAudioBase64Mp3(base64: string) {
      if (!base64.length) return;
      disposePlayer();
      playbackStopped = false;
      await ensureSpeakAudioMode();

      const uri = `${FileSystem.cacheDirectory}${prefix}-${Date.now()}.mp3`;
      try {
        await FileSystem.writeAsStringAsync(uri, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const player = ExpoAudio.createAudioPlayer(null, { keepAudioSessionActive: true });
        activePlayer = player;
        player.replace(uri);
        await waitForPlayerLoaded(player);
        if (playbackStopped || activePlayer !== player) return;
        player.muted = false;
        player.volume = 1;
        player.play();
        await waitForPlaybackToFinish(player);
        if (activePlayer === player) disposePlayer();
      } finally {
        // One MP3 per turn: delete so cache files never accumulate.
        void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      }
    },

    speakWithDeviceTts(text: string, opts: { locale: string }) {
      return new Promise<void>((resolve) => {
        speechEndResolver = resolve;
        Speech.speak(text, {
          language: opts.locale,
          rate: options.deviceTtsRate ?? 0.88,
          pitch: options.deviceTtsPitch ?? 0.92,
          volume: 1,
          onDone: () => {
            speechEndResolver = null;
            resolve();
          },
          onStopped: () => {
            speechEndResolver = null;
            resolve();
          },
          onError: () => {
            speechEndResolver = null;
            resolve();
          },
        });
      });
    },

    stopPlayback() {
      playbackStopped = true;
      Speech.stop();
      speechEndResolver?.();
      speechEndResolver = null;
      disposePlayer();
    },
  };
}
