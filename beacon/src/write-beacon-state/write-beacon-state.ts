import path from 'path';

import type { BeaconState, BootstrapInput } from '../types.js';
import { writeJsonFile } from '../write-json-file/write-json-file.js';

/**
 * Purpose: persist the local beacon working state for a bootstrapped system.
 * Requirement: beacon must leave a local record of the fleet and relay it brought online.
 */
export function writeBeaconState(input: BootstrapInput, apply: boolean): string {
  const state: BeaconState = {
    fleetName: input.fleetName,
    systemId: input.systemId,
    relayVersion: input.relayVersion,
    relayRepo: input.relayRepo,
    publicDir: input.publicDir,
    secretsDir: input.secretsDir,
    stateDir: input.stateDir,
    installedAt: new Date().toISOString(),
  };
  const file = path.join(input.stateDir, 'beacon-state.json');
  if (apply) writeJsonFile(file, state);
  return file;
}
