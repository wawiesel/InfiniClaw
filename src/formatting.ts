/**
 * Shared formatting utilities for chat messages.
 */

/** Format a status message: emoji plain, text in italic grey.
 *  Must start with `<` so Matrix channel detects it as preformatted HTML. */
export function statusMessage(emoji: string, text: string): string {
  return `<font color="#888888">${emoji} <em>${text}</em></font>`;
}
