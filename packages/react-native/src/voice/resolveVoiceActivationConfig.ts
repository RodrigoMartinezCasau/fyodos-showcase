import {
  buildVoiceActivationConsentParagraph,
  buildWakePhrasesForLocale,
  formatWakePhraseDisplay,
  resolveVoiceActivationPolicies,
  type AppManifest,
  type VoiceActivationPolicySource,
} from '@fyodos/core';
import type { VoiceActivationRuntimeConfig } from './useWakeWordActivation';

export interface PublishedVoiceActivation extends VoiceActivationPolicySource {}

export interface ResolvedVoiceActivationConfig extends VoiceActivationRuntimeConfig {
  /** Wake-word name after the prefix, e.g. "MiApp". */
  wakePhraseName: string;
  /** Display form for UI, e.g. «Oye, MiApp». */
  displayPhrase: string;
  /** Consent paragraph when the developer offers wake-word activation. */
  consentParagraph: string;
}

export interface ResolveVoiceActivationOptions {
  manifest: AppManifest;
  locale: string;
  /** Published dashboard config — overrides manifest.policies when present. */
  published?: PublishedVoiceActivation | null;
}

/**
 * Builds voice-activation runtime config from manifest + optional published
 * dashboard overrides. Used automatically by FyodosProvider when integrators
 * omit `config.voiceActivation`.
 *
 * Wake-word listening starts after assistant consent (ConsentModal). No separate
 * in-app toggle is required; users can revoke via system microphone settings.
 * Integrators may pass `voiceActivation.isUserOptedIn` for an optional settings UI.
 */
export function resolveVoiceActivationConfig(
  options: ResolveVoiceActivationOptions,
): ResolvedVoiceActivationConfig {
  const { manifest, locale, published } = options;
  const { offered, phraseName } = resolveVoiceActivationPolicies(manifest, published);
  const phrases = buildWakePhrasesForLocale(phraseName, locale);
  const displayPhrase = formatWakePhraseDisplay(phraseName, locale);

  return {
    developerEnabled: offered,
    phrases,
    wakePhraseName: phraseName,
    displayPhrase,
    consentParagraph: buildVoiceActivationConsentParagraph(phraseName, locale),
  };
}
