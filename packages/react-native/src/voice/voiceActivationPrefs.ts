/**
 * User opt-in preference for wake-word voice activation.
 *
 * Stored separately from assistant consent: the user must accept the
 * assistant consent first, then explicitly enable wake-word listening here.
 * Default is OFF (opt-in).
 */
import type { StorageAdapter } from '@fyodos/core';

export function voiceActivationPrefsKey(appId: string): string {
  return `@fyodos/${appId}/voice_activation_user_opt_in`;
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
