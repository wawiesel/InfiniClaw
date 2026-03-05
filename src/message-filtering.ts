/**
 * InfiniClaw message filtering.
 * Determines which messages should be ignored (other bot output, wrong triggers).
 */
import { IGNORE_PATTERNS, IGNORE_SENDERS } from './infini-config.js';
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

// Status indicator patterns from other bots (working/resuming/idling/worked/resumed/idled)
// Matches both old format "💤 <font..." and new format "<font...>💤 <em>..."
// NOTE: `u` flag required — 💤 (U+1F4A4) is a surrogate pair in UTF-16.
const STATUS_INDICATOR_RE = /^[*\s]*(?:[⏳💤🔵🔷🔹]\s*<(?:font|span)\b|<(?:font|span)\b[^>]*>\s*[⏳💤🔵🔷🔹])/iu;

/** Returns true if the message should be ignored (other bot output). */
export function shouldIgnoreMessage(msg: NewMessage): boolean {
  if (typeof msg.content !== 'string') return isIgnoredSender(msg.sender);
  const content = msg.content.trimStart();
  return isIgnoredSender(msg.sender) || isIgnoredTrigger(content) || STATUS_INDICATOR_RE.test(content);
}
