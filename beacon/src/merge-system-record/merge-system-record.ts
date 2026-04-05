import type { BootstrapInput, SystemRecord } from '../types.js';

/**
 * Purpose: merge new system bootstrap data with an existing fleet record.
 * Requirement: system identity updates must preserve a previously known Matrix space id.
 */
export function mergeSystemRecord(existing: SystemRecord | undefined, input: BootstrapInput): SystemRecord {
  return {
    name: input.name,
    emoji: input.emoji,
    hostname: input.hostname,
    spaceId: input.spaceId ?? existing?.spaceId,
  };
}
