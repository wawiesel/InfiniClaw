import fs from 'fs';

import { buildRelayStartCommand } from '../build-relay-start-command/build-relay-start-command.js';
import { upsertSystemRecord } from '../upsert-system-record/upsert-system-record.js';
import type { BootstrapInput, BootstrapResult } from '../types.js';
import { validateInput } from '../validate-input/validate-input.js';
import { writeBeaconState } from '../write-beacon-state/write-beacon-state.js';

/**
 * Purpose: execute the phase-1 beacon bootstrap flow for one system.
 * Requirement: beacon bootstrap must validate input, register the system,
 * write local beacon state, and prepare the first relay start command.
 */
export function bootstrapSystem(input: BootstrapInput): BootstrapResult {
  validateInput(input);
  if (input.apply) fs.mkdirSync(input.stateDir, { recursive: true });
  const { systemsPath, systemRecord } = upsertSystemRecord(input, input.apply);
  const beaconStatePath = writeBeaconState(input, input.apply);
  return {
    steps: [
      { id: 'verify-input', description: 'verify bootstrap inputs' },
      { id: 'verify-public', description: `verify ${input.publicDir} is a usable fleet public working copy` },
      { id: 'verify-secrets', description: `verify ${input.secretsDir} is a usable fleet secrets working copy` },
      { id: 'register-system', description: `register or update system ${input.systemId} in systems.json` },
      { id: 'write-state', description: 'write local beacon state' },
      { id: 'start-relay', description: 'emit the first relay start command' },
    ],
    systemRecord,
    systemsPath,
    beaconStatePath,
    relayStartCommand: buildRelayStartCommand(input),
  };
}
