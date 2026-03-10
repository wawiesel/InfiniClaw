/**
 * InfiniClaw message filtering.
 * Determines which messages should be ignored (other bot output, wrong triggers).
 */
import { IGNORE_PATTERNS, IGNORE_SENDERS, CAPTAIN_USER_ID } from './infini-config.js';
import type { NewMessage } from 'nanoclaw/types.js';

const NORMALIZED_IGNORE_SENDERS: Set<string> = new Set(
  [...IGNORE_SENDERS].map((s) => s.trim().toLowerCase()).filter(Boolean),
);

function isIgnoredSender(sender: unknown): boolean {
  if (typeof sender !== 'string') return false;
  const normalized = sender.trim().toLowerCase();
  return normalized.length > 0 && NORMALIZED_IGNORE_SENDERS.has(normalized);
}

/** Returns true if the message is addressed to another bot and should be ignored. */
export function isIgnoredTrigger(text: string): boolean {
  if (IGNORE_PATTERNS.length === 0) return false;
  const trimmed = text.trim();
  return IGNORE_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(trimmed);
  });
}

/** Returns true if the message should be ignored (other bot output). */
export function shouldIgnoreMessage(msg: NewMessage): boolean {
  if (typeof msg.content !== 'string') return isIgnoredSender(msg.sender);
  const content = msg.content.trimStart();
  if (content.startsWith('@') && msg.sender === CAPTAIN_USER_ID) return true; // operator callout — not for bots
  if (content.startsWith('📞') && msg.sender === CAPTAIN_USER_ID) return true; // operator pill — not for bots
  return isIgnoredSender(msg.sender) || isIgnoredTrigger(content);
}
