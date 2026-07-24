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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  type StorageAdapter,
} from '@fiodos/core';
import { FiodosProvider } from '../provider/FiodosProvider';
import { AgentLayer } from '../components/AgentLayer';
import { AgentOrb } from '../components/AgentOrb';
import { DEFAULT_ORB_THEME, type AgentModalTheme, type AgentOrbTheme } from '../components/theme';
import { ensureContactFiodosAction, withContactFiodosHandler } from '@fiodos/core';
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
import { createExpoOrbHaptics } from './expoOrbHaptics';

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
  /** Hidden phonetic variants generated at publish time (extra triggers). */
  voiceActivationPhrases?: string[];
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
  isAuthenticated?: () => boolean | null | undefined;
  /**
   * Fine-grained session capability flags (audience map, e.g.
   * { has_payment_method: true }). Boolean flags only; sent with each turn so
   * the orb shows this user only THEIR available actions.
   */
  getSessionCapabilities?: () => Record<string, boolean> | null | undefined;
  /** Stable per-user context the agent should know (in the agent's language). */
  getUserContextText?: () => string | null;
  /**
   * Host end-user identity. Conversation memory is namespaced per identity
   * (hashed locally on the device): logout/account switches swap to that
   * identity's own conversation instead of leaking the previous one. Also sent
   * as x-user-id for rate limiting / telemetry correlation.
   */
  getUserId?: () => string | null;
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
  getSessionCapabilities,
  getUserContextText,
  getUserId,
  consentParagraphs,
  visible = true,
  backFallbackRoute,
  children,
}: FiodosExpoAgentProps) {
  const resolvedKey = apiKey ?? process.env.EXPO_PUBLIC_FYODOS_API_KEY;
  const resolvedUrl = baseUrl ?? process.env.EXPO_PUBLIC_FYODOS_API_URL ?? DEFAULT_API_URL;

  // Live identity resolver behind a stable ref: hosts often pass an inline
  // arrow function, which must not re-create the adapters on every render.
  const getUserIdRef = useRef(getUserId);
  getUserIdRef.current = getUserId;
  const stableGetUserId = useCallback(() => getUserIdRef.current?.() ?? null, []);

  // Adapters + backend are stable for the lifetime of the mount.
  const stable = useMemo(() => {
    const navigation = createExpoRouterNavigationAdapter(
      backFallbackRoute ? { backFallbackRoute } : {},
    );
    const storage = createAsyncStorageAdapter();
    const voice = createExpoVoiceAdapter({});
    const backend = createFiodosBackendClient({
      baseUrl: resolvedUrl,
      apiKey: resolvedKey,
      getUserId: stableGetUserId,
    });
    const telemetry = createFiodosTelemetry({
      baseUrl: resolvedUrl,
      apiKey: resolvedKey,
      getUserId: stableGetUserId,
    });
    return { navigation, storage, voice, backend, telemetry };
  }, [resolvedUrl, resolvedKey, backFallbackRoute, stableGetUserId]);

  const { remoteOrb, publishedVoiceActivation, orbProfile, ready: orbReady } = usePublishedConfig(
    resolvedUrl,
    resolvedKey,
    stable.storage,
  );

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
    () => {
      // Internal orbs only. When published config reports the profile, inject
      // or strip accordingly; until then repair-only (never invent for public).
      const guaranteedManifest = ensureContactFiodosAction(manifest, {
        enabled:
          orbProfile === 'internal' ? true : orbProfile === 'public' ? false : undefined,
      });
      const guaranteedRegistries = withContactFiodosHandler(
        registries ?? EMPTY_REGISTRIES,
        (message) => {
          if (!stable.backend.contactFiodos) {
            return Promise.reject(new Error('contact_fiodos_unavailable'));
          }
          return stable.backend.contactFiodos(message);
        },
      );
      return {
        manifest: guaranteedManifest,
        locale,
        sttLocale: sttLocale ?? sttLocaleFor(locale),
        navigation: stable.navigation,
        registries: guaranteedRegistries,
        backend: stable.backend,
        voice: stable.voice,
        storage: stable.storage,
        telemetry: stable.telemetry,
        isAuthenticated,
        getSessionCapabilities,
        getUserContextText,
        getUserId: stableGetUserId,
        publishedVoiceActivation: publishedVoiceActivation ?? undefined,
      };
    },
    [manifest, locale, sttLocale, stable, registries, isAuthenticated, getSessionCapabilities, getUserContextText, stableGetUserId, publishedVoiceActivation, orbProfile],
  );

  return (
    <FiodosProvider config={config}>
      <ExpoRouterRouteTracker adapter={stable.navigation} />
      {children}
      <AgentLayer
        // Gate on `orbReady` so the orb only appears once we have a theme to
        // paint — the dashboard-customized one (instant from local cache on
        // returning launches) instead of flashing the default for ~1s while the
        // network responds on a cold start.
        visible={visible && orbReady}
        bottom={layerInsets.bottom}
        right={layerInsets.right}
        orbProps={{
          theme: remoteOrb?.theme,
          modalTheme: remoteOrb?.modalTheme,
          logoDataUrl: remoteOrb?.logoDataUrl ?? null,
          logoTransform: remoteOrb?.logoTransform ?? null,
          consentParagraphs,
          // Gentle, intensity-scaled haptics on iOS/Android (expo-haptics),
          // falling back to the baseline Vibration engine when unavailable.
          hapticsFactory: createExpoOrbHaptics,
        }}
      />
    </FiodosProvider>
  );
}

/** Local-cache key for the last published config (per backend + key). */
function publishedCacheKey(baseUrl: string, apiKey: string | undefined): string {
  const id = `${baseUrl}|${apiKey ?? ''}`;
  // Cheap stable hash so the key is filesystem/storage safe.
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0;
  return `fyodos.publishedConfig.v1.${h}`;
}

/** Process a raw published payload into the orb appearance the UI consumes. */
async function processPublished(
  published: PublishedClientConfig & PublishedVoiceActivation,
): Promise<{ remoteOrb: RemoteOrbAppearance; voice: PublishedVoiceActivation }> {
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
  return {
    remoteOrb: {
      theme: { ...mapped.theme, backgroundColor: bg, keyboardChip },
      modalTheme: mapped.modalTheme,
      logoDataUrl: logoUri,
      logoTransform: mapped.logoTransform,
      screenPosition: mapped.screenPosition,
    },
    voice: {
      voiceActivationOffered: published.voiceActivationOffered,
      voiceActivationPhrase: published.voiceActivationPhrase,
      voiceActivationPhrases: published.voiceActivationPhrases,
    },
  };
}

/**
 * Fetch the dashboard-published orb appearance + voice-activation policy.
 *
 * The published config is also CACHED locally: on launch we hydrate from the
 * cache FIRST (so the user's customized orb appears immediately, with no flash
 * of the default theme) and then refetch from the network to pick up any new
 * design. `ready` flips true as soon as we have something to paint — the cached
 * design (instant on returning launches), the fresh network design (first ever
 * launch), or after a short safety timeout (offline first launch) — so the orb
 * is never shown with the wrong default while the real design is in flight.
 */
function usePublishedConfig(
  baseUrl: string,
  apiKey: string | undefined,
  storage: StorageAdapter,
): {
  remoteOrb: RemoteOrbAppearance | null;
  publishedVoiceActivation: PublishedVoiceActivation | null;
  orbProfile: 'public' | 'internal' | null;
  ready: boolean;
} {
  const [remoteOrb, setRemoteOrb] = useState<RemoteOrbAppearance | null>(null);
  const [publishedVoiceActivation, setPublishedVoiceActivation] =
    useState<PublishedVoiceActivation | null>(null);
  const [orbProfile, setOrbProfile] = useState<'public' | 'internal' | null>(null);
  const [ready, setReady] = useState(false);

  const client = useMemo(
    () => createFiodosBackendClient({ baseUrl, apiKey }),
    [baseUrl, apiKey],
  );
  const cacheKey = useMemo(() => publishedCacheKey(baseUrl, apiKey), [baseUrl, apiKey]);

  useEffect(() => {
    let alive = true;
    // Network can be slow or absent: never wait forever before showing the orb.
    const safety = setTimeout(() => {
      if (alive) setReady(true);
    }, 2500);

    const apply = async (
      published: PublishedClientConfig & PublishedVoiceActivation,
      fromNetwork: boolean,
    ) => {
      const { remoteOrb: orb, voice } = await processPublished(published);
      if (!alive) return;
      setRemoteOrb(orb);
      setPublishedVoiceActivation(voice);
      setOrbProfile(published.orbProfile === 'internal' ? 'internal' : 'public');
      setReady(true);
      if (fromNetwork) {
        try {
          await storage.setItem(cacheKey, JSON.stringify(published));
        } catch {
          /* caching is best-effort */
        }
      }
    };

    // 1) Hydrate from local cache (fast) so the customized orb shows at once.
    void (async () => {
      try {
        const raw = await storage.getItem(cacheKey);
        if (!alive || !raw) return;
        const cached = JSON.parse(raw) as PublishedClientConfig & PublishedVoiceActivation;
        await apply(cached, false);
      } catch {
        /* a missing/corrupt cache just falls through to the network */
      }
    })();

    // 2) Refetch from the network to pick up the latest published design.
    void (async () => {
      try {
        const res = await client.fetchPublishedConfig?.();
        if (!alive || !res?.published) return;
        await apply(res.published as PublishedClientConfig & PublishedVoiceActivation, true);
      } catch (e) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
          console.warn('[fyodos] published config fetch failed', e instanceof Error ? e.message : e);
        }
      }
    })();

    return () => {
      alive = false;
      clearTimeout(safety);
    };
  }, [client, storage, cacheKey]);

  return { remoteOrb, publishedVoiceActivation, orbProfile, ready };
}
