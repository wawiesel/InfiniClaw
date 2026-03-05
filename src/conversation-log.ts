/**
 * InfiniClaw conversation log.
 * Appends brief entries to per-group log files for cross-channel context.
 */
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR } from 'nanoclaw/config.js';
import { assertValidGroupFolder } from 'nanoclaw/group-folder.js';
import { logger } from 'nanoclaw/logger.js';
import type { NewMessage } from 'nanoclaw/types.js';

const SAFE_CHANNEL_NAME = /^[A-Za-z0-9._-]{1,32}$/;

function sanitizeLogField(value: string, maxLen = 200): string {
  const flattened = value
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B[@-_]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
  if (flattened.length <= maxLen) return flattened;
  return `${flattened.slice(0, maxLen)}...`;
}

export function appendConversationLog(
  groupFolder: string,
  userMessages: NewMessage[],
  agentResponses: string[],
  channelName = 'matrix',
): void {
  if (userMessages.length === 0 && agentResponses.length === 0) return;
  try {
    assertValidGroupFolder(groupFolder);
  } catch {
    logger.warn({ groupFolder }, 'Skipping conversation log write for invalid group folder');
    return;
  }

  const logDir = path.join(GROUPS_DIR, groupFolder, 'conversations');
  const logPath = path.join(logDir, 'log.md');
  fs.mkdirSync(logDir, { recursive: true });

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const safeChannelName = SAFE_CHANNEL_NAME.test(channelName) ? channelName : 'unknown';
  const lines = ['---', `${timestamp} [${safeChannelName}]`];

  for (const msg of userMessages) {
    const sender = sanitizeLogField(msg.sender_name || 'unknown-user', 80);
    const content = sanitizeLogField(msg.content || '');
    lines.push(`${sender}: ${content}`);
  }

  for (const response of agentResponses) {
    const content = sanitizeLogField(response || '');
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
