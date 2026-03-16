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
  retrospective: '📝', dream: '💤', ready: '✅',
};

/** Role icon lookup derived from ROLE_ROOMS — single source of truth. */
export const ROLE_ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(ROLE_ROOMS).map(([role, { icon }]) => [role, icon]),
);

// ── Rank medals ──────────────────────────────────────────────────

/** Rank medal for bot rank display. ⭐ for chief, 🥇/🥈/🥉 for ranked bots. */
export function rankMedal(rank: number, isChief: boolean): string {
  if (isChief) return '⭐';
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  return '🥉';
}

// ── Shared badge / line helpers ──────────────────────────────────

/** Bot health/activity badge for fleet-style displays (!fleet, !metrics).
 *  @param status   - bot status (onduty/quarters/sleep/transit/warn)
 *  @param processRunning - is the process actually running? (null = unknown)
 *  @param grade    - health grade (A/B/C/F) if available
 *  @param activity - activity icon (🔥/⚡/🔹/·) if available
 */
export function botBadge(
  status: string,
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
    const act = activity || '';
    return `${ge}${grade}${act}`;
  }
  // Running statuses without grade
  if (processRunning === false) return '🔴';
  return '◉';
}

/** Whether bot is Chief: lowest-rank onduty bot in its role.
 *  Chief is a duty room concept — only onduty bots are eligible (design: 09-roles-and-rooms.md). */
export function isBotCO(
  botRole: string,
  botRank: number,
  botStatus: string,
  allBots: Array<{ role: string; rank: number; status: string }>,
): boolean {
  if (botStatus !== 'onduty') return false;
  return !allBots.some(
    b => b.role === botRole && b.status === 'onduty' && b.rank < botRank,
  );
}

/** Ship header line: "🦁⭐ **Herc** · 🏅1" (legacy — prefer unifiedShipDisplay) */
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

/** Parameters for unified ship display. */
export interface UnifiedShipDisplayParams {
  name: string;          // e.g. "Herc"
  emoji: string;         // e.g. "🦁"
  typeEmoji: string;     // e.g. "🛳️"
  type: string;          // e.g. "cruiser"
  rank: number;          // ship rank
  isSpeaker: boolean;    // speaker → ⭐
  commissioned: boolean; // decommissioned → 💤
  health: string;        // aggregate health grade (worst bot)
  tokPerDay: number;     // aggregate token throughput (sum of bots)
}

/** Build a unified ship display string.
 *  Long:  🦁 Herc 🛳️cruiser·⭐[1]rank·🟢[A]health·🔥[500K tok/d]
 *  Short: 🦁 Herc 🛳️⭐🟢🔥
 */
export function unifiedShipDisplay(p: UnifiedShipDisplayParams, verbosity: Verbosity): string {
  const medal = !p.commissioned ? '💤' : p.isSpeaker ? '⭐' : rankMedal(p.rank, false);
  const healthEmoji = !p.commissioned ? '💤' : (GRADE_EMOJI[p.health] ?? '');
  const actEmoji = !p.commissioned ? '' : activityEmoji(p.tokPerDay);

  if (verbosity === 'short') {
    return `${p.emoji} ${p.name} ${p.typeEmoji}${medal}${healthEmoji}${actEmoji}`;
  }

  // Long: 🦁 Herc 🛳️cruiser·⭐[1]rank·🟢[A]health·🔥[500K tok/d]
  const typePart = `${p.typeEmoji}${p.type}`;
  const rankPart = `${medal}[${p.rank}]rank`;
  const healthPart = !p.commissioned
    ? '💤[decom]health'
    : `${healthEmoji}[${p.health || '?'}]health`;
  const actPart = actEmoji ? `·${actEmoji}[${fmtTok(p.tokPerDay)} tok/d]` : '';

  return `${p.emoji} ${p.name} ${typePart}·${rankPart}·${healthPart}${actPart}`;
}

/** Format a bot tree line with role and rank columns.
 *  @param isLast   - last bot in the ship group?
 *  @param badge    - health/activity badge string
 *  @param name     - capitalized bot name (padded by caller)
 *  @param role     - capitalized role name
 *  @param roleIcon - role emoji
 *  @param rank     - bot rank number
 *  @param isChief  - is this bot the Chief (lowest-rank active in room)?
 *  @param rolePad  - NBSP padding for role column alignment
 *  @param suffix   - additional data (metrics, version, etc.)
 */
export function botTreeLine(
  isLast: boolean,
  badge: string,
  nameDisplay: string,
  role: string,
  roleIcon: string,
  rank: number,
  isChief: boolean,
  rolePad: string,
  suffix: string,
): string {
  const prefix = isLast ? '  └' : '  ├';
  const roleDisplay = roleIcon ? `${roleIcon} ${role}` : role;
  const medal = rankMedal(rank, isChief);
  return `${prefix} ${badge} ${nameDisplay} · ${roleDisplay}${rolePad} · ${medal}${suffix}`;
}

export const GRADE_EMOJI: Record<string, string> = { A: '🟢', B: '🟡', C: '🟠', F: '🔴' };

/** Format a rerank confirmation for a ship swap. */
export function formatRerankShipMsg(target: string, targetRank: number, swap: string, swapRank: number): string {
  return `✅ ${target} → ${rankMedal(targetRank, false)}, ${swap} → ${rankMedal(swapRank, false)}`;
}

/** Format a rerank confirmation for a bot swap. */
export function formatRerankBotMsg(targetDisplay: string, targetRank: number, swapDisplay: string, swapRank: number, role: string): string {
  return `✅ ${targetDisplay} → ${rankMedal(targetRank, false)}, ${swapDisplay} → ${rankMedal(swapRank, false)} (${role})`;
}

/** Format a rerank notification for a single bot. */
export function formatRerankNotification(displayName: string, rank: number): string {
  return `📡 ${displayName} reranked → ${rankMedal(rank, false)}`;
}

// ── Unified display format ────────────────────────────────────────

export type Verbosity = 'short' | 'long';

/** Parameters for unified bot display. */
export interface UnifiedBotDisplayParams {
  name: string;          // e.g. "cid"
  shipEmoji: string;     // e.g. "🦁"
  locationEmoji: string; // e.g. "⚙️" or "🏠" for quarters
  health: string;        // "A" | "B" | "C" | "F" | ""
  tokPerDay: number;     // token throughput per day (for activity emoji + long display)
  status: string;        // "onduty" | "quarters" | "sleep" | "transit" | etc.
  role: string;          // e.g. "engineer"
  rank: number;          // 1, 2, 3+
  isChief: boolean;      // true if CO (lowest-rank awake in role)
}

/** Status-aware health emoji: sleep→💤, building→🔄, starting→🚀, else grade emoji. */
function statusHealthEmoji(status: string, health: string): string {
  if (status === 'sleep' || status === 'dream') return '💤';
  if (status === 'building') return '🔄';
  if (status === 'starting') return '🚀';
  if (status === 'waiting') return '🟡';
  return GRADE_EMOJI[health] ?? '';
}

/** Activity emoji from token throughput. Mirrors metrics.ts activityIcon thresholds. */
function activityEmoji(tokPerDay: number): string {
  if (tokPerDay >= 500_000) return '🔥';
  if (tokPerDay >= 50_000) return '⚡';
  if (tokPerDay >= 5_000) return '🔹';
  return '';
}

/** Format tok/day for display: 0→"0", 5000→"5K", 1200000→"1.2M" */
function fmtTok(tok: number): string {
  if (tok >= 1_000_000) {
    const m = tok / 1_000_000;
    return m >= 10 ? `${Math.round(m)}M` : `${+m.toFixed(1)}M`;
  }
  if (tok >= 1000) return `${Math.round(tok / 1000)}K`;
  return String(Math.round(tok));
}

/** Build a unified bot display string.
 *  Long:  🦁🏠 Tali ⚙️engineer·🥈[2]rank·🟢[A]health·🔥[16K tok/d]
 *  Short: 🦁🏠 Tali ⚙️🥈🟢🔥
 */
export function unifiedBotDisplay(p: UnifiedBotDisplayParams, verbosity: Verbosity): string {
  const medal = rankMedal(p.rank, p.isChief);
  const roleIcon = ROLE_ICONS[p.role] ?? '';
  const healthEmoji = statusHealthEmoji(p.status, p.health);
  const actEmoji = activityEmoji(p.tokPerDay);
  const prefix = `${p.shipEmoji}${p.locationEmoji}`;
  const name = capitalizeName(p.name);

  if (verbosity === 'short') {
    return `${prefix} ${name} ${roleIcon}${medal}${healthEmoji}${actEmoji}`;
  }

  // Long format: 🦁🏠 Tali ⚙️engineer·🥈[2]rank·🟢[A]health·🔥[16K tok/d]
  const rolePart = `${roleIcon}${p.role}`;
  const rankPart = `${medal}[${p.rank}]rank`;
  const healthPart = `${healthEmoji}[${p.health || '?'}]health`;
  const actPart = actEmoji ? `·${actEmoji}[${fmtTok(p.tokPerDay)} tok/d]` : '';

  return `${prefix} ${name} ${rolePart}·${rankPart}·${healthPart}${actPart}`;
}
