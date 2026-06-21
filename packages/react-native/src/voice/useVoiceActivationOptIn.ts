import { useCallback, useEffect, useState } from 'react';
import { useFiodosRuntime } from '../provider/FiodosProvider';
import { loadVoiceActivationOptIn, saveVoiceActivationOptIn } from './voiceActivationPrefs';

/** Reactive user opt-in for wake-word activation (Settings screens). */
export function useVoiceActivationOptIn(): {
  optedIn: boolean;
  loading: boolean;
  setOptedIn: (enabled: boolean) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const { config } = useFiodosRuntime();
  const [optedIn, setOptedInState] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const enabled = await loadVoiceActivationOptIn(config.storage, config.manifest.appId);
    setOptedInState(enabled);
  }, [config.manifest.appId, config.storage]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const enabled = await loadVoiceActivationOptIn(config.storage, config.manifest.appId);
        if (!cancelled) setOptedInState(enabled);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config.manifest.appId, config.storage]);

  const setOptedIn = useCallback(
    async (enabled: boolean) => {
      await saveVoiceActivationOptIn(config.storage, config.manifest.appId, enabled);
      setOptedInState(enabled);
    },
    [config.manifest.appId, config.storage],
  );

  return { optedIn, loading, setOptedIn, refresh };
}
