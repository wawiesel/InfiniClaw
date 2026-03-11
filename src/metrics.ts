/**
 * Fleet metrics — first-class computation and storage.
 * Computes operator, bot, ship, and fleet metrics from Matrix history,
 * process state, and fleet config. Publishes to S3 for cross-ship aggregation.
 *
 * All metrics use 1-day and 7-day rolling windows.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from 'nanoclaw/logger.js';

import { matrixGetMessages } from './matrix-api.js';
import { uploadContent } from './s3-sync.js';
import {
  loadShipConfig,
  thisShipName,
  type BotEntry,
} from './ship-config.js';
import { errStr } from './utils.js';

// ── Types ────────────────────────────────────────────────────────────

export interface RollingMetric {
  day1: number;
  day7: number;
}

export interface OperatorMetrics {
  /** @operator messages outside BehindTheCurtain per day */
  interventions: RollingMetric;
  /** X-commands issued by operator (not Captain) per day */
  xCommandsIssued: RollingMetric;
}

/** Score reactions: 👍(+1) 👎(−1) 💯(+3) ❌(−3) */
const SCORE_REACTIONS: Record<string, number> = {
  '👍️': 1, '👍': 1,
  '👎️': -1, '👎': -1,
  '💯': 3,
  '❌️': -3, '❌': -3,
};

export interface BotMetrics {
  name: string;
  /** Net score points/day from reactions */
  score: RollingMetric;
  /** pm2 restart count */
  crashes: RollingMetric;
  /** Current status from fleet.json */
  status: string;
  /** Whether pm2 process is running */
  processRunning: boolean;
}

export interface ShipMetrics {
  name: string;
  /** Relay pm2 uptime in seconds */
  relayUptimeSeconds: number;
  /** Relay pm2 restart count */
  relayRestarts: number;
}

export interface FleetMetrics {
  /** % of assigned bots with running processes */
  availability: number;
}

export interface MetricsSnapshot {
  ship: string;
  ts: number;
  operator: OperatorMetrics;
  bots: BotMetrics[];
  shipMetrics: ShipMetrics;
  fleet: FleetMetrics;
}

// ── Persistent state (accumulated by relay sync loops) ───────────────

interface MetricsEvent {
  ts: number;
  sender: string;
  roomId: string;
  body: string;
  isXCommand: boolean;
}

interface ScoreEvent {
  ts: number;
  bot: string;
  points: number;
}

/** Accumulated operator messages (non-BTC). Fed by relay sync loops. */
const operatorEvents: MetricsEvent[] = [];

/** Accumulated score reactions. Fed by relay sync loops. */
const scoreEvents: ScoreEvent[] = [];

/** BTC room ID — set by relay on startup. */
let behindTheCurtainRoomId: string | null = null;

/** Operator user ID — set by relay on startup. */
let operatorUserId: string | null = null;

/** Captain user ID — set by relay on startup. */
let captainUserId: string | null = null;

// ── Public: relay integration ────────────────────────────────────────

/** Initialize metrics with identity info. Called once on relay startup. */
export function initMetrics(opts: {
  btcRoomId: string;
  operatorUid: string;
  captainUid: string;
}): void {
  behindTheCurtainRoomId = opts.btcRoomId;
  operatorUserId = opts.operatorUid;
  captainUserId = opts.captainUid;
}

/**
 * Record an operator message seen in a room.
 * Called from relay sync loops when @operator sends a message.
 */
export function recordOperatorMessage(sender: string, roomId: string, body: string, ts: number): void {
  if (sender !== operatorUserId) return;
  operatorEvents.push({
    ts,
    sender,
    roomId,
    body,
    isXCommand: body.trim().startsWith('!'),
  });
  // Prune events older than 8 days
  const cutoff = Date.now() - 8 * 86_400_000;
  while (operatorEvents.length > 0 && operatorEvents[0].ts < cutoff) {
    operatorEvents.shift();
  }
}

/**
 * Record a scoring reaction on a bot message.
 * Called from relay sync loops when a reaction event is detected.
 */
export function recordScoreReaction(reactorId: string, emoji: string, botName: string, ts: number): void {
  // Only Captain and operator can score
  if (reactorId !== captainUserId && reactorId !== operatorUserId) return;
  const points = SCORE_REACTIONS[emoji];
  if (points === undefined) return;
  scoreEvents.push({ ts, bot: botName, points });
  // Prune events older than 8 days
  const cutoff = Date.now() - 8 * 86_400_000;
  while (scoreEvents.length > 0 && scoreEvents[0].ts < cutoff) {
    scoreEvents.shift();
  }
}

/**
 * Back-fill operator events from Matrix room history.
 * Called once on relay startup to seed metrics from historical data.
 */
export async function backfillOperatorEvents(
  homeserver: string,
  token: string,
  roomIds: string[],
): Promise<void> {
  if (!operatorUserId) return;
  const cutoff = Date.now() - 7 * 86_400_000;

  for (const roomId of roomIds) {
    if (roomId === behindTheCurtainRoomId) continue; // BTC doesn't count
    try {
      let from: string | undefined;
      let done = false;
      while (!done) {
        const resp = await matrixGetMessages(homeserver, token, roomId, {
          limit: 100,
          from,
          filter: JSON.stringify({ types: ['m.room.message'], senders: [operatorUserId] }),
        });
        for (const ev of resp.chunk) {
          if (ev.origin_server_ts < cutoff) { done = true; break; }
          if (ev.sender === operatorUserId && ev.content?.body) {
            const body = String(ev.content.body);
            operatorEvents.push({
              ts: ev.origin_server_ts,
              sender: ev.sender,
              roomId,
              body,
              isXCommand: body.trim().startsWith('!'),
            });
          }
        }
        if (!resp.end || resp.chunk.length === 0) break;
        from = resp.end;
      }
    } catch (err) {
      logger.warn({ roomId, err: errStr(err) }, 'metrics: failed to backfill room');
    }
  }
  // Sort by timestamp
  operatorEvents.sort((a, b) => a.ts - b.ts);
}

// ── Computation ──────────────────────────────────────────────────────

function rollingRate(events: { ts: number }[], windowDays: number): number {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const count = events.filter(e => e.ts >= cutoff).length;
  return Math.round((count / windowDays) * 10) / 10; // 1 decimal
}

function rolling(events: { ts: number }[]): RollingMetric {
  return { day1: rollingRate(events, 1), day7: rollingRate(events, 7) };
}

function computeOperatorMetrics(): OperatorMetrics {
  const nonBtc = operatorEvents.filter(e => e.roomId !== behindTheCurtainRoomId);
  const xCmds = nonBtc.filter(e => e.isXCommand);
  return {
    interventions: rolling(nonBtc),
    xCommandsIssued: rolling(xCmds),
  };
}

function computeBotMetrics(): BotMetrics[] {
  const config = loadShipConfig();
  const fleet = loadFleetBots();
  const pm2Info = getPm2Info();

  return config.bots.map(botId => {
    const entry = fleet[botId];
    const pm2 = pm2Info.find(p => p.name === `infiniclaw-${botId}`);
    const botScores = scoreEvents.filter(e => e.bot === botId);

    // Compute score as points/day
    const score1d = rollingPointsRate(botScores, 1);
    const score7d = rollingPointsRate(botScores, 7);

    return {
      name: botId,
      score: { day1: score1d, day7: score7d },
      crashes: {
        day1: pm2 ? pm2.restartsSince(1) : 0,
        day7: pm2 ? pm2.restartsSince(7) : 0,
      },
      status: entry?.status ?? 'unknown',
      processRunning: pm2?.status === 'online',
    };
  });
}

function rollingPointsRate(events: ScoreEvent[], windowDays: number): number {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const total = events.filter(e => e.ts >= cutoff).reduce((sum, e) => sum + e.points, 0);
  return Math.round((total / windowDays) * 10) / 10;
}

function computeShipMetrics(): ShipMetrics {
  const pm2Info = getPm2Info();
  const relay = pm2Info.find(p => p.name === 'infiniclaw-relay');
  return {
    name: thisShipName(),
    relayUptimeSeconds: relay?.uptimeMs ? Math.round(relay.uptimeMs / 1000) : 0,
    relayRestarts: relay?.restarts ?? 0,
  };
}

function computeFleetMetrics(bots: BotMetrics[]): FleetMetrics {
  const assigned = bots.filter(b => b.status !== 'sleep' && b.status !== 'transit');
  const running = assigned.filter(b => b.processRunning);
  return {
    availability: assigned.length > 0
      ? Math.round((running.length / assigned.length) * 100)
      : 100,
  };
}

// ── Snapshot ─────────────────────────────────────────────────────────

/** Compute a full metrics snapshot for this ship. */
export function computeMetrics(): MetricsSnapshot {
  const bots = computeBotMetrics();
  return {
    ship: thisShipName(),
    ts: Date.now(),
    operator: computeOperatorMetrics(),
    bots,
    shipMetrics: computeShipMetrics(),
    fleet: computeFleetMetrics(bots),
  };
}

/** Compute and publish metrics to S3. */
export async function publishMetrics(): Promise<MetricsSnapshot> {
  const snapshot = computeMetrics();
  try {
    await uploadContent(`metrics/${thisShipName()}.json`, JSON.stringify(snapshot));
  } catch (err) {
    logger.warn({ err: errStr(err) }, 'metrics: failed to publish to S3');
  }
  return snapshot;
}

// ── Formatting ──────────────────────────────────────────────────────

function fmtRolling(m: RollingMetric, unit = '/day'): string {
  return `${m.day1}${unit} (1d) · ${m.day7}${unit} (7d)`;
}

export function formatOperatorMetrics(m: OperatorMetrics): string {
  return [
    `📋 **Operator Metrics**`,
    `  Interventions: ${fmtRolling(m.interventions)}`,
    `  X-commands issued: ${fmtRolling(m.xCommandsIssued)}`,
  ].join('\n');
}

export function formatBotMetrics(b: BotMetrics): string {
  const pip = b.processRunning ? '🟢' : '🔴';
  return [
    `${pip} **${b.name}** (${b.status})`,
    `  Score: ${fmtRolling(b.score, ' pts/day')}`,
    `  Crashes: ${fmtRolling(b.crashes)}`,
  ].join('\n');
}

export function formatShipMetrics(m: ShipMetrics): string {
  const uptime = formatDuration(m.relayUptimeSeconds);
  return [
    `🚢 **${m.name}**`,
    `  Relay uptime: ${uptime}`,
    `  Relay restarts: ${m.relayRestarts}`,
  ].join('\n');
}

export function formatFleetMetrics(m: FleetMetrics): string {
  return `🌌 **Fleet** — availability: ${m.availability}%`;
}

export function formatAllMetrics(snapshot: MetricsSnapshot): string {
  const sections = [
    formatOperatorMetrics(snapshot.operator),
    '',
    formatShipMetrics(snapshot.shipMetrics),
    '',
    ...snapshot.bots.map(formatBotMetrics),
    '',
    formatFleetMetrics(snapshot.fleet),
  ];
  return sections.join('\n');
}

export function formatScopeMetrics(snapshot: MetricsSnapshot, scope: string): string {
  if (scope === 'operator') return formatOperatorMetrics(snapshot.operator);
  if (scope === 'ship') return formatShipMetrics(snapshot.shipMetrics);
  if (scope === 'fleet') return formatFleetMetrics(snapshot.fleet);
  if (scope === 'all') return formatAllMetrics(snapshot);

  // "bot <name>" or just a bot name
  const botName = scope.startsWith('bot ') ? scope.slice(4).trim() : scope;
  const bot = snapshot.bots.find(b => b.name === botName);
  if (bot) return formatBotMetrics(bot);

  return formatAllMetrics(snapshot);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600 * 10) / 10}h`;
  return `${Math.round(seconds / 86400 * 10) / 10}d`;
}

// ── Helpers ──────────────────────────────────────────────────────────

interface Pm2Process {
  name: string;
  status: string;
  restarts: number;
  uptimeMs: number;
  startedAt: number;
  restartsSince(days: number): number;
}

function getPm2Info(): Pm2Process[] {
  try {
    const raw = execSync('npx pm2 jlist 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    const list = JSON.parse(raw) as Array<{
      name: string;
      pm2_env?: {
        status?: string;
        restart_time?: number;
        pm_uptime?: number;
        unstable_restarts?: number;
      };
    }>;
    return list.map(p => {
      const env = p.pm2_env ?? {};
      const startedAt = env.pm_uptime ?? Date.now();
      const restarts = env.restart_time ?? 0;
      return {
        name: p.name,
        status: env.status ?? 'stopped',
        restarts,
        uptimeMs: Date.now() - startedAt,
        startedAt,
        // pm2 only tracks total restarts, not per-window. Approximate:
        // if process started within the window, count all restarts as within-window.
        restartsSince(days: number): number {
          const windowMs = days * 86_400_000;
          if (Date.now() - startedAt < windowMs) return restarts;
          return 0; // process has been up longer than window — no restarts in window
        },
      };
    });
  } catch {
    return [];
  }
}

function loadFleetBots(): Record<string, BotEntry> {
  try {
    const config = loadShipConfig();
    const fleetPath = path.join(config.secretsPath, 'bots', 'fleet.json');
    const raw = JSON.parse(fs.readFileSync(fleetPath, 'utf-8'));
    return (raw.bots ?? {}) as Record<string, BotEntry>;
  } catch {
    return {};
  }
}
