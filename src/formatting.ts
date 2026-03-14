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

// ── Unified Display Format ───────────────────────────────────────
// Format: <ship><location>·<health><activity>·Name·<role><rank>
// Spec: docs/design/05-bot.md § Unified Display Format

export type Verbosity = 'short' | 'medium' | 'long';

/** Parameters for the unified bot display format. */
export interface BotDisplayParams {
  /** Ship emoji, e.g. 🦁 */
  shipEmoji: string;
  /** Ship name, e.g. Herc */
  shipName: string;
  /** Current room name, e.g. engineering, bridge, astrometrics, quarters */
  location: string;
  /** Health grade (A/B/C/F) or boot stage (sleep/building/starting/waiting) */
  health: string;
  /** Activity emoji (🔥) when active; omit or undefined when idle */
  activity?: string;
  /** Bot name (will be capitalized) */
  name: string;
  /** Role name, e.g. engineer, navigator, architect, normie */
  role: string;
  /** Numeric rank */
  rank: number;
  /** True if this bot is chief (on duty, lowest rank in room) */
  isChief: boolean;
}

/** Location emoji by room name (per spec). */
const LOCATION_ICONS: Record<string, string> = {
  engineering:  '⚙️',
  bridge:       '🧭',
  astrometrics: '🔭',
  quarters:     '🏠',
};

/** Short label for medium verbosity location fields. */
const LOCATION_SHORT: Record<string, string> = {
  engineering:  'Eng',
  bridge:       'Brdg',
  astrometrics: 'Astro',
  quarters:     'Qtrs',
};

/** Role emoji for unified display (per spec). */
const ROLE_ICONS_DISPLAY: Record<string, string> = {
  engineer:  '⚙️',
  navigator: '🧭',
  architect: '🔭',
  normie:    '💬',
};

/** Health/boot-stage emoji for unified display. */
const HEALTH_DISPLAY_EMOJI: Record<string, string> = {
  A: '🟢', B: '🟡', C: '🟠', F: '🔴',
  sleep: '💤', building: '🔄', starting: '🚀', waiting: '🟡',
};

/** Rank medal emoji: 🥇=1, 🥈=2, 🥉=3+. */
function rankMedal(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  return '🥉';
}

function _fmtShip(p: BotDisplayParams, v: Verbosity): string {
  if (v === 'short') return p.shipEmoji;
  if (v === 'medium') return `${p.shipEmoji}${p.shipName}`;
  return `${p.shipEmoji}${p.shipName}[ship]`;
}

function _fmtLocation(p: BotDisplayParams, v: Verbosity): string {
  const icon = LOCATION_ICONS[p.location] ?? p.location;
  if (v === 'short') return icon;
  const short = LOCATION_SHORT[p.location] ?? p.location;
  if (v === 'medium') return `${icon}${short}`;
  const full = p.location.charAt(0).toUpperCase() + p.location.slice(1);
  return `${icon}${full}[loc]`;
}

function _fmtHealth(p: BotDisplayParams, v: Verbosity): string {
  const emoji = HEALTH_DISPLAY_EMOJI[p.health] ?? '❓';
  if (v === 'short') return emoji;
  if (v === 'medium') return `${emoji}${p.health}`;
  return `${emoji}${p.health}[health]`;
}

function _fmtActivity(p: BotDisplayParams, v: Verbosity): string {
  if (!p.activity) return '';
  if (v === 'short') return p.activity;
  if (v === 'medium') return `${p.activity}active`;
  return `${p.activity}active[activity]`;
}

function _fmtRole(p: BotDisplayParams, v: Verbosity): string {
  const icon = ROLE_ICONS_DISPLAY[p.role] ?? p.role;
  if (v === 'short') return icon;
  const abbrev = p.role.slice(0, 3);
  if (v === 'medium') return `${icon}${abbrev}`;
  return `${icon}${p.role}[role]`;
}

function _fmtRank(p: BotDisplayParams, v: Verbosity): string {
  if (p.isChief) {
    if (v === 'short') return '⭐';
    if (v === 'medium') return '⭐chief';
    return '⭐chief[rank]';
  }
  const medal = rankMedal(p.rank);
  if (v === 'short') return medal;
  if (v === 'medium') return `${medal}${p.rank}`;
  return `${medal}rank${p.rank}`;
}

/**
 * Format a bot in the unified display format at the given verbosity level.
 *
 * Format: `<ship><location>·<health><activity>·Name·<role><rank>`
 *
 * - **short** — emoji only (for status bars, display names, compact badges)
 * - **medium** — emoji + abbreviated label (for !fleet, metrics, thread summaries)
 * - **long** — emoji + full label + field tag (for diagnostics, !fleet --verbose)
 */
export function formatBotLine(params: BotDisplayParams, verbosity: Verbosity): string {
  const ship     = _fmtShip(params, verbosity);
  const location = _fmtLocation(params, verbosity);
  const health   = _fmtHealth(params, verbosity);
  const activity = _fmtActivity(params, verbosity);
  const name     = capitalizeName(params.name);
  const role     = _fmtRole(params, verbosity);
  const rank     = _fmtRank(params, verbosity);
  return `${ship}${location}·${health}${activity}·${name}·${role}${rank}`;
}
