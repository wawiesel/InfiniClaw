/**
 * Shared formatting utilities for chat messages.
 */

import { findShipByHostname } from './ship-config.js';

/** Format bot display name: "pip Name shipEmoji". */
export function formatBotDisplayName(bot: string, pip: string): string {
  const name = bot.charAt(0).toUpperCase() + bot.slice(1);
  const shipEmoji = findShipByHostname()?.[1]?.emoji;
  return shipEmoji ? `${pip} ${name} ${shipEmoji}` : `${pip} ${name}`;
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format a status message: emoji plain, text in italic grey.
 *  Must start with `<` so Matrix channel detects it as preformatted HTML. */
export function statusMessage(emoji: string, text: string): string {
  return `<font color="#888888">${escapeHtml(emoji)} <em>${escapeHtml(text)}</em></font>`;
}
