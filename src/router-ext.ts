/**
 * InfiniClaw router extensions.
 * Functions upstream removed in v1.2.12.
 */
import { escapeXml } from 'nanoclaw/router.js';
import type { NewMessage } from 'nanoclaw/types.js';

/** Format thread context for prompt injection. Shows prior thread messages the bot hasn't seen yet. */
export function formatThreadContext(
  threadMessages: NewMessage[],
  newMessageIds: Set<string>,
): string {
  const contextOnly = threadMessages.filter(
    (m) => m.id && !newMessageIds.has(m.id),
  );
  if (contextOnly.length === 0) return '';
  const lines = contextOnly.map((m) => {
    const content =
      m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content;
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(content)}</message>`;
  });
  return `<thread_context>\n${lines.join('\n')}\n</thread_context>`;
}
