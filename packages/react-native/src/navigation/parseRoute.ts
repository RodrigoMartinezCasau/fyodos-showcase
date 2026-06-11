/**
 * Manifest route strings are opaque '/path?key=value' strings. Adapters that
 * need structured params (expo-router objects, react-navigation params) parse
 * them with this helper.
 */
export function parseRouteString(route: string): {
  pathname: string;
  params: Record<string, string>;
} {
  const [pathname = '', query = ''] = route.split('?');
  const params: Record<string, string> = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return { pathname, params };
}

/** Strips query string and trailing slash: '/a/b/?x=1' → '/a/b'. */
export function normalizePathname(pathname: string | null | undefined): string {
  if (!pathname) return '';
  return (pathname.split('?')[0] ?? '').replace(/\/$/, '') || '/';
}
