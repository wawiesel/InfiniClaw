import fs from 'fs';

import type { BootstrapInput } from '../types.js';

/**
 * Purpose: reject incomplete or unusable beacon bootstrap input early.
 * Requirement: bootstrap must fail fast when required values or working copies are missing.
 */
export function validateInput(input: BootstrapInput): void {
  const required: Array<keyof BootstrapInput> = [
    'fleetName',
    'systemId',
    'name',
    'emoji',
    'hostname',
    'publicDir',
    'secretsDir',
    'stateDir',
    'relayVersion',
    'relayRepo',
    'matrixBaseUrl',
    'giteaBaseUrl',
    's3BaseUrl',
  ];
  for (const field of required) {
    const value = input[field];
    if (typeof value === 'string' && !value.trim()) {
      throw new Error(`${field} is required`);
    }
  }
  for (const [field, dir] of [['publicDir', input.publicDir], ['secretsDir', input.secretsDir]] as const) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`${field} must point to an existing directory: ${dir}`);
    }
  }
}
