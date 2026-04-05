import path from 'path';

import type { BootstrapInput } from '../types.js';

/**
 * Purpose: derive the relay start command beacon will hand off after bootstrap.
 * Requirement: beacon must make the intended first relay activation explicit.
 */
export function buildRelayStartCommand(input: BootstrapInput): string[] {
  return [
    'node',
    path.join(input.relayRepo, 'dist', 'cli.js'),
    'relay',
    'start',
  ];
}
