/**
 * Optional in-app opt-in for wake-word activation.
 * Not required by default — assistant consent + system mic permission suffice.
 * Use with `VoiceActivationSettings` only if the integrator adds a settings toggle.
 */
import type { StorageAdapter } from '@fiodos/core';

export function voiceActivationPrefsKey(appId: string): string {
  return `@fiodos/${appId}/voice_activation_user_opt_in`;
}

export async function loadVoiceActivationOptIn(
  storage: StorageAdapter,
  appId: string,
): Promise<boolean> {
  try {
    const raw = await storage.getItem(voiceActivationPrefsKey(appId));
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { enabled?: boolean };
    return parsed.enabled === true;
  } catch {
    return false;
  }
}

export async function saveVoiceActivationOptIn(
  storage: StorageAdapter,
  appId: string,
  enabled: boolean,
): Promise<void> {
  const payload = JSON.stringify({
    enabled,
    updatedAt: new Date().toISOString(),
  });
  await storage.setItem(voiceActivationPrefsKey(appId), payload);
}

export async function clearVoiceActivationOptIn(
  storage: StorageAdapter,
  appId: string,
): Promise<void> {
  await storage.removeItem(voiceActivationPrefsKey(appId));
}
