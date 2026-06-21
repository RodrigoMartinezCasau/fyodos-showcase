/**
 * NavigationAdapter for react-navigation.
 *
 * Typed structurally against the navigation container ref so this module has
 * NO dependency on @react-navigation/native — the app passes its own ref.
 *
 * Route mapping is EXPLICIT: the developer provides mapRoute() translating
 * manifest route strings into screen names + params. No magic conventions —
 * less fragile, and the mapping is auditable next to the manifest.
 */
import type { NavigationAdapter } from '@fiodos/core';
import { parseRouteString } from './parseRoute';

/** Structural subset of react-navigation's NavigationContainerRef. */
export interface ReactNavigationContainerRefLike {
  isReady(): boolean;
  navigate(name: string, params?: object): void;
  canGoBack(): boolean;
  goBack(): void;
  getCurrentRoute(): { name: string } | undefined;
}

export interface ReactNavigationAdapterOptions {
  navigationRef: ReactNavigationContainerRefLike;
  /**
   * Translates a manifest route into a react-navigation target.
   * Receives the parsed pathname and query params.
   */
  mapRoute: (pathname: string, params: Record<string, string>) => {
    name: string;
    params?: object;
  };
  /** Where back() lands when history is empty (manifest route string). */
  backFallbackRoute?: string;
}

export function createReactNavigationAdapter(
  options: ReactNavigationAdapterOptions,
): NavigationAdapter {
  const { navigationRef, mapRoute } = options;

  function navigateToRoute(route: string): void {
    const { pathname, params } = parseRouteString(route);
    const target = mapRoute(pathname, params);
    navigationRef.navigate(target.name, target.params);
  }

  return {
    navigate(route) {
      if (!navigationRef.isReady()) {
        throw new Error('react-navigation container is not ready');
      }
      navigateToRoute(route);
    },
    back() {
      if (navigationRef.canGoBack()) {
        navigationRef.goBack();
      } else if (options.backFallbackRoute) {
        navigateToRoute(options.backFallbackRoute);
      }
    },
    getCurrentRoute() {
      return navigationRef.getCurrentRoute()?.name ?? null;
    },
  };
}
