/**
 * FiodosExpoAgent — the one-line orb mount for Expo Router apps.
 *
 * This is the React Native counterpart of the web SDK's <FiodosAgent/>: a single
 * self-contained component that wires the whole orb (provider + floating layer +
 * Expo adapters + dashboard-published appearance) so an integrator — or the
 * `@fiodos/cli analyze` auto-mount — only has to wrap their root layout:
 *
 *   import { FiodosExpoAgent } from '@fiodos/react-native/expo';
 *   import manifest from '../fyodos/manifest.json';
 *
 *   export default function RootLayout() {
 *     return (
 *       <FiodosExpoAgent manifest={manifest as any}>
 *         <Stack />
 *       </FiodosExpoAgent>
 *     );
 *   }
 *
 * It reads EXPO_PUBLIC_FYODOS_API_KEY / EXPO_PUBLIC_FYODOS_API_URL by default
 * (override via props), fetches the orb design published from the dashboard, and
 * uses empty action registries by default (navigation works out of the box;
 * app-specific actions are wired separately). Requires the app to have
 * react-native-safe-area-context mounted above it (standard in Expo apps).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  mapPublishedConfigToOrbProps,
  resolveOrbBackgroundColor,
  resolveOrbLayerInsets,
  type ActionRegistries,
  type AppManifest,
  type OrbLogoTransform,
  type OrbScreenPosition,
  type PublishedClientConfig,
} from '@fiodos/core';
import { FiodosProvider } from '../provider/FiodosProvider';
import { AgentLayer } from '../components/AgentLayer';
import { AgentOrb } from '../components/AgentOrb';
import { DEFAULT_ORB_THEME, type AgentModalTheme, type AgentOrbTheme } from '../components/theme';
import { createFiodosBackendClient } from '../api/backendClient';
import { createFiodosTelemetry } from '../api/backendTelemetry';
import { resolveImageDataUrlForDisplay } from '../utils/imageUri';
import type { FiodosAgentConfig } from '../config/types';
import { createAsyncStorageAdapter } from './asyncStorage';
import {
  createExpoRouterNavigationAdapter,
  ExpoRouterRouteTracker,
} from './expoRouterNavigation';
import { createExpoVoiceAdapter } from './expoVoiceAdapter';

declare const __DEV__: boolean;
// Expo injects EXPO_PUBLIC_* into process.env at build time; the SDK builds
// without @types/node, so declare the minimal shape we read.
declare const process: { env: Record<string, string | undefined> };

const DEFAULT_API_URL = 'https://api.fyodos.com';

/** Best-effort STT/TTS locale from a bare UI locale (e.g. 'es' → 'es-ES'). */
function sttLocaleFor(locale: string): string {
  const l = (locale || '').toLowerCase();
  if (l.startsWith('es')) return 'es-ES';
  if (l.startsWith('en')) return 'en-US';
  if (l.includes('-')) return l;
  return 'en-US';
}

interface RemoteOrbAppearance {
  theme: Partial<AgentOrbTheme>;
  modalTheme?: Partial<AgentModalTheme>;
  logoDataUrl: string | null;
  logoTransform: OrbLogoTransform | null;
  screenPosition?: OrbScreenPosition;
}

interface PublishedVoiceActivation {
  voiceActivationOffered?: boolean;
  voiceActivationPhrase?: string;
}

export interface FiodosExpoAgentProps {
  /** The app manifest published by `fiodos analyze` (imported from fyodos/manifest.json). */
  manifest: AppManifest;
  /** Orb key. Defaults to process.env.EXPO_PUBLIC_FYODOS_API_KEY. */
  apiKey?: string;
  /** Backend URL. Defaults to process.env.EXPO_PUBLIC_FYODOS_API_URL or production. */
  baseUrl?: string;
  /** UI locale. Default 'en'. */
  locale?: string;
  /** Speech locale, e.g. 'es-ES'. Default derived from locale. */
  sttLocale?: string;
  /**
   * App-specific action handlers. Default {} (navigation-only: the orb can open
   * screens from the manifest, custom actions are added later). */
  registries?: ActionRegistries;
  /** Host auth check for manifest actions that declare requiresAuth. */
  isAuthenticated?: () => boolean;
  /** Stable per-user context the agent should know (in the agent's language). */
  getUserContextText?: () => string | null;
  /** Consent paragraphs shown before first use. */
  consentParagraphs?: string[];
  /** App-level orb visibility (auth, hidden routes…). Default true. */
  visible?: boolean;
  /** Fallback route for "back" when there is nothing to pop. */
  backFallbackRoute?: string;
  children: React.ReactNode;
}

const EMPTY_REGISTRIES: ActionRegistries = {} as ActionRegistries;

export function FiodosExpoAgent({
  manifest,
  apiKey,
  baseUrl,
  locale = 'en',
  sttLocale,
  registries,
  isAuthenticated,
  getUserContextText,
  consentParagraphs,
  visible = true,
  backFallbackRoute,
  children,
}: FiodosExpoAgentProps) {
  const resolvedKey = apiKey ?? process.env.EXPO_PUBLIC_FYODOS_API_KEY;
  const resolvedUrl = baseUrl ?? process.env.EXPO_PUBLIC_FYODOS_API_URL ?? DEFAULT_API_URL;

  // Adapters + backend are stable for the lifetime of the mount.
  const stable = useMemo(() => {
    const navigation = createExpoRouterNavigationAdapter(
      backFallbackRoute ? { backFallbackRoute } : {},
    );
    const storage = createAsyncStorageAdapter();
    const voice = createExpoVoiceAdapter({});
    const backend = createFiodosBackendClient({ baseUrl: resolvedUrl, apiKey: resolvedKey });
    const telemetry = createFiodosTelemetry({ baseUrl: resolvedUrl, apiKey: resolvedKey });
    return { navigation, storage, voice, backend, telemetry };
  }, [resolvedUrl, resolvedKey, backFallbackRoute]);

  const { remoteOrb, publishedVoiceActivation } = usePublishedConfig(resolvedUrl, resolvedKey);

  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const orbDiameter = remoteOrb?.theme?.size ?? DEFAULT_ORB_THEME.size;

  const layerInsets = useMemo(
    () =>
      resolveOrbLayerInsets({
        viewportWidth: width,
        viewportHeight: height,
        safeAreaTop: insets.top,
        safeAreaBottom: insets.bottom,
        safeAreaLeft: insets.left,
        safeAreaRight: insets.right,
        orbDiameter,
        position: remoteOrb?.screenPosition,
      }),
    [width, height, insets.top, insets.bottom, insets.left, insets.right, orbDiameter, remoteOrb?.screenPosition],
  );

  const config = useMemo<FiodosAgentConfig>(
    () => ({
      manifest,
      locale,
      sttLocale: sttLocale ?? sttLocaleFor(locale),
      navigation: stable.navigation,
      registries: registries ?? EMPTY_REGISTRIES,
      backend: stable.backend,
      voice: stable.voice,
      storage: stable.storage,
      telemetry: stable.telemetry,
      isAuthenticated,
      getUserContextText,
      publishedVoiceActivation: publishedVoiceActivation ?? undefined,
    }),
    [manifest, locale, sttLocale, stable, registries, isAuthenticated, getUserContextText, publishedVoiceActivation],
  );

  return (
    <FiodosProvider config={config}>
      <ExpoRouterRouteTracker adapter={stable.navigation} />
      {children}
      <AgentLayer
        visible={visible}
        bottom={layerInsets.bottom}
        right={layerInsets.right}
        orbProps={{
          theme: remoteOrb?.theme,
          modalTheme: remoteOrb?.modalTheme,
          logoDataUrl: remoteOrb?.logoDataUrl ?? null,
          logoTransform: remoteOrb?.logoTransform ?? null,
          consentParagraphs,
        }}
      />
    </FiodosProvider>
  );
}

/**
 * Fetch the dashboard-published orb appearance + voice-activation policy. Refetch
 * when the app returns to the foreground so design changes land without a rebuild.
 */
function usePublishedConfig(
  baseUrl: string,
  apiKey: string | undefined,
): { remoteOrb: RemoteOrbAppearance | null; publishedVoiceActivation: PublishedVoiceActivation | null } {
  const [remoteOrb, setRemoteOrb] = useState<RemoteOrbAppearance | null>(null);
  const [publishedVoiceActivation, setPublishedVoiceActivation] =
    useState<PublishedVoiceActivation | null>(null);

  const client = useMemo(
    () => createFiodosBackendClient({ baseUrl, apiKey }),
    [baseUrl, apiKey],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await client.fetchPublishedConfig?.();
        if (!alive || !res?.published) return;
        const published = res.published as PublishedClientConfig & PublishedVoiceActivation;
        const mapped = mapPublishedConfigToOrbProps(published);
        const bg = resolveOrbBackgroundColor({
          colorKey: mapped.theme.colorKey,
          accentColor: mapped.theme.accentColor,
          backgroundColor: mapped.theme.backgroundColor,
        });
        const logoUri = mapped.logoDataUrl
          ? await resolveImageDataUrlForDisplay(mapped.logoDataUrl, 'fyodos-orb-logo.png')
          : null;
        const chipRaw = mapped.theme.keyboardChip?.iconImageDataUrl ?? null;
        const chipIconUri = chipRaw
          ? await resolveImageDataUrlForDisplay(chipRaw, 'fyodos-chip-icon.png')
          : null;
        const keyboardChip = mapped.theme.keyboardChip
          ? { ...mapped.theme.keyboardChip, iconImageDataUrl: chipIconUri }
          : undefined;
        if (!alive) return;
        setRemoteOrb({
          theme: { ...mapped.theme, backgroundColor: bg, keyboardChip },
          modalTheme: mapped.modalTheme,
          logoDataUrl: logoUri,
          logoTransform: mapped.logoTransform,
          screenPosition: mapped.screenPosition,
        });
        setPublishedVoiceActivation({
          voiceActivationOffered: published.voiceActivationOffered,
          voiceActivationPhrase: published.voiceActivationPhrase,
        });
      } catch (e) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
          console.warn('[fyodos] published config fetch failed', e instanceof Error ? e.message : e);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [client]);

  return { remoteOrb, publishedVoiceActivation };
}
