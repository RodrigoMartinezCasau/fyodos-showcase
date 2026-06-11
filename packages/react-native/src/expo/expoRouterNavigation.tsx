/**
 * NavigationAdapter for expo-router. Lives under the '/expo' entry point so
 * Metro only resolves expo-router in apps that actually use it.
 *
 * expo-router exposes the current pathname only as a hook, so the adapter
 * tracks it via <ExpoRouterRouteTracker/> (mounted automatically when you
 * render AgentLayer, or manually anywhere under the router).
 */
import { useEffect } from 'react';
import type { NavigationAdapter } from '@fyodos/core';
import { parseRouteString } from '../navigation/parseRoute';

interface ExpoRouterLike {
  router: {
    push(href: unknown): void;
    navigate(href: unknown): void;
    back(): void;
    canGoBack(): boolean;
  };
  usePathname(): string;
}

// Static require: resolved by Metro only when the app imports '@fyodos/react-native/expo'.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const expoRouter = require('expo-router') as ExpoRouterLike;

export interface ExpoRouterNavigationAdapter extends NavigationAdapter {
  /** Updates the tracked route (called by ExpoRouterRouteTracker). */
  setCurrentRoute(route: string | null): void;
}

export interface ExpoRouterAdapterOptions {
  /** Where back() lands when history is empty (manifest route string). */
  backFallbackRoute?: string;
}

export function createExpoRouterNavigationAdapter(
  options: ExpoRouterAdapterOptions = {},
): ExpoRouterNavigationAdapter {
  let currentRoute: string | null = null;

  return {
    navigate(route) {
      const { pathname, params } = parseRouteString(route);
      if (Object.keys(params).length > 0) {
        // Query-string routes become { pathname, params } so screens receive
        // them via useLocalSearchParams.
        expoRouter.router.navigate({ pathname, params });
      } else {
        expoRouter.router.push(pathname);
      }
    },
    back() {
      if (expoRouter.router.canGoBack()) {
        expoRouter.router.back();
      } else if (options.backFallbackRoute) {
        expoRouter.router.navigate(parseRouteString(options.backFallbackRoute).pathname);
      }
    },
    getCurrentRoute() {
      return currentRoute;
    },
    setCurrentRoute(route) {
      currentRoute = route;
    },
  };
}

/** Mount once under the router to keep adapter.getCurrentRoute() fresh. */
export function ExpoRouterRouteTracker({
  adapter,
}: {
  adapter: ExpoRouterNavigationAdapter;
}): null {
  const pathname = expoRouter.usePathname();
  useEffect(() => {
    adapter.setCurrentRoute(pathname ?? null);
  }, [adapter, pathname]);
  return null;
}
