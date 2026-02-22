/**
 * InfiniClaw conversation log.
 * Appends brief entries to per-group log files for cross-channel context.
 */
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR } from './config.js';
import type { NewMessage } from './types.js';

export function appendConversationLog(
  groupFolder: string,
  userMessages: NewMessage[],
  agentResponses: string[],
  channelName = 'matrix',
): void {
  if (userMessages.length === 0 && agentResponses.length === 0) return;

  const logDir = path.join(GROUPS_DIR, groupFolder, 'conversations');
  const logPath = path.join(logDir, 'log.md');
  fs.mkdirSync(logDir, { recursive: true });

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const lines = ['---', `${timestamp} [${channelName}]`];

  for (const msg of userMessages) {
    const content = msg.content.length > 200
      ? msg.content.slice(0, 200) + '...'
      : msg.content;
    lines.push(`${msg.sender_name}: ${content}`);
  }

  for (const response of agentResponses) {
    const content = response.length > 200
      ? response.slice(0, 200) + '...'
      : response;
    lines.push(`${ASSISTANT_NAME}: ${content}`);
  }

  fs.appendFileSync(logPath, lines.join('\n') + '\n');

  // Trim to last 100 entries
  try {
    const full = fs.readFileSync(logPath, 'utf-8');
    const entries = full.split(/(?=^---$)/m).filter((e) => e.trim());
    if (entries.length > 100) {
      fs.writeFileSync(logPath, entries.slice(-100).join(''));
    }
  } catch {
    // Non-critical — log continues to grow until next successful trim
  }
}
