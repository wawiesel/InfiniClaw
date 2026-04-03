export const DEFAULT_ELEMENT_BASE = '/ogic/matrix';
export const DEFAULT_ELEMENT_UPSTREAM = 'https://app.element.io';
const ELEMENT_PROXY_STRIPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
]);

export function normalizeElementBase(base: string): string {
  const withSlash = base.startsWith('/') ? base : `/${base}`;
  if (withSlash === '/') return withSlash;
  return withSlash.replace(/\/+$/, '');
}

export function getElementBase(): string {
  return normalizeElementBase(process.env['ELEMENT_WEB_BASE'] || DEFAULT_ELEMENT_BASE);
}

export function getElementUpstream(): string {
  return (process.env['ELEMENT_WEB_UPSTREAM'] || DEFAULT_ELEMENT_UPSTREAM).replace(/\/+$/, '');
}

export function isElementRoute(pathname: string, base = getElementBase()): boolean {
  return pathname === base || pathname === `${base}/` || pathname.startsWith(`${base}/`);
}

export function needsElementSlashRedirect(pathname: string, base = getElementBase()): boolean {
  return pathname === base;
}

export function getElementUpstreamPath(pathname: string, base = getElementBase()): string {
  if (!isElementRoute(pathname, base)) {
    throw new Error(`not an element route: ${pathname}`);
  }
  const suffix = pathname.slice(base.length);
  return suffix || '/';
}

export function buildElementConfig(host?: string, proto = 'https', base = getElementBase()): Record<string, unknown> {
  const homeserverBaseUrl = process.env['ELEMENT_WEB_HOMESERVER'] || 'https://matrix.a-gis.org';
  const config: Record<string, unknown> = {
    default_server_config: {
      'm.homeserver': {
        base_url: homeserverBaseUrl,
      },
    },
    brand: process.env['ELEMENT_WEB_BRAND'] || 'Element',
    show_labs_settings: true,
  };
  const permalinkPrefix = process.env['ELEMENT_WEB_PERMALINK_PREFIX'] || (host ? `${proto}://${host}${base}` : '');
  if (permalinkPrefix) config['permalink_prefix'] = permalinkPrefix;
  return config;
}

export function rewriteElementLocation(location: string, base = getElementBase(), upstream = getElementUpstream()): string {
  if (!location) return location;
  if (location.startsWith('/')) return `${base}${location}`;
  try {
    const parsed = new URL(location);
    if (parsed.origin === upstream) {
      return `${base}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    return location;
  }
  return location;
}

export function shouldForwardElementResponseHeader(key: string): boolean {
  return !ELEMENT_PROXY_STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase());
}
