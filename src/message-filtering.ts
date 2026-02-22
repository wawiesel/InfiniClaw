/**
 * InfiniClaw message filtering.
 * Determines which messages should be ignored (other bot output, wrong triggers).
 */
import { IGNORE_PATTERNS, IGNORE_SENDERS } from 'nanoclaw/config.js';
import type { NewMessage } from 'nanoclaw/types.js';

/** Returns true if the message is addressed to another bot and should be ignored. */
export function isIgnoredTrigger(text: string): boolean {
  if (IGNORE_PATTERNS.length === 0) return false;
  const trimmed = text.trim();
  return IGNORE_PATTERNS.some((p) => p.test(trimmed));
}

/** Returns true if the message should be ignored (other bot output). */
export function shouldIgnoreMessage(msg: NewMessage): boolean {
  if (IGNORE_SENDERS.size > 0 && IGNORE_SENDERS.has(msg.sender)) {
    return true;
  }
  if (isIgnoredTrigger(msg.content.trim())) {
    return true;
  }
  return false;
}
