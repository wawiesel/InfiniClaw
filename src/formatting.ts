/**
 * Shared formatting utilities for chat messages.
 */

/** Format a status message: emoji plain, text in italic grey. */
export function statusMessage(emoji: string, text: string): string {
  return `${emoji} <font color="#888888"><em>${text}</em></font>`;
}
