/**
 * Locale resolution for the UI catalog. Same policy as @fiodos/core:
 * exact match → base-language match → throw. No silent language fallback.
 */
import type { AgentUiMessages } from './types';
import { uiEn, uiEs } from './catalogs';

export const BUILT_IN_UI_CATALOGS: Readonly<Record<string, AgentUiMessages>> = {
  en: uiEn,
  es: uiEs,
};

export interface ResolveUiMessagesOptions {
  catalogs?: Record<string, AgentUiMessages>;
  overrides?: Partial<AgentUiMessages>;
}

export function resolveUiMessages(
  locale: string,
  options: ResolveUiMessagesOptions = {},
): AgentUiMessages {
  const externals = options.catalogs ?? {};
  const base = locale.split(/[-_]/)[0]?.toLowerCase() ?? locale.toLowerCase();
  const resolved =
    externals[locale] ??
    BUILT_IN_UI_CATALOGS[locale] ??
    externals[base] ??
    BUILT_IN_UI_CATALOGS[base];
  if (!resolved) {
    const known = [
      ...new Set([...Object.keys(BUILT_IN_UI_CATALOGS), ...Object.keys(externals)]),
    ].join(', ');
    throw new Error(
      `[fyodos] No UI message catalog for locale "${locale}". Available: ${known}. ` +
        `Register one via the uiMessages.catalogs config option.`,
    );
  }
  return options.overrides ? { ...resolved, ...options.overrides } : resolved;
}
