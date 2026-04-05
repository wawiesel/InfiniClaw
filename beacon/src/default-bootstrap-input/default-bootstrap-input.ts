import os from 'os';
import path from 'path';

import type { BootstrapInput } from '../types.js';

/**
 * Purpose: normalize partial CLI input into a complete beacon bootstrap request.
 * Requirement: bootstrap must have explicit fleet, system, path, and endpoint values.
 */
export function defaultBootstrapInput(partial: Partial<BootstrapInput>): BootstrapInput {
  const hostname = partial.hostname ?? os.hostname();
  return {
    fleetName: partial.fleetName ?? 'OGIC',
    systemId: partial.systemId ?? hostname.toLowerCase(),
    name: partial.name ?? hostname,
    emoji: partial.emoji ?? '🌊',
    hostname,
    publicDir: partial.publicDir ?? path.join(os.homedir(), '.config', 'infiniclaw', 'public'),
    secretsDir: partial.secretsDir ?? path.join(os.homedir(), '.config', 'infiniclaw', 'secrets'),
    stateDir: partial.stateDir ?? path.join(os.homedir(), '.config', 'infiniclaw', 'beacon'),
    relayVersion: partial.relayVersion ?? 'v2.0.0',
    relayRepo: partial.relayRepo ?? path.join(os.homedir(), 'src', 'infiniclaw-relay'),
    matrixBaseUrl: partial.matrixBaseUrl ?? 'https://matrix.a-gis.org',
    giteaBaseUrl: partial.giteaBaseUrl ?? 'https://gitea.a-gis.org',
    s3BaseUrl: partial.s3BaseUrl ?? 'https://s3.a-gis.org',
    spaceId: partial.spaceId,
    apply: partial.apply ?? false,
  };
}
