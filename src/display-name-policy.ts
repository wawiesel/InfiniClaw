export type WakeDisplayStage = 'building' | 'starting' | 'waiting' | 'online';

/**
 * Single-writer startup policy:
 * - wake progress is reported in the room thread
 * - relay writes one final lifecycle display name when startup completes
 * - bot startup avoids its own profile writes to prevent races with relay
 */
export function relayShouldWriteWakeDisplayName(stage: WakeDisplayStage): boolean {
  return stage === 'online';
}

export function botShouldWriteStartupDisplayName(): boolean {
  return false;
}
