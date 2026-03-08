import os from 'os';
import { ASSISTANT_NAME } from 'nanoclaw/config.js';

export let botMatrixUserIds: Set<string> = new Set();

export function setBotMatrixUserIds(ids: Set<string>): void {
  botMatrixUserIds = ids;
}

const BOT_LOCATION = os.hostname().toUpperCase();

export function botDisplayName(badge: string): string {
  return `${ASSISTANT_NAME} ${badge} (${BOT_LOCATION})`;
}
