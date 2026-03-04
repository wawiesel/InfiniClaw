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

// Status indicator patterns from other bots (working/resuming/idling/worked/resumed/idled)
// Matches both old format "💤 <font..." and new format "<font...>💤 <em>..."
// NOTE: `u` flag required — 💤 (U+1F4A4) is a surrogate pair in UTF-16.
const STATUS_INDICATOR_RE = /^[*\s]*(?:[⏳💤🔵🔷🔹]\s*<(?:font|span)\b|<(?:font|span)\b)/u;

/** Returns true if the message should be ignored (other bot output). */
export function shouldIgnoreMessage(msg: NewMessage): boolean {
  return IGNORE_SENDERS.has(msg.sender) || isIgnoredTrigger(msg.content) || STATUS_INDICATOR_RE.test(msg.content);
}
