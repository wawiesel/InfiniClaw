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
import { DATA_DIR } from 'nanoclaw/config.js';

import { botBadge, capitalizeName, GRADE_EMOJI, formatDuration as formatDurationMs } from './formatting.js';
import { matrixGetMessages } from './matrix-api.js';
import { uploadContent } from './s3-sync.js';
import { resolveRoot } from './service.js';
import { SEMVER_TAG } from './version.js';
import {
  loadShipConfig,
  loadFleet,
  thisShipName,
  safeLoadShips,
  ROLE_ROOMS,
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
  /** Mean time between interventions in hours (7d window). null if < 2 events. */
  mtbi?: number | null;
}

/** Score reactions: 👍(+1) 👎(−1) 💯(+3) ❌(−3) */
export const SCORE_REACTIONS: Record<string, number> = {
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
  /** Branch brain success rate (0–100%) */
  branchBrainSuccess: RollingMetric;
  /** (input+output+cache) tokens per day from session JSONL. -1 if no data. */
  tokenThroughput: RollingMetric;
  /** Messages sent per day (replies posted). -1 if not yet tracked. */
  messagesPerDay: RollingMetric;
  /** Task completion rate (resolved / created) as 0–100%. -1 if no data. */
  taskCompletionRate: RollingMetric;
  /** Current status from fleet.json */
  status: string;
  /** Whether pm2 process is running */
  processRunning: boolean;
  /** Response latency p50 in seconds (1d rolling) */
  responseLatencyP50?: number;
  /** Response latency p95 in seconds (1d rolling) */
  responseLatencyP95?: number;
}

export interface ShipMetrics {
  name: string;
  /** Relay uptime % from recorded start/stop timestamps (rolling 1d/7d). */
  relayUptimePct: RollingMetric;
  /** Relay pm2 restart count (rolling 1d/7d) */
  relayRestarts: RollingMetric;
  /** Infra sync/build failures (1d and 7d rolling) */
  infraFailures: RollingMetric;
  /** Code version string (populated by relay, not metrics) */
  codeVersion?: string;
  /** Seconds from git tag push to this bot running the version. null if untagged. */
  versionAdoptionLatencySeconds?: number | null;
}

export interface FleetMetrics {
  /** % of assigned bots with running processes */
  availability: number;
  /** Composite: 100 − (interventions × 10) − (crashes × 5). 1d and 7d rolling. */
  autonomyScore: RollingMetric;
}

// ── Health grade & activity ───────────────────────────────────────────

export type HealthGrade = 'A' | 'B' | 'C' | 'F';

export function gradeEmoji(grade: HealthGrade): string {
  return GRADE_EMOJI[grade];
}

/** Compute health grade for a single bot based on metrics + optional health data. */
export function computeBotHealthGrade(bot: BotMetrics, opts?: { oomKills1d?: number; memPct?: number }): HealthGrade {
  // F: should be running but isn't
  if ((bot.status === 'onduty' || bot.status === 'quarters') && !bot.processRunning) return 'F';
  // Not gradeable if sleeping/transit
  if (bot.status === 'sleep' || bot.status === 'transit') return 'A'; // healthy by definition

  const crashes1d = bot.crashes.day1;
  const oomKills = opts?.oomKills1d ?? 0;
  const memPct = opts?.memPct ?? 0;
  const p95 = bot.responseLatencyP95 ?? -1;

  // C: significant issues
  if (crashes1d > 2 || oomKills > 0 || memPct > 85 || (p95 > 120 && p95 > 0)) return 'C';
  // B: minor issues
  if (crashes1d > 0 || (memPct > 70) || (p95 > 60 && p95 > 0)) return 'B';
  // A: healthy
  return 'A';
}

/** Fleet-level aggregate grade: worst grade among all non-sleeping bots. */
export function computeFleetHealthGrade(grades: HealthGrade[]): HealthGrade {
  const order: HealthGrade[] = ['F', 'C', 'B', 'A'];
  for (const g of order) {
    if (grades.includes(g)) return g;
  }
  return 'A';
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

interface BranchBrainEvent {
  ts: number;
  bot: string;
  success: boolean; // true if posted output, false if errored/no output
}

/** Accumulated operator messages (non-BTC). Fed by relay sync loops. */
const operatorEvents: MetricsEvent[] = [];

/** Accumulated score reactions. Fed by relay sync loops. */
const scoreEvents: ScoreEvent[] = [];

/** Accumulated branch brain completions. Fed by relay spawnBranchBrain. */
const branchBrainEvents: BranchBrainEvent[] = [];

/** Accumulated infra failures (secrets sync, code sync, code build). Fed by reportFailure. */
const infraFailureEvents: { ts: number; system: string }[] = [];

/** Accumulated response latency samples. Fed by relay when a bot replies. */
const responseLatencyEvents: { ts: number; bot: string; latencyMs: number }[] = [];

/** Accumulated bot message sends. Fed by relay when a bot sends a message. */
const messageEvents: { ts: number; bot: string }[] = [];

/** Accumulated task lifecycle events. Fed by relay from Claude Code session todos. */
const taskEvents: { ts: number; bot: string; kind: 'created' | 'resolved' }[] = [];

/** Previous todos snapshot per bot, used by syncTodosMetrics for change detection. */
const todosSnapshot: Map<string, Map<string, string>> = new Map();

/** Version deployment events — when a ship started running a new version. */
const versionDeployEvents: { ts: number; ship: string; version: string }[] = [];

/**
 * Relay uptime intervals: each entry is a period the relay was running.
 * Loaded from disk on startup; updated by recordRelayStart/Stop.
 * `end: null` means the relay is currently running (open interval).
 */
const relayUptimeIntervals: { start: number; end: number | null }[] = [];

/** Pending message deliveries — tracks when a message was delivered to a bot's room. */
const pendingDeliveries: Map<string, number> = new Map();

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

// ── Relay uptime timestamp tracking ──────────────────────────────────

const UPTIME_FILE_NAME = 'relay-uptime.jsonl';

function relayUptimeFile(): string {
  return path.join(resolveRoot(), '_runtime', 'data', UPTIME_FILE_NAME);
}

const UPTIME_RETENTION_MS = 8 * 86_400_000;

/**
 * Load relay uptime intervals from disk.
 * Called once on relay startup, before recordRelayStart().
 * Closes any unclosed interval (relay crashed without a clean stop) by capping
 * it at the file's mtime — a reasonable proxy for the last time the relay ran.
 */
export function loadRelayUptimeHistory(): void {
  const file = relayUptimeFile();
  if (!fs.existsSync(file)) return;

  const cutoff = Date.now() - UPTIME_RETENTION_MS;
  let fileMtime: number;
  try { fileMtime = fs.statSync(file).mtimeMs; } catch { fileMtime = Date.now(); }

  try {
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { start: number; end: number | null };
        if (typeof entry.start !== 'number') continue;
        if (entry.start < cutoff) continue; // too old, skip
        // Close any unclosed interval using the file's mtime as a best-effort stop time
        const end = entry.end ?? fileMtime;
        relayUptimeIntervals.push({ start: entry.start, end });
      } catch { /* skip malformed lines */ }
    }
  } catch (err) {
    logger.warn({ err: errStr(err) }, 'metrics: failed to load relay uptime history');
  }
}

/**
 * Record that the relay has started.
 * Opens a new uptime interval and appends it to the persistent log.
 * Called once after loadRelayUptimeHistory() on relay startup.
 */
export function recordRelayStart(ts?: number): void {
  const start = ts ?? Date.now();
  relayUptimeIntervals.push({ start, end: null });
  try {
    const file = relayUptimeFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ start, end: null }) + '\n', 'utf-8');
  } catch (err) {
    logger.warn({ err: errStr(err) }, 'metrics: failed to write relay start event');
  }
}

/**
 * Record that the relay is stopping.
 * Closes the current open interval and rewrites the log with the closed entry.
 * Called in the relay shutdown handler before process.exit().
 */
export function recordRelayStop(ts?: number): void {
  const end = ts ?? Date.now();
  let open = -1;
  for (let i = relayUptimeIntervals.length - 1; i >= 0; i--) {
    if (relayUptimeIntervals[i].end === null) { open = i; break; }
  }
  if (open >= 0) relayUptimeIntervals[open] = { ...relayUptimeIntervals[open], end };
  persistRelayUptimeIntervals();
}

function persistRelayUptimeIntervals(): void {
  try {
    const file = relayUptimeFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cutoff = Date.now() - UPTIME_RETENTION_MS;
    const lines = relayUptimeIntervals
      .filter(i => i.start >= cutoff)
      .map(i => JSON.stringify(i))
      .join('\n');
    fs.writeFileSync(file, lines ? lines + '\n' : '', 'utf-8');
  } catch (err) {
    logger.warn({ err: errStr(err) }, 'metrics: failed to persist relay uptime intervals');
  }
}

/**
 * Compute relay uptime % over a rolling window.
 * Uses recorded start/stop intervals. Returns 0 if no history.
 */
export function computeRelayUptimePct(windowDays: number): number {
  const now = Date.now();
  const windowMs = windowDays * 86_400_000;
  const windowStart = now - windowMs;
  let uptimeMs = 0;
  for (const interval of relayUptimeIntervals) {
    const start = Math.max(interval.start, windowStart);
    const end = Math.min(interval.end ?? now, now);
    if (end > start) uptimeMs += end - start;
  }
  return Math.min(Math.round((uptimeMs / windowMs) * 100), 100);
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
 * Record a branch brain completion (success or failure).
 * Called from relay when a branch brain process exits.
 */
export function recordBranchBrainResult(bot: string, success: boolean, ts?: number): void {
  branchBrainEvents.push({ ts: ts ?? Date.now(), bot, success });
  const cutoff = Date.now() - 8 * 86_400_000;
  while (branchBrainEvents.length > 0 && branchBrainEvents[0].ts < cutoff) {
    branchBrainEvents.shift();
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

/**
 * Record that a message was delivered to a bot's room. Starts the latency clock.
 * Called by relay when a non-bot message arrives in a bot's room.
 */
export function recordMessageDelivery(bot: string, ts: number): void {
  pendingDeliveries.set(bot, ts);
}

/**
 * Record that a bot replied. Stops the latency clock and records the sample.
 * Called by relay when a bot message is seen in its room.
 */
export function recordBotReply(bot: string, ts: number): void {
  const deliveryTs = pendingDeliveries.get(bot);
  if (!deliveryTs) return;
  pendingDeliveries.delete(bot);
  const latencyMs = ts - deliveryTs;
  if (latencyMs < 0 || latencyMs > 600_000) return; // ignore nonsense (>10min)
  responseLatencyEvents.push({ ts, bot, latencyMs });
  const cutoff = Date.now() - 8 * 86_400_000;
  while (responseLatencyEvents.length > 0 && responseLatencyEvents[0].ts < cutoff) {
    responseLatencyEvents.shift();
  }
}

/** Record an infra failure event (secrets sync, code sync, code build). */
export function recordInfraFailure(system: string): void {
  infraFailureEvents.push({ ts: Date.now(), system });
  const cutoff = Date.now() - 8 * 86_400_000;
  while (infraFailureEvents.length > 0 && infraFailureEvents[0].ts < cutoff) infraFailureEvents.shift();
}

/**
 * Record a message sent by a bot.
 * Called from relay when a bot posts a message to a Matrix room.
 */
export function recordBotMessage(bot: string, ts?: number): void {
  messageEvents.push({ ts: ts ?? Date.now(), bot });
  const cutoff = Date.now() - 8 * 86_400_000;
  while (messageEvents.length > 0 && messageEvents[0].ts < cutoff) messageEvents.shift();
}

/** Record a task (todo) created by a bot. Called by relay from Claude Code session data. */
export function recordTaskCreated(bot: string, ts?: number): void {
  taskEvents.push({ ts: ts ?? Date.now(), bot, kind: 'created' });
  const cutoff = Date.now() - 8 * 86_400_000;
  while (taskEvents.length > 0 && taskEvents[0].ts < cutoff) taskEvents.shift();
}

/** Record a task (todo) resolved by a bot. Called by relay from Claude Code session data. */
export function recordTaskResolved(bot: string, ts?: number): void {
  taskEvents.push({ ts: ts ?? Date.now(), bot, kind: 'resolved' });
  const cutoff = Date.now() - 8 * 86_400_000;
  while (taskEvents.length > 0 && taskEvents[0].ts < cutoff) taskEvents.shift();
}

/**
 * Sync todo metrics for a bot by diffing the current todos file against the previous snapshot.
 * Detects new todos (→ recordTaskCreated) and completions (→ recordTaskResolved).
 * On first call per bot, establishes baseline without recording events.
 * Call periodically (e.g., from metricsLoop) for each active bot.
 */
export function syncTodosMetrics(bot: string): void {
  const todosDir = path.join(resolveRoot(), '_runtime', 'instances', bot, 'data', 'sessions', 'main', '.claude', 'todos');
  if (!fs.existsSync(todosDir)) return;

  let current: Map<string, string>;
  try {
    const files = fs.readdirSync(todosDir)
      .map(f => ({ f, mtime: fs.statSync(path.join(todosDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return;
    const raw = fs.readFileSync(path.join(todosDir, files[0].f), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    current = new Map<string, string>();
    for (const t of parsed as Array<{ id?: string; content?: string; status: string }>) {
      const key = t.id ?? t.content;
      if (key && t.status) current.set(key, t.status);
    }
  } catch { return; }

  const prev = todosSnapshot.get(bot);
  if (prev !== undefined) {
    const now = Date.now();
    for (const key of current.keys()) {
      if (!prev.has(key)) recordTaskCreated(bot, now);
    }
    for (const [key, status] of current) {
      const prevStatus = prev.get(key);
      if (prevStatus !== undefined && prevStatus !== 'completed' && status === 'completed') {
        recordTaskResolved(bot, now);
      }
    }
  }
  todosSnapshot.set(bot, current);
}

/**
 * Record when a ship starts running a new version.
 * Called by relay on startup after determining the running version.
 */
export function recordVersionDeployed(ship: string, version: string, ts?: number): void {
  versionDeployEvents.push({ ts: ts ?? Date.now(), ship, version });
  // Keep last 100 deploy events (no pruning by age — version history is valuable)
  if (versionDeployEvents.length > 100) versionDeployEvents.shift();
}

/**
 * Get version adoption latency in milliseconds for a given ship and version.
 * Returns null if this ship has not yet deployed the version, or if the reference
 * deploy time is unknown.
 * The "adoption latency" = time from first fleet deployment of a version to this ship's deployment.
 */
export function getVersionAdoptionLatency(ship: string, version: string): number | null {
  const deploys = versionDeployEvents.filter(e => e.version === version);
  if (deploys.length === 0) return null;
  const shipDeploy = deploys.find(e => e.ship === ship);
  if (!shipDeploy) return null;
  const firstDeploy = deploys.reduce((min, e) => e.ts < min.ts ? e : min, deploys[0]);
  if (firstDeploy.ship === ship) return 0; // this ship was first
  return shipDeploy.ts - firstDeploy.ts;
}

/** Get all version deploy events (for testing/introspection). */
export function getVersionDeployEvents(): ReadonlyArray<{ ts: number; ship: string; version: string }> {
  return versionDeployEvents;
}

/** Reset all metrics state. For testing only. */
export function resetMetrics(): void {
  operatorEvents.length = 0;
  scoreEvents.length = 0;
  branchBrainEvents.length = 0;
  infraFailureEvents.length = 0;
  responseLatencyEvents.length = 0;
  messageEvents.length = 0;
  taskEvents.length = 0;
  todosSnapshot.clear();
  versionDeployEvents.length = 0;
  relayUptimeIntervals.length = 0;
  pendingDeliveries.clear();
  behindTheCurtainRoomId = null;
  operatorUserId = null;
  captainUserId = null;
}

// ── Computation ──────────────────────────────────────────────────────

/** Exported for testing. */
export function rollingRate(events: { ts: number }[], windowDays: number): number {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const count = events.filter(e => e.ts >= cutoff).length;
  return Math.round((count / windowDays) * 10) / 10; // 1 decimal
}

function rolling(events: { ts: number }[]): RollingMetric {
  return { day1: rollingRate(events, 1), day7: rollingRate(events, 7) };
}

/** Mean time between interventions in hours over the 7d window. null if < 2 events. */
function computeMtbi(): number | null {
  const cutoff = Date.now() - 7 * 86_400_000;
  const events = operatorEvents
    .filter(e => e.roomId !== behindTheCurtainRoomId && !e.isXCommand && e.ts >= cutoff)
    .sort((a, b) => a.ts - b.ts);
  if (events.length < 2) return null;
  let totalMs = 0;
  for (let i = 1; i < events.length; i++) totalMs += events[i].ts - events[i - 1].ts;
  return Math.round((totalMs / (events.length - 1) / 3_600_000) * 10) / 10;
}

function computeOperatorMetrics(): OperatorMetrics {
  const nonBtc = operatorEvents.filter(e => e.roomId !== behindTheCurtainRoomId);
  const xCmds = nonBtc.filter(e => e.isXCommand);
  // Interventions = non-BTC messages that are NOT x-commands.
  // X-commands are legitimate management actions (queries, lifecycle), not emergency interventions.
  const interventions = nonBtc.filter(e => !e.isXCommand);
  return {
    interventions: rolling(interventions),
    xCommandsIssued: rolling(xCmds),
    mtbi: computeMtbi(),
  };
}

/** Task completion rate (0–100) for a bot in the given window. -1 if no data. */
function taskCompletionRateFor(bot: string, windowDays: number): number {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const inWindow = taskEvents.filter(e => e.bot === bot && e.ts >= cutoff);
  const created = inWindow.filter(e => e.kind === 'created').length;
  if (created === 0) return -1;
  const resolved = inWindow.filter(e => e.kind === 'resolved').length;
  return Math.round((Math.min(resolved, created) / created) * 100);
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

    const latency = botLatencyPercentiles(botId, 1);
    const botMessages = messageEvents.filter(e => e.bot === botId);
    return {
      name: botId,
      score: { day1: score1d, day7: score7d },
      crashes: {
        day1: pm2 ? pm2.restartsSince(1) : 0,
        day7: pm2 ? pm2.restartsSince(7) : 0,
      },
      branchBrainSuccess: {
        day1: branchBrainSuccessRate(botId, 1),
        day7: branchBrainSuccessRate(botId, 7),
      },
      tokenThroughput: {
        day1: readTokenThroughput(botId, 1),
        day7: readTokenThroughput(botId, 7),
      },
      // Per-model breakdown populated async from token log (see readTokenBreakdownAsync)
      tokenBreakdown: undefined as Record<string, { input: number; output: number; cache: number; total: number }> | undefined,
      messagesPerDay: rolling(botMessages),
      taskCompletionRate: {
        day1: taskCompletionRateFor(botId, 1),
        day7: taskCompletionRateFor(botId, 7),
      },
      status: entry?.status ?? 'unknown',
      processRunning: pm2?.status === 'online',
      responseLatencyP50: latency.p50 >= 0 ? latency.p50 : undefined,
      responseLatencyP95: latency.p95 >= 0 ? latency.p95 : undefined,
    };
  });
}

// ── Token throughput cache (60s TTL) — avoids re-scanning JSONL on every !fleet ──
const TOKEN_THROUGHPUT_TTL_MS = 60_000;
const tokenThroughputCache = new Map<string, { value: number; updatedAt: number }>();

/** Read token throughput (total tokens/day) for a bot from session JSONL files. -1 if no data. */
function readTokenThroughput(bot: string, windowDays: number): number {
  const cacheKey = `${bot}:${windowDays}`;
  const cached = tokenThroughputCache.get(cacheKey);
  if (cached && Date.now() - cached.updatedAt < TOKEN_THROUGHPUT_TTL_MS) {
    return cached.value;
  }

  const cutoff = Date.now() - windowDays * 86_400_000;
  const instancesDir = path.join(resolveRoot(), '_runtime', 'instances');
  const projectsBase = path.join(instancesDir, bot, 'data', 'sessions', 'main', '.claude', 'projects');
  if (!fs.existsSync(projectsBase)) {
    tokenThroughputCache.set(cacheKey, { value: -1, updatedAt: Date.now() });
    return -1;
  }

  let totalTokens = 0;
  let hasData = false;

  try {
    for (const projectDir of fs.readdirSync(projectsBase)) {
      const projectPath = path.join(projectsBase, projectDir);
      try { if (!fs.statSync(projectPath).isDirectory()) continue; } catch { continue; }

      for (const file of fs.readdirSync(projectPath)) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = path.join(projectPath, file);
        try { if (fs.statSync(filePath).mtimeMs < cutoff) continue; } catch { continue; }

        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const d = JSON.parse(line) as {
                timestamp?: string;
                message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
              };
              if (!d.timestamp || !d.message?.usage) continue;
              const ts = new Date(d.timestamp).getTime();
              if (ts < cutoff) continue;
              const u = d.message.usage;
              totalTokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) +
                (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
              hasData = true;
            } catch { /* skip bad lines */ }
          }
        } catch { /* skip bad files */ }
      }
    }
  } catch {
    tokenThroughputCache.set(cacheKey, { value: -1, updatedAt: Date.now() });
    return -1;
  }

  const result = hasData ? Math.round(totalTokens / windowDays) : -1;
  tokenThroughputCache.set(cacheKey, { value: result, updatedAt: Date.now() });
  return result;
}

/** Branch brain success rate (0–100%) for a bot in the given window. -1 if no data. */
function branchBrainSuccessRate(bot: string, windowDays: number): number {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const inWindow = branchBrainEvents.filter(e => e.bot === bot && e.ts >= cutoff);
  if (inWindow.length === 0) return -1; // no data
  const successes = inWindow.filter(e => e.success).length;
  return Math.round((successes / inWindow.length) * 100);
}

/** Compute percentile from an array of numbers. Returns -1 if empty. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return -1;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/** Compute response latency p50/p95 for a bot in the given window (returns seconds). */
function botLatencyPercentiles(bot: string, windowDays: number): { p50: number; p95: number } {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const samples = responseLatencyEvents
    .filter(e => e.bot === bot && e.ts >= cutoff)
    .map(e => Math.round(e.latencyMs / 1000));
  return { p50: percentile(samples, 50), p95: percentile(samples, 95) };
}



function rollingPointsRate(events: ScoreEvent[], windowDays: number): number {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const total = events.filter(e => e.ts >= cutoff).reduce((sum, e) => sum + e.points, 0);
  return Math.round((total / windowDays) * 10) / 10;
}

/** Get the Unix timestamp (seconds) when a git tag was created. Returns null on failure. */
function getTagTimestampSeconds(tag: string): number | null {
  try {
    const ts = execSync(`git log -1 --format=%ct "${tag}"`, {
      cwd: resolveRoot(), encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const n = parseInt(ts, 10);
    return isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

function computeShipMetrics(): ShipMetrics {
  const pm2Info = getPm2Info();
  const relay = pm2Info.find(p => p.name === 'infiniclaw-relay');
  const tagTs = SEMVER_TAG ? getTagTimestampSeconds(SEMVER_TAG) : null;
  const versionAdoptionLatencySeconds = tagTs != null
    ? Math.round(Date.now() / 1000 - tagTs)
    : null;
  return {
    name: thisShipName(),
    relayUptimePct: {
      day1: computeRelayUptimePct(1),
      day7: computeRelayUptimePct(7),
    },
    relayRestarts: {
      day1: relay?.restartsSince(1) ?? 0,
      day7: relay?.restartsSince(7) ?? 0,
    },
    infraFailures: rolling(infraFailureEvents),
    versionAdoptionLatencySeconds,
  };
}

function computeFleetMetrics(bots: BotMetrics[], operator: OperatorMetrics): FleetMetrics {
  const assigned = bots.filter(b => b.status !== 'sleep' && b.status !== 'transit');
  const running = assigned.filter(b => b.processRunning);

  // Autonomy score: 100 − (interventions × 10) − (crashes × 5)
  // Clamped to [0, 100]. Uses total crashes across all bots.
  const totalCrashes1d = bots.reduce((sum, b) => sum + b.crashes.day1, 0);
  const totalCrashes7d = bots.reduce((sum, b) => sum + b.crashes.day7, 0);
  const autonomy1d = Math.max(0, Math.min(100,
    100 - (operator.interventions.day1 * 10) - (totalCrashes1d * 5)));
  const autonomy7d = Math.max(0, Math.min(100,
    100 - (operator.interventions.day7 * 10) - (totalCrashes7d * 5)));

  return {
    availability: assigned.length > 0
      ? Math.round((running.length / assigned.length) * 100)
      : 0,
    autonomyScore: {
      day1: Math.round(autonomy1d * 10) / 10,
      day7: Math.round(autonomy7d * 10) / 10,
    },
  };
}

// ── Snapshot ─────────────────────────────────────────────────────────

/** Compute a full metrics snapshot for this ship. */
export function computeMetrics(): MetricsSnapshot {
  const operator = computeOperatorMetrics();
  const bots = computeBotMetrics();
  return {
    ship: thisShipName(),
    ts: Date.now(),
    operator,
    bots,
    shipMetrics: computeShipMetrics(),
    fleet: computeFleetMetrics(bots, operator),
  };
}

/** Compute and publish metrics to S3, then write per-bot snapshots to their IPC dirs. */
export async function publishMetrics(): Promise<MetricsSnapshot> {
  const snapshot = computeMetrics();
  try {
    await uploadContent(`metrics/${thisShipName()}.json`, JSON.stringify(snapshot));
  } catch (err) {
    logger.warn({ err: errStr(err) }, 'metrics: failed to publish to S3');
  }
  writeMetricsToGroupIpc(snapshot);
  return snapshot;
}

/**
 * Write per-bot metrics to each bot's duty-room IPC dir as metrics-snapshot.json.
 * Bots read this file via the get_metrics MCP tool to access their own latency,
 * score, and crash count alongside fleet-level context.
 */
export function writeMetricsToGroupIpc(snapshot: MetricsSnapshot): void {
  try {
    const fleet = loadFleet();
    for (const botMetrics of snapshot.bots) {
      const entry = fleet[botMetrics.name.toLowerCase()];
      if (!entry) continue;
      const room = ROLE_ROOMS[entry.role?.toLowerCase() ?? '']?.room;
      if (!room) continue;
      const ipcDir = path.join(DATA_DIR, 'ipc', room);
      if (!fs.existsSync(ipcDir)) continue;
      const fileData = {
        ts: snapshot.ts,
        bot: {
          score: botMetrics.score,
          crashes: botMetrics.crashes,
          responseLatencyP50: botMetrics.responseLatencyP50,
          responseLatencyP95: botMetrics.responseLatencyP95,
        },
        fleet: {
          availability: snapshot.fleet.availability,
          autonomyScore: snapshot.fleet.autonomyScore,
        },
        operator: {
          interventions: snapshot.operator.interventions,
          mtbi: snapshot.operator.mtbi,
        },
        shipMetrics: {
          relayUptimeSeconds: snapshot.shipMetrics.relayUptimeSeconds,
          relayRestarts: snapshot.shipMetrics.relayRestarts,
        },
      };
      const tmpPath = path.join(ipcDir, 'metrics-snapshot.json.tmp');
      fs.writeFileSync(tmpPath, JSON.stringify(fileData, null, 2));
      fs.renameSync(tmpPath, path.join(ipcDir, 'metrics-snapshot.json'));
    }
  } catch (err) {
    logger.warn({ err: errStr(err) }, 'metrics: failed to write per-bot IPC snapshots');
  }
}

// ── Alerting ─────────────────────────────────────────────────────────

export type AlertSeverity = 'critical' | 'warning';

export interface Alert {
  severity: AlertSeverity;
  code: string;
  message: string;
  bot?: string;
}

// Alert thresholds (from design doc)
const ALERT_THRESHOLDS = {
  availabilityMin: 90,    // < 90% = critical
  oomKillsMax: 0,         // any OOM = critical
  syncFailuresMax1d: 2,   // > 2/day = critical
  latencyP95MaxS: 120,    // > 2min p95 = warning
  autonomyScoreMin1d: 50, // < 50 = warning
  interventionsMax1d: 3,  // > 3/day = warning
} as const;

/**
 * Check all alert conditions against a metrics snapshot.
 * Returns an array of triggered alerts (empty = healthy).
 * Called by relay and !metrics command to surface active issues.
 */
export function checkAlerts(snapshot: MetricsSnapshot): Alert[] {
  const alerts: Alert[] = [];
  const { fleet, operator, bots, shipMetrics } = snapshot;

  // 1. Availability < 90%
  if (fleet.availability < ALERT_THRESHOLDS.availabilityMin) {
    alerts.push({
      severity: 'critical',
      code: 'AVAIL_LOW',
      message: `Fleet availability ${fleet.availability}% (threshold ${ALERT_THRESHOLDS.availabilityMin}%)`,
    });
  }

  // 2. Sync failures > 2/day
  if (shipMetrics.infraFailures.day1 > ALERT_THRESHOLDS.syncFailuresMax1d) {
    alerts.push({
      severity: 'critical',
      code: 'SYNC_FAILURES',
      message: `Sync/build failures ${shipMetrics.infraFailures.day1}/day (threshold ${ALERT_THRESHOLDS.syncFailuresMax1d}/day)`,
    });
  }

  // 3. Autonomy score < 50 (1d)
  if (fleet.autonomyScore.day1 < ALERT_THRESHOLDS.autonomyScoreMin1d) {
    alerts.push({
      severity: 'warning',
      code: 'AUTONOMY_LOW',
      message: `Autonomy score ${fleet.autonomyScore.day1}% (1d) below threshold ${ALERT_THRESHOLDS.autonomyScoreMin1d}%`,
    });
  }

  // 4. Interventions > 3/day
  if (operator.interventions.day1 > ALERT_THRESHOLDS.interventionsMax1d) {
    alerts.push({
      severity: 'warning',
      code: 'INTERVENTIONS_HIGH',
      message: `Operator interventions ${operator.interventions.day1}/day (threshold ${ALERT_THRESHOLDS.interventionsMax1d}/day)`,
    });
  }

  // 5. Per-bot: response latency p95 > 2min
  for (const bot of bots) {
    if (bot.responseLatencyP95 != null && bot.responseLatencyP95 > ALERT_THRESHOLDS.latencyP95MaxS) {
      alerts.push({
        severity: 'warning',
        code: 'LATENCY_HIGH',
        message: `${bot.name} response latency p95 ${bot.responseLatencyP95}s (threshold ${ALERT_THRESHOLDS.latencyP95MaxS}s)`,
        bot: bot.name,
      });
    }
  }

  return alerts;
}

/** Format alerts as a human-readable string. Returns empty string if no alerts. */
export function formatAlerts(alerts: Alert[]): string {
  if (alerts.length === 0) return '';
  return alerts
    .map(a => `${a.severity === 'critical' ? '🔴' : '🟡'} [${a.code}] ${a.message}`)
    .join('\n');
}

// ── Formatting ──────────────────────────────────────────────────────

function fmtRolling(m: RollingMetric, unit = '/day'): string {
  return `${m.day1}${unit} (1d) · ${m.day7}${unit} (7d)`;
}

export function formatOperatorMetrics(m: OperatorMetrics): string {
  const lines = [
    `  Interventions: ${fmtRolling(m.interventions)}`,
    `  X-commands issued: ${fmtRolling(m.xCommandsIssued)}`,
  ];
  if (m.mtbi != null) lines.push(`  MTBI: ${m.mtbi}h (7d)`);
  return lines.join('\n');
}

export function formatBotMetrics(b: BotMetrics): string {
  const pip = botBadge(b.status, b.processRunning);
  const name = capitalizeName(b.name);
  const score = `score ${b.score.day1}/${b.score.day7}`;
  const crashes = `crashes ${b.crashes.day1}/${b.crashes.day7}`;
  let line = `  ${pip} ${name} · ${b.status} · ${score} · ${crashes}`;
  if (b.branchBrainSuccess.day1 >= 0 || b.branchBrainSuccess.day7 >= 0) {
    const fmt1 = b.branchBrainSuccess.day1 >= 0 ? `${b.branchBrainSuccess.day1}%` : '—';
    const fmt7 = b.branchBrainSuccess.day7 >= 0 ? `${b.branchBrainSuccess.day7}%` : '—';
    line += ` · bb ${fmt1}/${fmt7}`;
  }
  if (b.messagesPerDay.day1 > 0 || b.messagesPerDay.day7 > 0) {
    line += ` · msg ${b.messagesPerDay.day1}/${b.messagesPerDay.day7}/day`;
  }
  return line;
}

export function formatShipMetrics(m: ShipMetrics): string {
  const ships = safeLoadShips();
  const entry = ships[m.name];
  const tag = entry?.emoji ? `${entry.emoji} ${m.name}` : m.name;
  const lines = [
    `**${tag}**`,
    `  Relay uptime: ${fmtRolling(m.relayUptimePct, '%')}`,
    `  Relay restarts: ${fmtRolling(m.relayRestarts)}`,
    `  Sync/build failures: ${fmtRolling(m.infraFailures)}`,
  ];
  if (m.versionAdoptionLatencySeconds != null) {
    lines.push(`  Version adoption latency: ${formatDurationMs(m.versionAdoptionLatencySeconds * 1000)}`);
  }
  return lines.join('\n');
}

export function formatFleetMetrics(m: FleetMetrics): string {
  return `  Availability: ${m.availability}% · autonomy: ${fmtRolling(m.autonomyScore, '%')}`;
}

export function formatAllMetrics(snapshot: MetricsSnapshot): string {
  const sections = [
    '## 1 · Operator',
    formatOperatorMetrics(snapshot.operator),
    '',
    '## 2 · Ship',
    formatShipMetrics(snapshot.shipMetrics),
    ...snapshot.bots.map(formatBotMetrics),
    '',
    '## 3 · Fleet',
    formatFleetMetrics(snapshot.fleet),
  ];
  return sections.join('\n');
}

export function formatScopeMetrics(snapshot: MetricsSnapshot, scope: string): string {
  if (scope === 'operator') return formatOperatorMetrics(snapshot.operator);
  // Any duty room name maps to ship-level metrics
  const knownRooms = new Set(Object.values(ROLE_ROOMS).map(r => r.room));
  if (scope === 'ship' || knownRooms.has(scope)) return formatShipMetrics(snapshot.shipMetrics);
  if (scope === 'fleet') return formatFleetMetrics(snapshot.fleet);
  if (scope === 'all') return formatAllMetrics(snapshot);

  // "bot <name>" or just a bot name
  const botName = scope.startsWith('bot ') ? scope.slice(4).trim() : scope;
  const bot = snapshot.bots.find(b => b.name === botName);
  if (bot) return formatBotMetrics(bot);

  // If scope looks like a bot name but wasn't found on this ship, return empty
  // so the handler can skip responding (avoids flooding with unrelated data).
  if (botName && botName !== scope) return ''; // "bot xyz" but not found
  // Check if scope matches any known bot name pattern (lowercase, short)
  if (/^[a-z][a-z0-9_-]*$/.test(scope) && scope.length <= 20) return '';

  return formatAllMetrics(snapshot);
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
  try { return loadFleet(); } catch { return {}; }
}

/** Async per-model token breakdown from the S3 token log. Used by get_metrics MCP and dashboard. */
export async function readTokenBreakdownAsync(bot: string, windowDays: number): Promise<Record<string, { input: number; output: number; cache: number; total: number }>> {
  try {
    const { aggregateByModel } = await import('./token-log.js');
    return await aggregateByModel(bot, windowDays * 86_400_000);
  } catch { return {}; }
}
