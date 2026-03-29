/**
 * Shared formatting utilities for chat messages.
 */

import { ROLE_ROOMS } from './ship-config.js';

/** Capitalize first letter: "cid" → "Cid". Single source of truth for name display. */
export function capitalizeName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
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
 *  @param activity - activity icon (🔥/⚡/🔹/⏸) if available
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

/** Find the Chief of a duty room — lowest-rank-number onduty bot (design: 09-roles-and-rooms.md, 12-co.md). */
export function findRoomChief(
  dutyRoom: string,
  allBots: Array<{ name: string; role: string; rank: number; status: string }>,
): string | undefined {
  const roomBots = allBots.filter(
    b => b.status === 'onduty' && ROLE_ROOMS[b.role]?.room === dutyRoom,
  );
  if (roomBots.length === 0) return undefined;
  return roomBots.reduce((a, b) => (a.rank < b.rank ? a : b)).name;
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
 *  Long:  🦁 Herc 🛳️cruiser·⭐[1]·🟢[A]·🔥[500K tok/d]
 *  Short: 🦁 Herc 🛳️ ⭐ 🟢 🔥
 */
export function unifiedShipDisplay(p: UnifiedShipDisplayParams, verbosity: Verbosity): string {
  const medal = !p.commissioned ? '💤' : p.isSpeaker ? '⭐' : rankMedal(p.rank, false);
  const healthEmoji = !p.commissioned ? '💤' : (GRADE_EMOJI[p.health] ?? '');
  const actEmoji = !p.commissioned ? '' : activityEmoji(p.tokPerDay);

  if (verbosity === 'short') {
    const icons = [p.typeEmoji, medal, healthEmoji, actEmoji].filter(Boolean).join(' ');
    return `${p.emoji} ${p.name} ${icons}`;
  }

  // Long: 🦁 Herc 🛳️cruiser·⭐[1]·🟢[A]·🔥[500K tok/d]
  const typePart = `${p.typeEmoji}${p.type}`;
  const rankPart = `${medal}[${p.rank}]`;
  const healthPart = !p.commissioned
    ? '💤[decom]'
    : `${healthEmoji}[${p.health || '?'}]`;
  const actPart = p.commissioned ? `·${actEmoji}[${fmtTok(p.tokPerDay)} tok/d]` : '';

  return `${p.emoji} ${p.name} ${typePart}·${rankPart}·${healthPart}${actPart}`;
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

// ── Shared formatting helpers (single source of truth) ───────────

/** Format a duration in ms to human-readable: "5s", "3m", "1.2h", "2.5d". */
export function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hrs = ms / 3_600_000;
  if (hrs < 24) return `${hrs.toFixed(1).replace(/\.0$/, '')}h`;
  return `${(ms / 86_400_000).toFixed(1).replace(/\.0$/, '')}d`;
}

/** Format token count: 0→"0", 5000→"5K", 1200000→"1.2M". */
export function fmtTok(tok: number): string {
  if (tok >= 1_000_000) {
    const m = tok / 1_000_000;
    return m >= 10 ? `${Math.round(m)}M` : `${+m.toFixed(1)}M`;
  }
  if (tok >= 1000) return `${Math.round(tok / 1000)}K`;
  return String(Math.round(tok));
}

/** Activity emoji from token throughput. Single source — used by !fleet, !metrics, publishFleetReport. */
export function activityEmoji(tokPerDay: number): string {
  if (tokPerDay <= 0) return '⏸';
  if (tokPerDay >= 500_000) return '🔥';
  if (tokPerDay >= 50_000) return '⚡';
  if (tokPerDay >= 5_000) return '🔹';
  return '⏸';
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
  version?: string;      // semver tag e.g. "v1.3.12" — appended to name
  activeBbCount?: number; // number of active branch brain slots (0 or omitted = none)
}

/** Branch-brain count indicator. Returns "🌿×N" when N > 0, else "". */
export function bbCountIndicator(count: number): string {
  return count > 0 ? `🌿×${count}` : '';
}

/** Status-aware health emoji: sleep→💤, building→🔄, starting→🚀, online→🟢, etc. */
function statusHealthEmoji(status: string, health: string): string {
  if (status === 'sleep' || status === 'dream') return '💤';
  if (status === 'building') return '🔄';
  if (status === 'starting') return '🚀';
  if (status === 'waiting') return '🟡';
  if (status === 'online') return '🟢';
  if (status === 'ready') return '✅';
  return GRADE_EMOJI[health] ?? '';
}

/** Build a unified bot display string.
 *  Long:  🦁🏠 Tali ⚙️engineer·🥈[2]·🟢[A]·🔥[16K tok/d]·🌿[2 BB]
 *  Short: 🦁🏠 Tali ⚙️ 🥈 🟢 🔥 🌿×2
 *  Pass nameWidth to pad the name for column alignment in fleet output.
 */
export function unifiedBotDisplay(p: UnifiedBotDisplayParams, verbosity: Verbosity, nameWidth = 0): string {
  const medal = rankMedal(p.rank, p.isChief);
  const roleIcon = ROLE_ICONS[p.role] ?? '';
  const healthEmoji = statusHealthEmoji(p.status, p.health);
  const actEmoji = activityEmoji(p.tokPerDay);
  const bbEmoji = bbCountIndicator(p.activeBbCount ?? 0);
  const prefix = `${p.shipEmoji}${p.locationEmoji}`;
  const baseName = capitalizeName(p.name);
  const name = (p.version ? `${baseName} ${p.version}` : baseName).padEnd(nameWidth);

  if (verbosity === 'short') {
    const icons = [roleIcon, medal, healthEmoji, actEmoji, bbEmoji].filter(Boolean).join(' ');
    return `${prefix} ${name} ${icons}`;
  }

  // Long format: 🦁🏠 Tali ⚙️engineer·🥈[2]·🟢[A]·🔥[16K tok/d]·🌿[2 BB]
  const rolePart = `${roleIcon}${p.role}`;
  const rankPart = `${medal}[${p.rank}]`;
  const healthPart = `${healthEmoji}[${p.health || '?'}]`;
  const actPart = `·${actEmoji}[${fmtTok(p.tokPerDay)} tok/d]`;
  const bbPart = bbEmoji ? `·🌿[${p.activeBbCount} BB]` : '';

  return `${prefix} ${name} ${rolePart}·${rankPart}·${healthPart}${actPart}${bbPart}`;
}
