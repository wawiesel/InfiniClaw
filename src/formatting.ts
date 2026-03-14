/**
 * Shared formatting utilities for chat messages.
 */

import { findShipByHostname, ROLE_ROOMS } from './ship-config.js';

/** Capitalize first letter: "cid" → "Cid". Single source of truth for name display. */
export function capitalizeName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Format bot display name: "pip Name shipEmoji". */
export function formatBotDisplayName(bot: string, pip: string): string {
  const name = capitalizeName(bot);
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

// ── Pip / badge constants ────────────────────────────────────────

/** Display-name pip for each bot status. Used by syncBotDisplayNames. */
export const PIP_FOR_STATUS: Record<string, string> = {
  onduty: '🟢', quarters: '🟢', sleep: '💤', transit: '🚀',
};

/** Role icon lookup derived from ROLE_ROOMS — single source of truth. */
export const ROLE_ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(ROLE_ROOMS).map(([role, { icon }]) => [role, icon]),
);

// ── Shared badge / line helpers ──────────────────────────────────

/** Bot badge for fleet-style displays (!fleet, !metrics).
 *  @param status   - bot status (onduty/quarters/sleep/transit/warn)
 *  @param isCO     - commanding officer of its role?
 *  @param processRunning - is the process actually running? (null = unknown)
 *  @param grade    - health grade (A/B/C/F) if available
 *  @param activity - activity icon (🔥/⚡/🔹/·) if available
 */
export function botBadge(
  status: string,
  isCO: boolean,
  processRunning: boolean | null,
  grade?: string,
  activity?: string,
): string {
  if (status === 'transit') return '🚀';
  if (status === 'sleep') return '💤';
  if (status === 'warn') return '⚠️';
  // Running statuses with health grade
  if (grade) {
    const ge = GRADE_EMOJI[grade] ?? '❓';
    const act = activity || '·';
    return isCO ? `${ge}${grade}⭐${act}` : `${ge}${grade}${act}`;
  }
  // Running statuses without grade
  if (processRunning === false) return '🔴';
  return isCO ? '⭐' : '◉';
}

/** Whether bot is CO: lowest-rank awake bot in its role. */
export function isBotCO(
  botRole: string,
  botRank: number,
  botStatus: string,
  allBots: Array<{ role: string; rank: number; status: string }>,
): boolean {
  const awake = ['onduty', 'quarters'];
  if (!awake.includes(botStatus)) return false;
  return !allBots.some(
    b => b.role === botRole && awake.includes(b.status) && b.rank < botRank,
  );
}

/** Ship header line: "🦁⭐ **Herc** · 🏅1"
 *  @param emoji        - ship emoji
 *  @param name         - ship display name
 *  @param rank         - ship rank
 *  @param commissioned - is the ship commissioned?
 *  @param isSpeaker    - is this ship the speaker?
 */
export function shipHeaderLine(
  emoji: string,
  name: string,
  rank: number | string,
  commissioned: boolean,
  isSpeaker: boolean,
): string {
  const statusChar = !commissioned ? '💤' : isSpeaker ? '⭐' : '◉';
  return `${emoji}${statusChar} **${name}** · 🏅${rank}`;
}

/** Format a bot tree line with role and rank columns.
 *  @param isLast - last bot in the ship group?
 *  @param badge  - pip/badge string
 *  @param name   - capitalized bot name (padded by caller)
 *  @param role   - capitalized role name
 *  @param roleIcon - role emoji
 *  @param rank   - bot rank
 *  @param rolePad - NBSP padding for role column alignment
 *  @param suffix - additional data (metrics, version, etc.)
 */
export function botTreeLine(
  isLast: boolean,
  badge: string,
  nameDisplay: string,
  role: string,
  roleIcon: string,
  rank: number,
  rolePad: string,
  suffix: string,
): string {
  const prefix = isLast ? '  └' : '  ├';
  const roleDisplay = roleIcon ? `${roleIcon} ${role}` : role;
  return `${prefix} ${badge} ${nameDisplay} · ${roleDisplay}${rolePad} · 🏅${rank}${suffix}`;
}

const GRADE_EMOJI: Record<string, string> = { A: '🟢', B: '🟡', C: '🟠', F: '🔴' };
