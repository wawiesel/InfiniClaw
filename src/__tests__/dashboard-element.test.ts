import { describe, expect, it } from 'vitest';

import {
  buildElementConfig,
  getElementUpstreamPath,
  needsElementSlashRedirect,
  normalizeElementBase,
  rewriteElementLocation,
  shouldForwardElementResponseHeader,
} from '../dashboard-element.js';

describe('dashboard element helpers', () => {
  it('normalizes the configured base path', () => {
    expect(normalizeElementBase('ogic/matrix/')).toBe('/ogic/matrix');
    expect(normalizeElementBase('/ogic/matrix///')).toBe('/ogic/matrix');
  });

  it('maps prefixed requests onto upstream element paths', () => {
    expect(needsElementSlashRedirect('/ogic/matrix')).toBe(true);
    expect(getElementUpstreamPath('/ogic/matrix/')).toBe('/');
    expect(getElementUpstreamPath('/ogic/matrix/bundles/app.js')).toBe('/bundles/app.js');
    expect(getElementUpstreamPath('/ogic/matrix/config.json')).toBe('/config.json');
  });

  it('builds a fleet-scoped config.json for the local homeserver', () => {
    const config = buildElementConfig('fleet.a-gis.org', 'https');
    expect(config['default_server_name']).toBeUndefined();
    expect(config['permalink_prefix']).toBe('https://fleet.a-gis.org/ogic/matrix');
    expect((config['default_server_config'] as { 'm.homeserver': { base_url: string } })['m.homeserver'].base_url).toBe('https://matrix.a-gis.org');
  });

  it('rewrites upstream redirects back under the mounted base path', () => {
    expect(rewriteElementLocation('/bundles/app.js')).toBe('/ogic/matrix/bundles/app.js');
    expect(rewriteElementLocation('https://app.element.io/icons/warning.svg')).toBe('/ogic/matrix/icons/warning.svg');
    expect(rewriteElementLocation('https://example.com/elsewhere')).toBe('https://example.com/elsewhere');
  });

  it('strips stale content-encoding headers from proxied element responses', () => {
    expect(shouldForwardElementResponseHeader('cache-control')).toBe(true);
    expect(shouldForwardElementResponseHeader('content-encoding')).toBe(false);
    expect(shouldForwardElementResponseHeader('Content-Length')).toBe(false);
  });
});
