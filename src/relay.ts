/**
 * Supervisor relay — lightweight Matrix watcher for fleet lifecycle.
 *
 * Connects to each room via its intercom account (from intercom.json),
 * watches for operator commands (!report, !dismiss, !sleep, !wake), and manages
 * bots via pm2 — no CLI needed.
 *
 * Run: node dist/relay.js
 */
import { execFileSync, execSync, spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { collectHealthData, sessionCleanup } from './health-check.js';
import { upsertEnvLine } from './env-utils.js';
import {
  matrixLogin,
  matrixCreateFilter,
  matrixSync,
  matrixSend,
  matrixInvite,
  matrixJoin,
  matrixLeave,
  matrixSetDisplayName,
  matrixSetRoomName,
  matrixSendReaction,
  markdownToHtml,
  loadIntercomConfig,
  clearIntercomConfigCache,
} from './matrix-api.js';
import type { IntercomConfig, SyncResponse } from './matrix-api.js';
import { loadShipConfig, loadFleet, writeFleet, loadFleetAsync, writeFleetAsync, loadShips, safeLoadShips, writeShips, isShipCommissioned, clearShipConfigCache, RUNNING_STATUSES, shipTag, findShipByHostname, thisShipName, ROLE_ROOMS, isQuartersOnlyRole } from './ship-config.js';
import type { BotStatus as BotStatusType } from './ship-config.js';
import { capitalizeName, PIP_FOR_STATUS, ROLE_ICONS, findRoomChief, rankMedal, unifiedShipDisplay, unifiedBotDisplay, formatRerankShipMsg, formatRerankBotMsg, formatRerankNotification, formatDuration, fmtTok, activityEmoji } from './formatting.js';
import {
  initMetrics,
  recordOperatorMessage,
  recordScoreReaction,
  recordBranchBrainResult,
  recordInfraFailure,
  recordMessageDelivery,
  recordBotReply,
  backfillOperatorEvents,
  publishMetrics,
  computeMetrics,
  formatScopeMetrics,
  computeBotHealthGrade,
  computeFleetHealthGrade,
  gradeEmoji,
  type MetricsSnapshot,
  type HealthGrade,
} from './metrics.js';
import { removeBotMounts, grantMount, revokeMount } from './allow-list.js';
import { registerHandlers, dispatch, buildHelpText } from './command-registry.js';
import type { RoomConn } from './command-registry.js';
import {
  resolveRoot,
  getActiveBots,
  bootstrapBot,
  deployBot,
  startBot,
  stopBot,
  restartBotForRoom,
  ensurePodmanReady,
  killStaleContainers,
  loadProfileEnv,
  removeStaleProcesses,
  rebuildImageIfChanged,
  syncDistToInstance,
  collectBotMatrixUserMap,
  readRoomStateStamp,
} from './service.js';
import { getLatestSemverTag, getStampedSemverTag, getLatestSemverTagOnRef, commitsAheadOfTag } from './version.js';
import { sleep, shellQuote, errStr, envInt, escapeRegex } from './utils.js';
import { BRANCH_BRAIN_IMAGE, BRANCH_BRAIN_TIMEOUT_MS, BRANCH_BRAIN_FINALIZE_MS, DUTY_CYCLE_MS, RETROSPECTIVE_TIMEOUT_MS } from './infini-config.js';
import { gitOpts, execErrOutput, gitSyncRepo } from './git-utils.js';
import { readWbs, writeWbs, itemsForBot, reabsorbItems, autoAssign, completeItem } from './wbs.js';
import { pushAll, getClient as getS3Client } from './s3-sync.js';
// health-staleness.ts helpers used by healthWatchdogLoop inline

// ── Config ─────────────────────────────────────────────────────────

const HOSTNAME = os.hostname();
const SYNC_TIMEOUT = 30_000;

const RETRY_DELAY_BASE = 10_000;
const RETRY_DELAY_MAX = 5 * 60_000;
const STARTUP_SYNC_DELAY = 3_000;

/** 502/503/504 mean the server is temporarily unavailable — don't grow backoff. */
function isTransientServerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Sync failed: 50[234]/.test(msg);
}

// Configurable intervals (env vars in milliseconds, or use defaults)
const GITHUB_REPO_URL = 'https://github.com/wawiesel/InfiniClaw';
const GIT_SYNC_INTERVAL = envInt('GIT_SYNC_INTERVAL', 3 * 60_000);          // default 3 min
const SECRETS_SYNC_INTERVAL = envInt('SECRETS_SYNC_INTERVAL', 30_000);       // default 30s
const HEALTH_INTERVAL = envInt('HEALTH_INTERVAL', 30 * 60_000);              // default 30 min
const GIT_SYNC_PUSH_TIMEOUT_MS = envInt('GIT_SYNC_PUSH_TIMEOUT_MS', 60_000); // default 60s (#104)

// ── Failure alerting (thread + exponential backoff) ─────────────────

interface FailureState {
  startedAt: number;        // when the failure first occurred
  threadRootId: string;     // Matrix thread root event_id
  nextAlertAt: number;      // next time to post an update
  intervalMs: number;       // current backoff interval
}

const FAILURE_INITIAL_INTERVAL = 60_000;       // 1 minute
const FAILURE_MAX_INTERVAL = 8 * 60 * 60_000;  // 8 hours
const failureStates: Record<string, FailureState> = {};

function findEngConn(conns: RoomConn[]): RoomConn | undefined {
  return conns.find(c => c.name === 'engineering') || conns[0];
}

function formatTimestamp(): string {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

/** Standard status line: `<emoji> <what> <status> (<time>)`.
 *  Ship identity comes from the [replyTag()] prefix added by reply(). */
function statusLine(emoji: string, what: string, status: string, elapsedMs: number): string {
  const time = elapsedMs > 0
    ? `${formatTimestamp()} · ${formatDuration(elapsedMs)}`
    : formatTimestamp();
  return `${emoji} ${what} ${status} (${time})`;
}

/** Stage result: `✅ <what><suffix>` or `⛔ <what><suffix>` or `⚠️ <what><suffix>` */
function stageOk(what: string, suffix = ''): string { return `✅ ${what}${suffix}`; }
function stageFail(what: string, suffix = ''): string { return `⛔ ${what}${suffix}`; }
function stageWarn(what: string, suffix = ''): string { return `⚠️ ${what}${suffix}`; }
function resultEmoji(warnings: number, errors: number): string { return errors > 0 ? '⛔' : warnings > 0 ? '⚠️' : '✅'; }
function pullResult(outcome: string, warnings: number, errors: number, elapsedMs: number): string {
  return `${resultEmoji(warnings, errors)} relay pull ${outcome} (${warnings}W ${errors}E) ${formatDuration(elapsedMs)}`;
}

async function reportFailure(system: string, detail: string, conns: RoomConn[]): Promise<void> {
  const now = Date.now();
  const conn = findEngConn(conns);
  if (!conn?.accessToken) return;

  const existing = failureStates[system];
  recordInfraFailure(system); // count every occurrence, not just first
  if (!existing) {
    // First failure — create thread
    const rootId = await reply(conn, statusLine('⚠️', system, 'down', 0));
    if (!rootId) return;
    // Set backoff state BEFORE threadReply so a throw doesn't lose the state and cause spam.
    failureStates[system] = {
      startedAt: now,
      threadRootId: rootId,
      nextAlertAt: now + FAILURE_INITIAL_INTERVAL,
      intervalMs: FAILURE_INITIAL_INTERVAL,
    };
    await threadReply(conn, rootId, detail.slice(0, 500));
    return;
  }

  // Subsequent failure — only post if past nextAlertAt
  if (now < existing.nextAlertAt) return;
  // Advance backoff BEFORE threadReply so a throw doesn't reset the timer and cause spam.
  existing.intervalMs = Math.min(existing.intervalMs * 2, FAILURE_MAX_INTERVAL);
  existing.nextAlertAt = now + existing.intervalMs;
  await threadReply(conn, existing.threadRootId, statusLine('⚠️', system, 'down', now - existing.startedAt));
}

async function reportRecovery(system: string, conns: RoomConn[]): Promise<void> {
  const state = failureStates[system];
  if (!state) return;
  delete failureStates[system];

  const conn = findEngConn(conns);
  if (!conn?.accessToken) return;
  const recoveryMsg = statusLine('✅', system, 'operational', Date.now() - state.startedAt);
  await reply(conn, recoveryMsg);
}

/** Load GitHub bot token from secrets for PR reviews (returns empty string if unavailable). */
function loadGitHubBotToken(): string {
  try {
    const p = path.join(os.homedir(), '.config', 'infiniclaw', 'secrets', 'operator', 'github-bot.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return typeof data?.token === 'string' ? data.token : '';
  } catch { return ''; }
}

// ── In-memory fleet state (authoritative at runtime, persisted on shutdown) ──

type FleetEntry = { role: string; rank: number; ship: string | null; status: BotStatusType; triggerType?: 'always' | 'callout' | 'never'; title?: string; quartersRoom?: string; activeBrainModel?: string; ondutyAt?: number };
let liveFleet: Record<string, FleetEntry> = {};
/** Cached BehindTheCurtain room ID — set once on startup from operator-matrix.json. */
let curtainRoomId: string | null = null;
/** Read this ship's operatorRelay flag from ships.json (default: true). */
function isOperatorRelayEnabled(): boolean {
  return findShipByHostname()?.[1]?.operatorRelay !== false;
}

const OPERATOR_SESSION = 'operator';
const OPERATOR_PANE = `${OPERATOR_SESSION}:0.0`;

/** Send keys to the operator tmux pane. */
function tmuxSend(text: string): void {
  execFileSync('tmux', ['send-keys', '-t', OPERATOR_PANE, '-l', text], { stdio: 'pipe' });
  execFileSync('tmux', ['send-keys', '-t', OPERATOR_PANE, 'Enter'], { stdio: 'pipe' });
}

/** Capture the operator tmux pane contents. */
function tmuxCapture(): string {
  return execFileSync('tmux', ['capture-pane', '-t', OPERATOR_PANE, '-p'], { encoding: 'utf-8' });
}

/** Post a message to BehindTheCurtain as the operator Matrix account. */
async function postToBTC(text: string): Promise<void> {
  const opFile = path.join(secretsRepoPath(), 'operator', 'operator-matrix.json');
  const opConf = JSON.parse(fs.readFileSync(opFile, 'utf-8'));
  const roomId = opConf.rooms?.['BehindTheCurtain'];
  if (!roomId || !opConf.accessToken) return;
  const tagged = `[${replyTag()}] ${text}`;
  await matrixSend({ homeserver: opConf.homeserver, token: opConf.accessToken, roomId, text: tagged, log });
}

/**
 * Reset the operator Claude Code session via tmux.
 * Invariant: when done, a fresh Claude instance is running in the operator
 * tmux session and a remote-control URL has been posted to BTC.
 */
async function resetOperatorSession(conn: RoomConn): Promise<void> {
  const secretsDir = secretsRepoPath();

  // 1. Exit current Claude Code session
  try {
    execFileSync('tmux', ['has-session', '-t', OPERATOR_SESSION], { stdio: 'pipe' });
    tmuxSend('/exit');
  } catch {
    // No session — will be created below
  }
  await sleep(10_000);

  // 2. Start fresh Claude Code in the secrets dir
  try {
    execFileSync('tmux', ['has-session', '-t', OPERATOR_SESSION], { stdio: 'pipe' });
  } catch {
    // Session gone — create it
    execFileSync('tmux', ['new-session', '-d', '-s', OPERATOR_SESSION, '-c', secretsDir], { stdio: 'pipe' });
    await sleep(2_000);
  }
  tmuxSend(`cd ${shellQuote(secretsDir)} && claude --model claude-opus-4-6 --dangerously-skip-permissions`);
  await sleep(15_000);

  // 3. Enable remote-control
  tmuxSend('/remote-control');
  await sleep(10_000);

  // 4. Capture remote-control URL from pane output
  const paneText = tmuxCapture();
  const urlMatch = paneText.match(/https:\/\/claude\.ai\/code\/session_\S+/);

  if (urlMatch) {
    await postToBTC(`Operator restarted. Remote-control: ${urlMatch[0]}`);
    log(`operator reset: URL posted to BTC`);
  } else {
    await postToBTC('Operator restarted but remote-control URL not found. Connect manually.');
    log('operator reset: URL not found in pane output');
  }
}

let fleetDirty = false;
/** Active intercom connections — set in startRelay so lifecycle helpers can send messages. */
let activeConns: RoomConn[] = [];
/** Cached speaker state — updated by electSpeaker() so reply() can include it in the tag synchronously. */
let isSpeakerCached = false;
/** Map Matrix userId → bot name for resolving reaction targets. Built once at startup. */
let botUserIdMap: Map<string, string> = new Map();
/** Cache of recent Matrix event IDs → bot name for score reaction enrichment. Capped at 500. */
const recentBotEventIds = new Map<string, string>();

function fleetUpdate(bot: string, updates: Partial<FleetEntry>): void {
  if (!liveFleet[bot]) return;
  Object.assign(liveFleet[bot], updates);
  fleetDirty = true;
}

function persistFleet(): void {
  if (!fleetDirty) return;
  // S3 first (async, fire-and-forget), disk second (sync cache)
  writeFleetAsync(liveFleet).catch((err) => {
    log(`fleet: S3 persist failed: ${errStr(err)}`);
  });
  fleetDirty = false;
  log('fleet: persisted (S3 + disk)');
}

/** Blocking persist: S3 + disk — use before process exit. */
async function persistFleetSync(): Promise<void> {
  try {
    await writeFleetAsync(liveFleet);
    fleetDirty = false;
    log('fleet: persisted to S3 + disk (sync)');
  } catch (err) {
    log(`fleet: persist failed: ${errStr(err)}`);
    // Fallback: at least write to disk
    try { writeFleet(liveFleet); fleetDirty = false; } catch { /* give up */ }
  }
}

/**
 * Write crew-status.json to a bot's instance data dir.
 * Called after bootstrapBot so the container's crew_roster MCP tool has current roster.
 */
function writeCrewStatus(root: string, bot: string): void {
  const instanceData = path.join(root, '_runtime', 'instances', bot, 'data');
  fs.mkdirSync(instanceData, { recursive: true });

  interface CrewEntry {
    name: string; role: string; rank: number; title?: string;
    room: string; present: boolean; isChief: boolean;
  }

  const raw: (Omit<CrewEntry, 'isChief'>)[] = [];
  for (const [name, entry] of Object.entries(liveFleet)) {
    const present = entry.status !== 'sleep' && entry.status !== 'dream';
    let room = 'Quarters';
    if (entry.status === 'onduty') {
      const dutyRoom = ROLE_ROOMS[entry.role?.toLowerCase() ?? '']?.room;
      room = dutyRoom ? capitalizeName(dutyRoom) : 'Duty Room';
    }
    const e: Omit<CrewEntry, 'isChief'> = { name: capitalizeName(name), role: entry.role, rank: entry.rank, room, present };
    if (entry.title) e.title = entry.title;
    raw.push(e);
  }

  // Lowest rank among present bots per room = CO
  const roomBots: Record<string, { name: string; rank: number }[]> = {};
  for (const e of raw) {
    if (e.present) (roomBots[e.room] ??= []).push({ name: e.name, rank: e.rank });
  }
  const coByRoom: Record<string, string> = {};
  for (const [room, members] of Object.entries(roomBots)) {
    coByRoom[room] = members.sort((a, b) => a.rank - b.rank)[0].name;
  }

  const crew: CrewEntry[] = raw
    .sort((a, b) => a.rank - b.rank)
    .map(e => ({ ...e, isChief: e.present && coByRoom[e.room] === e.name }));

  try {
    fs.writeFileSync(
      path.join(instanceData, 'crew-status.json'),
      JSON.stringify({ thisBot: bot, generatedAt: new Date().toISOString(), crew }, null, 2),
    );
  } catch (err) {
    log(`writeCrewStatus: ${bot} failed — ${errStr(err)}`);
  }
}

// ── WBS relay integration ─────────────────────────────────────

/** Path to the shared WBS data directory. */
function wbsDataDir(root: string): string {
  return path.join(root, '_runtime', 'data');
}

/**
 * Get the duty room name for a bot, used as the WBS key.
 * Falls back to the bot name if no room mapping exists.
 */
function wbsRoomForBot(bot: string): string {
  return botDutyRoom(bot) || bot;
}

/**
 * Inject a bot's WBS-assigned items into its instance data dir as wbs-initial.json.
 * Called after bootstrapBot so the bot can read its task list at startup.
 * Non-fatal: logs on failure.
 */
function injectWbsTasks(root: string, bot: string): void {
  try {
    const dataDir = wbsDataDir(root);
    const room = wbsRoomForBot(bot);
    const wbs = readWbs(dataDir, room);
    const items = itemsForBot(wbs, bot);
    if (items.length === 0) return; // nothing to inject
    const instanceData = path.join(root, '_runtime', 'instances', bot, 'data');
    fs.mkdirSync(instanceData, { recursive: true });
    fs.writeFileSync(
      path.join(instanceData, 'wbs-initial.json'),
      JSON.stringify({ items }, null, 2) + '\n',
    );
    log(`wbs: injected ${items.length} task(s) for ${bot} (room: ${room})`);
  } catch (err) {
    log(`wbs: injectWbsTasks(${bot}) failed — ${errStr(err)}`);
  }
}

/**
 * Reabsorb all WBS items assigned to a bot back to the pool.
 * Called when a bot goes off duty (sleep, dismiss).
 * Non-fatal: logs on failure.
 */
function reabsorbWbsItems(root: string, bot: string): void {
  try {
    const dataDir = wbsDataDir(root);
    const room = wbsRoomForBot(bot);
    const wbs = readWbs(dataDir, room);
    const count = reabsorbItems(wbs, bot);
    if (count > 0) {
      writeWbs(dataDir, room, wbs);
      log(`wbs: reabsorbed ${count} item(s) from ${bot} (room: ${room})`);
    }
  } catch (err) {
    log(`wbs: reabsorbWbsItems(${bot}) failed — ${errStr(err)}`);
  }
}

/**
 * Auto-assign the highest-priority ready WBS item to an idle bot.
 * Called from heartbeatLoop for bots with no current WBS assignment.
 * Returns the assigned item title, or undefined if nothing available.
 * Non-fatal: logs on failure.
 */
function autoAssignWbsItem(root: string, bot: string): string | undefined {
  try {
    const dataDir = wbsDataDir(root);
    const room = wbsRoomForBot(bot);
    const wbs = readWbs(dataDir, room);
    if (itemsForBot(wbs, bot).length > 0) return undefined; // already has items
    const item = autoAssign(wbs, bot);
    if (item) {
      writeWbs(dataDir, room, wbs);
      log(`wbs: auto-assigned "${item.title}" to ${bot} (room: ${room})`);
      return item.title;
    }
  } catch (err) {
    log(`wbs: autoAssignWbsItem(${bot}) failed — ${errStr(err)}`);
  }
  return undefined;
}

/**
 * Mark a WBS item done and unblock dependents.
 * Called when a bot signals completion via a wbs_complete relay task.
 * Non-fatal: logs on failure.
 */
function completeWbsItem(root: string, bot: string, itemId: string): string[] {
  try {
    const dataDir = wbsDataDir(root);
    const room = wbsRoomForBot(bot);
    const wbs = readWbs(dataDir, room);
    const unblocked = completeItem(wbs, itemId);
    writeWbs(dataDir, room, wbs);
    log(`wbs: completed item "${itemId}" for ${bot}; unblocked: [${unblocked.join(', ')}]`);
    return unblocked;
  } catch (err) {
    log(`wbs: completeWbsItem(${bot}, ${itemId}) failed — ${errStr(err)}`);
    return [];
  }
}

// ── Rank swap (shared by bots and ships) ──────────────────────

/** Swap rank of target with its neighbor. Mutates entries in place. Returns null if at boundary. */
function rankSwap<T extends { rank: number }>(
  entries: [string, T][],
  target: string,
  direction: 'up' | 'down',
): { target: string; swap: string; targetRank: number; swapRank: number } | null {
  const sorted = [...entries].sort((a, b) => a[1].rank - b[1].rank);
  const idx = sorted.findIndex(([name]) => name === target);
  if (idx < 0) return null;
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= sorted.length) return null;
  const oldRank = sorted[idx][1].rank;
  sorted[idx][1].rank = sorted[swapIdx][1].rank;
  sorted[swapIdx][1].rank = oldRank;
  return { target, swap: sorted[swapIdx][0], targetRank: sorted[idx][1].rank, swapRank: sorted[swapIdx][1].rank };
}

// ── Sync/rebuild helpers (used by !pull) ────────

function formatSyncResult(name: string, r: { ok: boolean; newCommits: number; output: string }): string {
  if (!r.ok) return `${name}: failed — ${r.output.slice(0, 200)}`;
  return r.newCommits > 0 ? `${name}: pulled ${r.newCommits} commit(s)` : `${name}: up to date`;
}

function rebuildInfiniClaw(): string {
  const root = resolveRoot();
  try {
    const nodeBinDir = path.dirname(process.execPath);
    const execOpts = { cwd: root, encoding: 'utf-8' as const, stdio: 'pipe' as const, env: { ...process.env, PATH: `${nodeBinDir}:${process.env.PATH}` } };
    // Install deps, build workspace package, then compile TypeScript
    execSync('npm install --ignore-scripts', { ...execOpts, timeout: 120_000 });
    // Rebuild native modules for the running Node version — prebuilt binaries from
    // npm install may be compiled for a different Node ABI (e.g. Node 22 vs 24).
    execSync('npm rebuild better-sqlite3', { ...execOpts, timeout: 120_000 });
    execSync('npm run build -w nanoclaw', { ...execOpts, timeout: 120_000 });
    execSync('npx tsc', { ...execOpts, timeout: 180_000 });
    try { installGitHooks(); } catch { /* best effort */ }
    // Deploy dist files to active bot instances
    const distDir = path.join(root, 'dist');
    if (fs.existsSync(distDir)) {
      const jsFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));
      for (const bot of getActiveBots()) {
        const dstDir = path.join(root, '_runtime', 'instances', bot, 'dist');
        for (const f of jsFiles) {
          try { fs.copyFileSync(path.join(distDir, f), path.join(dstDir, f)); } catch { /* instance may not exist yet */ }
        }
      }
    }
    refreshLocalCommitEpoch();
    publishCommitEpoch().catch(() => {});
    return 'infiniclaw: rebuild succeeded';
  } catch (err) {
    return `infiniclaw: rebuild FAILED — ${errStr(err).slice(0, 200)}`;
  }
}

function resolveCaptainUserId(): string {
  try {
    const captainFile = path.join(secretsRepoPath(), 'captain');
    const lines = fs.readFileSync(captainFile, 'utf-8').split('\n');
    for (const line of lines) {
      const match = line.match(/^CAPTAIN_USER_ID=(.+)$/);
      if (match) return match[1].trim();
    }
  } catch { /* missing file */ }
  return '';
}

function resolveOperatorConfig(): { userId: string; accessToken: string } {
  try {
    const opFile = path.join(secretsRepoPath(), 'operator', 'operator-matrix.json');
    const config = JSON.parse(fs.readFileSync(opFile, 'utf-8'));
    return { userId: config.userId || '', accessToken: config.accessToken || '' };
  } catch { return { userId: '', accessToken: '' }; }
}

function loadLoudspeakerConfig(): { homeserver: string; username: string; password: string; accessToken: string } | null {
  try {
    const lsFile = path.join(secretsRepoPath(), 'operator', process.env['INFINICLAW_LOUDSPEAKER'] || 'loudspeaker-matrix.json');
    const config = JSON.parse(fs.readFileSync(lsFile, 'utf-8'));
    return {
      homeserver: config.homeserver || '',
      username: config.username || '',
      password: config.password || '',
      accessToken: config.accessToken || '',
    };
  } catch { return null; }
}

let loudspeakerToken: string | null = null;

async function getLoudspeakerToken(homeserver: string, username: string, password: string): Promise<string | null> {
  if (loudspeakerToken) return loudspeakerToken;
  try {
    const { accessToken } = await relayMatrixLogin(homeserver, username, password);
    loudspeakerToken = accessToken;
    return loudspeakerToken;
  } catch (err) {
    log(`loudspeaker login failed: ${errStr(err)}`);
    return null;
  }
}

function loadHelpConfig(): { homeserver: string; username: string; password: string; accessToken: string } | null {
  try {
    const helpFile = path.join(secretsRepoPath(), 'operator', 'help-matrix.json');
    const config = JSON.parse(fs.readFileSync(helpFile, 'utf-8'));
    return {
      homeserver: config.homeserver || '',
      username: config.username || '',
      password: config.password || '',
      accessToken: config.accessToken || '',
    };
  } catch { return null; }
}

let helpToken: string | null = null;

async function getHelpToken(homeserver: string, username: string, password: string): Promise<string | null> {
  if (helpToken) return helpToken;
  try {
    const { accessToken } = await relayMatrixLogin(homeserver, username, password);
    helpToken = accessToken;
    return helpToken;
  } catch (err) {
    log(`help login failed: ${errStr(err)}`);
    return null;
  }
}

function resolveOperatorUserId(): string {
  return resolveOperatorConfig().userId;
}

/** Captain and operator are both fully trusted. */
function isAuthorized(sender: string, captainUserId: string, operatorUserId: string): boolean {
  return sender === captainUserId || sender === operatorUserId;
}

/** Dedup: multiple sync loops (curtainLoop + dialtone) see the same events. Track processed IDs to avoid double-handling. */
const processedEventIds = new Set<string>();
const PROCESSED_MAX = 500;
function markProcessed(eventId: string): boolean {
  if (processedEventIds.has(eventId)) return false;
  processedEventIds.add(eventId);
  if (processedEventIds.size > PROCESSED_MAX) {
    const first = processedEventIds.values().next().value;
    if (first) processedEventIds.delete(first);
  }
  return true;
}


/** Load persisted Matrix sync token for a named loop. Returns null if not found. */
function loadSyncToken(key: string): string | null {
  try {
    const file = path.join(resolveRoot(), '_runtime', 'data', `sync-token-${key}.txt`);
    if (!fs.existsSync(file)) return null;
    const tok = fs.readFileSync(file, 'utf-8').trim();
    return tok || null;
  } catch { return null; }
}

/** Persist Matrix sync token to disk so restarts replay missed events. */
function saveSyncToken(key: string, token: string): void {
  try {
    const dir = path.join(resolveRoot(), '_runtime', 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `sync-token-${key}.txt`), token, 'utf-8');
  } catch { /* non-fatal */ }
}

// ── Git version helper ────────────────────────────────────────────

/** Format version string: ` · 📦 v1.4.0 [sha](github) (age) ↑N|↓N` */
function fmtVersion(sha: string, ageMs: number, ud: string, tag?: string | null): string {
  const url = `${GITHUB_REPO_URL}/commit/${sha}`;
  const tagPrefix = tag ? `${tag} ` : '';
  return ` · 📦 ${tagPrefix}[${sha}](${url}) (${formatDuration(ageMs)}) ${ud}`;
}

/** Compute ↑N/↓N relation between two refs. */
function gitRelation(root: string, local: string, upstream: string): string {
  const execOpts = gitOpts(root, 5_000);
  const ahead = parseInt(execSync(`git rev-list ${upstream}..${local} --count`, execOpts).trim(), 10) || 0;
  const behind = parseInt(execSync(`git rev-list ${local}..${upstream} --count`, execOpts).trim(), 10) || 0;
  if (ahead > 0 && behind > 0) return `↑${ahead}↓${behind}`;
  if (ahead > 0) return `↑${ahead}`;
  if (behind > 0) return `↓${behind}`;
  return '↑0';
}

/** Commit age in ms from a sha. */
function commitAge(root: string, sha: string): number {
  const execOpts = gitOpts(root, 5_000);
  const epoch = parseInt(execSync(`git log -1 --format=%ct ${sha}`, execOpts).trim(), 10) * 1000;
  return Date.now() - epoch;
}

/** Version string for a repo: HEAD vs origin/main. */
function repoVersion(repoDir: string): string {
  try {
    const execOpts = gitOpts(repoDir, 5_000);
    const sha = execSync('git rev-parse --short HEAD', execOpts).trim();
    if (!sha) return '';
    const tag = getLatestSemverTag(repoDir);
    return fmtVersion(sha, commitAge(repoDir, sha), gitRelation(repoDir, 'HEAD', 'origin/main'), tag);
  } catch { return ''; }
}

/** Version string for the relay dist: HEAD vs origin (relay is built from repo HEAD). */
function relayVersion(root: string): string {
  return repoVersion(root);
}

/** Semver tag for a bot's deployed instance (e.g. "v1.3.12"), or null. */
function botSemver(root: string, bot: string): string | null {
  try {
    const tag = fs.readFileSync(path.join(root, '_runtime', 'instances', bot, 'SEMVER_VERSION'), 'utf-8').trim();
    return tag || null;
  } catch { return null; }
}

/** Version string for a bot's deployed instance: stamped sha vs HEAD. */
function botVersion(root: string, bot: string): string {
  try {
    const versionFile = path.join(root, '_runtime', 'instances', bot, 'GIT_VERSION');
    const sha = fs.readFileSync(versionFile, 'utf-8').trim().split(' ')[0];
    if (!sha || !/^[a-f0-9]{7,40}$/.test(sha)) return '';
    return fmtVersion(sha, commitAge(root, sha), gitRelation(root, sha, 'HEAD'), botSemver(root, bot));
  } catch { return ''; }
}

// ── Speaker election via S3 commit timestamps ────────────────────

const RELAY_S3_PREFIX = 'relay';
const FLEET_S3_PREFIX = 'fleet-report';
const FLEET_ASSEMBLED_S3_KEY = 'fleet-assembled/latest.json';
const METRICS_ASSEMBLED_S3_KEY = 'metrics-assembled/latest.json';
let localCommitEpoch = 0; // epoch seconds of HEAD commit the relay is running

/** Read the commit timestamp of the code this relay is actually running. Called once at startup and after rebuilds. */
function refreshLocalCommitEpoch(): void {
  try {
    const root = resolveRoot();
    const epoch = execSync('git log -1 --format=%ct HEAD', gitOpts(root, 5_000)).trim();
    localCommitEpoch = parseInt(epoch, 10) || 0;
  } catch {
    localCommitEpoch = 0;
  }
}

/** Upload this ship's commit epoch to S3 so other ships can compare. */
async function publishCommitEpoch(): Promise<void> {
  const s3 = getS3Client();
  if (!s3 || !localCommitEpoch) return;
  try {
    await s3.client.send(new PutObjectCommand({
      Bucket: s3.bucket,
      Key: `${RELAY_S3_PREFIX}/${HOSTNAME}.json`,
      Body: Buffer.from(JSON.stringify({ hostname: HOSTNAME, commitEpoch: localCommitEpoch, updatedAt: new Date().toISOString() })),
      ContentType: 'application/json',
    }));
  } catch (err) {
    log(`S3 commit epoch publish failed: ${errStr(err)}`);
  }
}

/** Fetch all ships' commit epochs from S3. */
async function fetchCommitEpochs(): Promise<Record<string, number>> {
  const s3 = getS3Client();
  if (!s3) return {};
  const result: Record<string, number> = {};
  try {
    const listed = await s3.client.send(new ListObjectsV2Command({
      Bucket: s3.bucket,
      Prefix: `${RELAY_S3_PREFIX}/`,
    }));
    for (const obj of listed.Contents || []) {
      if (!obj.Key?.endsWith('.json')) continue;
      try {
        const resp = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: obj.Key }));
        const chunks: Uint8Array[] = [];
        for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
        const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        if (data.hostname && typeof data.commitEpoch === 'number') {
          result[data.hostname] = data.commitEpoch;
        }
      } catch { /* skip corrupt */ }
    }
  } catch (err) {
    log(`S3 commit epoch fetch failed: ${errStr(err)}`);
  }
  return result;
}

async function electSpeaker(): Promise<boolean> {
  try {
    const ships = loadShips();
    const commissioned = Object.entries(ships).filter(([, m]) => m.commissioned);
    if (commissioned.length === 0) return true;
    if (!commissioned.some(([, e]) => e.hostname === HOSTNAME)) return false;

    // Speaker = lowest-rank commissioned ship. Rank is the sole tiebreaker.
    // Epoch-based deferral was removed: it caused rank-3 ships to become speaker
    // when they had the freshest code, and dropped commands during rolling deploys.
    const sorted = commissioned.sort((a, b) => (a[1].rank ?? 99) - (b[1].rank ?? 99));
    isSpeakerCached = sorted.length > 0 && sorted[0][1].hostname === HOSTNAME;
    return isSpeakerCached;
  } catch {
    // Fail-safe: on error, don't claim speaker status — prefer silence over false authority
    isSpeakerCached = false;
    return false;
  }
}

// ── Matrix API helpers (delegates to matrix-api.ts) ─────────────────

/** Relay-specific login: passes device_id for relay identification. */
async function relayMatrixLogin(homeserver: string, username: string, password: string): Promise<{ accessToken: string; userId: string }> {
  return matrixLogin(homeserver, username, password, `relay-${HOSTNAME}`);
}

/** Send a message to a room (plain or threaded). */
async function relaySend(homeserver: string, token: string, roomId: string, text: string, threadRootId?: string): Promise<string | undefined> {
  return matrixSend({ homeserver, token, roomId, text, threadRootId, log });
}

/** React to a message with 📡 to signal relay received it. Fire-and-forget, deduped per event. */
const ackedEventIds = new Set<string>();
function relayAck(homeserver: string, token: string, roomId: string, eventId: string): void {
  if (ackedEventIds.has(eventId)) return;
  ackedEventIds.add(eventId);
  if (ackedEventIds.size > PROCESSED_MAX) {
    const first = ackedEventIds.values().next().value;
    if (first) ackedEventIds.delete(first);
  }
  matrixSendReaction(homeserver, token, roomId, eventId, '📡', log).catch(() => {});
}

/** Room emoji map for the double-emoji naming scheme: <location><room> Name. Duty rooms derived from ROLE_ROOMS. */
const ROOM_EMOJI: Record<string, string> = {
  ...Object.fromEntries(Object.values(ROLE_ROOMS).map(r => [r.room, r.icon])),
  lounge: '🛋️', curtain: '🎭',
};
const FLEET_LOCATION = '🌌';
const QUARTERS_EMOJI = '🏠';
/** Fleet suffix derived from INFINICLAW_FLEET env var: "00" for fleet.json, "01" for fleet01.json, etc. */
const FLEET_SUFFIX = (() => {
  const f = process.env['INFINICLAW_FLEET'] || 'fleet.json';
  const m = f.match(/fleet(\d+)\.json$/);
  return m ? m[1].padStart(2, '0') : '00';
})();

/** Ensure all ship spaces, fleet rooms, and quarters rooms have correct emoji-prefixed names. */
async function ensureRoomNames(): Promise<void> {
  const opFile = path.join(secretsRepoPath(), 'operator', 'operator-matrix.json');
  let opConfig: { homeserver: string; accessToken: string } | null = null;
  try {
    opConfig = JSON.parse(fs.readFileSync(opFile, 'utf-8'));
  } catch { return; }
  const { homeserver, accessToken } = opConfig ?? {};
  if (!homeserver || !accessToken) return;

  const found = findShipByHostname();
  if (!found) return;
  const [shipName, shipEntry] = found;
  const shipEmoji = shipEntry.emoji || '';

  const getName = async (roomId: string): Promise<string | null> => {
    try {
      const resp = await fetch(
        `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`,
        { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(5_000) },
      );
      if (!resp.ok) return null;
      const data = await resp.json() as { name?: string };
      return data.name ?? null;
    } catch { return null; }
  };
  const setName = async (roomId: string, name: string) => {
    const current = await getName(roomId);
    if (current === name) return; // already correct
    const ok = await matrixSetRoomName(homeserver, accessToken, roomId, name).catch(() => false);
    log(`ensureRoomNames: ${ok ? '✅' : '❌'} ${name}`);
  };

  // Ship space: "🦁 Herc"
  if (shipEntry.spaceId && shipEmoji) {
    await setName(shipEntry.spaceId, `${shipEmoji} ${shipName}`);
  }

  // Fleet rooms (bridge, engineering, astrometrics): "🌌⚙️ Engineering"
  const intercom = loadIntercomConfig();
  if (intercom) {
    for (const [name, room] of Object.entries(intercom.rooms)) {
      const roomEmoji = ROOM_EMOJI[name];
      if (roomEmoji) {
        await setName(room.roomId, `${roomEmoji} ${capitalizeName(name)}${FLEET_SUFFIX}`);
      }
    }
  }

  // Lounge: "<ship>🛋️ Lounge"
  if (shipEntry.loungeId && shipEmoji) {
    await setName(shipEntry.loungeId, `${shipEmoji}${ROOM_EMOJI.lounge} Lounge`);
  }

  // BehindTheCurtain: "🌑🎭 BehindTheCurtain"
  try {
    const opData = JSON.parse(fs.readFileSync(opFile, 'utf-8'));
    const curtainId = opData?.rooms?.BehindTheCurtain;
    if (curtainId) {
      await setName(curtainId, `🌑${ROOM_EMOJI.curtain} BehindTheCurtain`);
    }
  } catch { /* non-fatal */ }

  // Quarters space: "<ship>🏠 Quarters"
  if (shipEntry.quartersSpaceId && shipEmoji) {
    await setName(shipEntry.quartersSpaceId, `${shipEmoji}${QUARTERS_EMOJI} Quarters`);
  }

  // Quarters rooms: "<ship>🏠 Name's Room"
  const root = resolveRoot();
  for (const [bot, entry] of Object.entries(liveFleet)) {
    if (entry.ship !== HOSTNAME || !entry.quartersRoom) continue;
    try {
      const env = loadProfileEnv(root, bot);
      const botName = env.ASSISTANT_NAME || capitalizeName(bot);
      await setName(entry.quartersRoom, `${shipEmoji}${QUARTERS_EMOJI} ${botName}'s Room`);
    } catch { /* skip bots with broken env */ }
  }
}

// ── Bot Matrix room management ──────────────────────────────────

/** Login as a bot using its env file credentials. */
async function botMatrixLogin(root: string, bot: string): Promise<{ token: string; homeserver: string; userId: string }> {
  const env = loadProfileEnv(root, bot);
  const homeserver = env.MATRIX_HOMESERVER;
  const username = env.MATRIX_USERNAME;
  const password = env.MATRIX_PASSWORD;
  if (!homeserver || !username || !password) throw new Error(`${bot}: missing Matrix credentials in env`);
  const { accessToken, userId } = await matrixLogin(homeserver, username, password);
  return { token: accessToken, homeserver, userId };
}

/** Invite a bot to a room using the operator account, then join as the bot. */
async function botJoinRoom(botToken: string, homeserver: string, roomId: string, _conn: RoomConn, botUserId: string): Promise<void> {
  const { accessToken: operatorToken } = resolveOperatorConfig();
  if (operatorToken) {
    const ok = await matrixInvite(homeserver, operatorToken, roomId, botUserId);
    if (!ok) log(`invite failed for ${botUserId} to ${roomId}`);
  }
  // Join as the bot (retry once on transient failure)
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ok = await matrixJoin(homeserver, botToken, roomId);
      if (!ok) throw new Error(`join room failed for ${roomId}`);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt === 0) log(`botJoinRoom: attempt 1 failed (${errStr(err)}), retrying...`);
    }
  }
  throw lastErr;
}

/** Make a bot leave a Matrix room. Silently succeeds if bot isn't in the room. */
async function botLeaveRoom(token: string, homeserver: string, roomId: string): Promise<void> {
  await matrixLeave(homeserver, token, roomId);
}

/** Build the full set of display params for a bot — single source of truth.
 *  All unifiedBotDisplay call sites MUST use this instead of assembling params ad-hoc.
 *  Optional overrides allow transient statuses (building, starting) and external data (health, tokPerDay). */
function buildBotDisplayParams(
  botName: string,
  overrides?: { status?: string; health?: string; tokPerDay?: number; shipEmoji?: string; version?: string },
): import('./formatting.js').UnifiedBotDisplayParams {
  const entry = liveFleet[botName];
  const root = resolveRoot();
  const role = (entry?.role ?? '').toLowerCase();
  const status = overrides?.status ?? entry?.status ?? 'sleep';
  const isOnDuty = status === 'onduty';
  const locationEmoji = isOnDuty ? (ROLE_ROOMS[role]?.icon ?? '') : '🏠';
  const allBotList = Object.entries(liveFleet).map(([n, e]) => ({ name: n, role: e.role, rank: e.rank, status: e.status }));
  const dutyRoom = ROLE_ROOMS[role]?.room ?? '';
  const co = findRoomChief(dutyRoom, allBotList) === botName;
  return {
    name: botName,
    shipEmoji: overrides?.shipEmoji ?? findShipByHostname()?.[1]?.emoji ?? '',
    locationEmoji,
    health: overrides?.health ?? '',
    tokPerDay: overrides?.tokPerDay ?? 0,
    status,
    role,
    rank: entry?.rank ?? 99,
    isChief: co,
    version: overrides?.version ?? botSemver(root, botName) ?? undefined,
  };
}

/** Update a bot's Matrix display name to unified format with a given display status.
 *  Display statuses: 'sleep', 'building', 'starting', 'waiting', 'online', 'ready',
 *  or the bot's actual fleet status (onduty/quarters) for grade-based display. */
async function setBotDisplayStatus(root: string, bot: string, displayStatus: string): Promise<void> {
  try {
    if (!liveFleet[bot]) return;
    const displayName = unifiedBotDisplay(buildBotDisplayParams(bot, { status: displayStatus }), 'short');
    const { token, homeserver, userId } = await botMatrixLogin(root, bot);
    await matrixSetDisplayName(homeserver, token, userId, displayName);
  } catch (err) {
    log(`setBotDisplayStatus ${bot} ${displayStatus}: ${errStr(err)}`);
  }
}

/** Sync display names for ALL bots on this ship (including sleeping ones). */
async function syncBotDisplayNames(): Promise<void> {
  const root = resolveRoot();
  for (const [bot, entry] of Object.entries(liveFleet)) {
    if (entry.ship !== HOSTNAME) continue;
    const displayName = unifiedBotDisplay(buildBotDisplayParams(bot), 'short');
    try {
      const { token, homeserver, userId } = await botMatrixLogin(root, bot);
      await matrixSetDisplayName(homeserver, token, userId, displayName);
    } catch (err) {
      log(`syncBotDisplayNames ${bot}: ${errStr(err)}`);
    }
  }
}

/**
 * Restart all running bots on this ship, preserving their current status.
 * Onduty bots stay onduty, quarters bots stay in quarters. Sleeping bots are skipped.
 * Returns { started, failed } arrays.
 */
function restartRunningBots(root: string): { started: string[]; failed: string[] } {
  const started: string[] = [];
  const failed: string[] = [];
  for (const [bot, entry] of Object.entries(liveFleet)) {
    if (entry.ship !== HOSTNAME) continue;
    if (!(RUNNING_STATUSES as readonly string[]).includes(entry.status)) continue;
    try {
      stopBot(bot);
      killStaleContainers(bot);
      bootstrapBot(root, bot);
      writeCrewStatus(root, bot);
      injectWbsTasks(root, bot);
      started.push(bot);
    } catch (err) {
      log(`restartRunningBots: ${bot} failed — ${errStr(err)}`);
      failed.push(bot);
    }
  }
  if (started.length > 0 || failed.length > 0) { fleetDirty = true; persistFleet(); }
  return { started, failed };
}

// ── Bot resolution (multi-ship aware) ───────────────────────────

/** Get the duty room name (lowercased) for a bot based on its role in ROLE_ROOMS. */
function botDutyRoom(bot: string): string {
  return ROLE_ROOMS[liveFleet[bot]?.role?.toLowerCase() ?? '']?.room ?? '';
}

/** Map local bot name → room name (lowercased) from role via ROLE_ROOMS. */
function buildBotRoomMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [bot, entry] of Object.entries(liveFleet)) {
    if (entry.ship !== HOSTNAME) continue;
    const room = ROLE_ROOMS[entry.role?.toLowerCase() ?? '']?.room;
    if (room) map[bot] = room;
  }
  return map;
}

function parseTarget(cmd: string, prefix: string): { matched: boolean; target?: string } {
  if (cmd !== prefix && !cmd.startsWith(prefix + ' ')) return { matched: false };
  const target = cmd.slice(prefix.length).trim().toLowerCase() || undefined;
  return { matched: true, target };
}

/** Case-insensitive check: does the input match this ship by name or hostname? */
function isThisShip(input: string): boolean {
  const lower = input.toLowerCase();
  return lower === HOSTNAME.toLowerCase() || lower === thisShipName().toLowerCase();
}

/** Case-insensitive ship name lookup — returns canonical name from ships.json or null. */
function resolveShipName(input: string, ships: Record<string, unknown>): string | null {
  const lower = input.toLowerCase();
  return Object.keys(ships).find(s => s.toLowerCase() === lower) ?? null;
}

/**
 * Resolve which bots a command should affect.
 *
 * scope='ship': all local bots regardless of room. Used from BehindTheCurtain,
 *   which is a universal command room.
 *
 * scope='present' (default): bots physically in the room — on duty here, or in their own
 *   quarters room. Use for lifecycle commands (!sleep, !wake, !dismiss, !go).
 *   With an explicit target that exists on this ship but is NOT in the room, returns [] so
 *   the caller can emit a "not in this room" warning.
 *
 * scope='assigned': bots assigned to this room by role (via ROLE_ROOMS), regardless of current
 *   location. Use for !report, which must reach bots currently in quarters.
 *   With an explicit target, falls back to any local bot on this ship.
 */
function resolveBots(target: string | undefined, conn: RoomConn, scope: 'present' | 'assigned' | 'ship' = 'present'): string[] {
  const roomName = conn.name.toLowerCase();
  const botRooms = buildBotRoomMap();
  const inRoom = Object.entries(liveFleet)
    .filter(([bot, e]) => {
      if (e.ship !== HOSTNAME) return false;
      if (scope === 'ship') return true;
      // Quarters room: bot is always reachable in their own quarters
      if (e.quartersRoom === conn.roomId) return true;
      if (scope === 'assigned') return botRooms[bot] === roomName;
      // present: bot must be on duty in this room
      return e.status === 'onduty' && botRooms[bot] === roomName;
    })
    .map(([bot]) => bot);
  if (target) {
    if (inRoom.includes(target)) return [target];
    // assigned/ship scope: fall back to any local bot
    if ((scope === 'assigned' || scope === 'ship') && liveFleet[target]?.ship === HOSTNAME) return [target];
    return [];
  }
  return inRoom;
}

// ── Health check + S3 ─────────────────────────────────────────

const HEALTH_S3_PREFIX = 'health';

// getS3Client imported from s3-sync.ts as getClient → getS3Client

/** Upload an error log to S3 and return a presigned markdown link (7 days), or empty string on failure. */
async function uploadErrorLog(label: string, error: unknown): Promise<string> {
  const s3 = getS3Client();
  if (!s3) return '';
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `logs/${HOSTNAME}/${label}-${ts}.log`;
    const body = error instanceof Error
      ? `${error.message}\n\n${error.stack ?? ''}\n\n${(error as { stderr?: string }).stderr ?? ''}`
      : String(error);
    await s3.client.send(new PutObjectCommand({
      Bucket: s3.bucket,
      Key: key,
      Body: Buffer.from(body),
      ContentType: 'text/plain',
    }));
    const url = await getSignedUrl(s3.client, new GetObjectCommand({ Bucket: s3.bucket, Key: key }), { expiresIn: 7 * 86_400 });
    return ` ([log](${url}))`;
  } catch { return ''; }
}

// ── Fleet report ──────────────────────────────────────────────

type FleetReport = {
  ship: string;
  ts: number;
  relayVersion: string;
  bots: Record<string, { name: string; badge: string; role: string; rank: number; status: string; gitVersion: string; semver?: string; grade?: string; activity?: string; tokPerDay?: number }>;
};

/** Build and publish this ship's fleet report to S3. Returns the report. */
async function publishFleetReport(): Promise<FleetReport> {
  const root = resolveRoot();
  const execOpts = { encoding: 'utf-8' as const, timeout: 5_000, stdio: 'pipe' as const };

  // Gather local process status
  const localRunning = new Set<string>();
  try {
    for (const line of execSync('podman ps --format "{{.Names}}"', execOpts).trim().split('\n')) {
      const match = line.match(/^nanoclaw-([^-]+)-/);
      if (match) localRunning.add(match[1]);
    }
  } catch { /* empty */ }
  try {
    const pm2 = JSON.parse(execSync('npx pm2 jlist 2>/dev/null', { ...execOpts, cwd: root })) as Array<{ name: string; pm2_env?: { status?: string } }>;
    for (const p of pm2) {
      if (p.pm2_env?.status === 'online') {
        const match = p.name.match(/^infiniclaw-(.+)$/);
        if (match) localRunning.add(match[1]);
      }
    }
  } catch { /* empty */ }

  const relayVer = relayVersion(root);
  const metrics = computeMetrics();
  metrics.shipMetrics.codeVersion = relayVer;
  const botReports: FleetReport['bots'] = {};
  for (const [botId, entry] of Object.entries(liveFleet)) {
    if (entry.ship !== HOSTNAME) continue;
    const env = (() => { try { return loadProfileEnv(root, botId); } catch { return null; } })();
    const name = env?.ASSISTANT_NAME || capitalizeName(botId);
    const running = localRunning.has(botId);
    const botMetrics = metrics.bots.find(b => b.name === botId);
    const grade = botMetrics ? computeBotHealthGrade(botMetrics) : undefined;
    const tokPerDay = botMetrics?.tokenThroughput?.day1 ?? -1;
    botReports[botId] = {
      name,
      badge: '',
      role: entry.role,
      rank: entry.rank,
      status: entry.status,
      gitVersion: botVersion(root, botId),
      semver: botSemver(root, botId) ?? undefined,
      grade,
      activity: activityEmoji(tokPerDay),
      tokPerDay: tokPerDay > 0 ? tokPerDay : 0,
    };
    if ((RUNNING_STATUSES as readonly string[]).includes(entry.status) && !running) {
      botReports[botId].status = 'warn';
    }
  }

  const report: FleetReport = { ship: thisShipName(), ts: Date.now(), relayVersion: relayVer, bots: botReports };

  const s3 = getS3Client();
  if (s3) {
    try {
      await s3.client.send(new PutObjectCommand({
        Bucket: s3.bucket,
        Key: `${FLEET_S3_PREFIX}/${thisShipName()}.json`,
        Body: Buffer.from(JSON.stringify(report)),
        ContentType: 'application/json',
      }));
    } catch (err) { log(`fleet S3 publish failed: ${errStr(err)}`); }
  }

  return report;
}

// Fleet state read/write moved to ship-config.ts (loadFleetAsync/writeFleetAsync)

function runHealthCheck(): string | null {
  const root = resolveRoot();
  try {
    const report = collectHealthData(
      path.join(root, '_runtime', 'logs'),
      path.join(root, '_runtime', 'instances'),
      path.join(root, '_runtime', 'data', 'health-history.jsonl'),
      HOSTNAME,
    );
    return JSON.stringify(report);
  } catch (err) {
    log(`health check failed: ${errStr(err)}`);
    return null;
  }
}

async function uploadHealthToS3(report: string): Promise<boolean> {
  const s3 = getS3Client();
  if (!s3) return false;
  const key = `${HEALTH_S3_PREFIX}/${thisShipName()}.json`;
  try {
    await s3.client.send(new PutObjectCommand({
      Bucket: s3.bucket,
      Key: key,
      Body: Buffer.from(report),
      ContentType: 'application/json',
    }));
    return true;
  } catch (err) {
    log(`S3 health upload failed: ${errStr(err)}`);
    return false;
  }
}

async function fetchAllHealthReports(): Promise<Array<{ ship: string; data: Record<string, unknown> }>> {
  const s3 = getS3Client();
  if (!s3) return [];
  const results: Array<{ ship: string; data: Record<string, unknown> }> = [];
  try {
    const listed = await s3.client.send(new ListObjectsV2Command({
      Bucket: s3.bucket,
      Prefix: `${HEALTH_S3_PREFIX}/`,
    }));
    for (const obj of listed.Contents || []) {
      if (!obj.Key?.endsWith('.json')) continue;
      try {
        const resp = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: obj.Key }));
        const chunks: Uint8Array[] = [];
        for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
        const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const ship = obj.Key.replace(`${HEALTH_S3_PREFIX}/`, '').replace('.json', '');
        results.push({ ship, data });
      } catch { /* skip corrupt reports */ }
    }
  } catch (err) {
    log(`S3 health fetch failed: ${errStr(err)}`);
  }
  return results;
}

// Cross-ship health staleness alerts are handled by healthWatchdogLoop() (fire-once with recovery).

async function fetchAllMetricsSnapshots(): Promise<MetricsSnapshot[]> {
  const s3 = getS3Client();
  if (!s3) return [];
  const results: MetricsSnapshot[] = [];
  try {
    const listed = await s3.client.send(new ListObjectsV2Command({
      Bucket: s3.bucket,
      Prefix: 'metrics/',
    }));
    for (const obj of listed.Contents || []) {
      if (!obj.Key?.endsWith('.json')) continue;
      try {
        const resp = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: obj.Key }));
        const chunks: Uint8Array[] = [];
        for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
        const data = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as MetricsSnapshot;
        if (data.ship && data.ts) results.push(data);
      } catch { /* skip corrupt snapshots */ }
    }
  } catch (err) {
    log(`S3 metrics fetch failed: ${errStr(err)}`);
  }
  return results;
}

/**
 * Unified fleet metrics report using the same visual language as !fleet:
 * ship headers + tree-structured bot lines, with metrics/health data merged inline.
 */
function formatCombinedMetrics(
  snapshots: MetricsSnapshot[],
  healthReports: Array<{ ship: string; data: Record<string, unknown> }> = [],
): string {
  if (snapshots.length === 0) return '';
  const NBSP = '\u00A0';
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const ships = safeLoadShips();

  // Build health lookup: canonical ship name → health data
  const hostnameToName = new Map<string, string>();
  for (const [name, entry] of Object.entries(ships)) {
    if (entry.hostname) hostnameToName.set(entry.hostname, name);
    hostnameToName.set(name, name);
  }
  const healthByShip = new Map<string, Record<string, unknown>>();
  for (const r of healthReports) {
    const canonical = hostnameToName.get(r.ship) ?? r.ship;
    const existing = healthByShip.get(canonical);
    if (!existing || Number(r.data.ts || 0) > Number(existing.ts || 0)) {
      healthByShip.set(canonical, r.data);
    }
  }

  // Sort snapshots by ship rank
  const sorted = [...snapshots].sort((a, b) =>
    (ships[a.ship]?.rank ?? 99) - (ships[b.ship]?.rank ?? 99)
  );

  const lines: string[] = [];
  let totalOom24h = 0;
  let totalRssMb = 0;
  let totalInterventions = { day1: 0, day7: 0 };
  let totalXCmds = { day1: 0, day7: 0 };

  for (const s of sorted) {
    const cfg = ships[s.ship];
    const rank = cfg?.rank ?? 99;
    const commissioned = cfg?.commissioned !== false;
    const isThisShipSpeaker = commissioned && isSpeakerCached && cfg?.rank != null &&
      Object.values(ships).filter(sh => sh.commissioned).every(sh => (sh.rank ?? 99) >= (cfg?.rank ?? 99));

    // Aggregate ship health (worst grade) and throughput (sum) — same as !fleet
    const gradeOrder = ['A', 'B', 'C', 'F'];
    let worstGrade = 'A';
    let shipTok = 0;
    for (const bot of s.bots) {
      const botGrade = computeBotHealthGrade(bot);
      if (gradeOrder.indexOf(botGrade) > gradeOrder.indexOf(worstGrade)) worstGrade = botGrade;
      shipTok += bot.tokenThroughput?.day1 ?? 0;
    }
    const shipHeader = unifiedShipDisplay({
      name: s.ship,
      emoji: cfg?.emoji ?? '',
      typeEmoji: cfg?.typeEmoji ?? '',
      type: cfg?.type ?? '',
      rank,
      isSpeaker: isThisShipSpeaker,
      commissioned,
      health: worstGrade,
      tokPerDay: shipTok,
    }, 'short');

    // Ship-level metrics suffix
    const uptimePct = Math.min(Math.round(s.shipMetrics.relayUptimeSeconds / 864), 100);
    const uptimeTag = `up ${uptimePct}%`;
    const infraRaw = s.shipMetrics.infraFailures as { day1?: number; day7?: number } | number;
    const syncFail = typeof infraRaw === 'number' ? infraRaw : (infraRaw?.day1 ?? 0);
    const syncTag = syncFail > 0 ? `⚠️${syncFail} sync` : '';
    const rstRaw = s.shipMetrics.relayRestarts as { day1?: number; day7?: number } | number;
    const rst = typeof rstRaw === 'number' ? { day1: rstRaw, day7: rstRaw } : { day1: rstRaw?.day1 ?? 0, day7: rstRaw?.day7 ?? 0 };
    const rstTag = rst.day1 > 0 ? `↻${rst.day1}` : '';
    const codeVer = s.shipMetrics.codeVersion || '';
    const metricsParts = [uptimeTag, rstTag, syncTag].filter(Boolean).join(' · ');
    lines.push(`${shipHeader} · ${metricsParts}${codeVer}`);

    // Build bot list: merge metrics snapshot + health + liveFleet role/rank
    const health = healthByShip.get(s.ship);
    const hBots = health ? (health.bots || {}) as Record<string, Record<string, unknown>> : {};
    const rolling24h = health ? (health.rolling as Record<string, unknown> | undefined)?.['24h'] as
      { bots?: Record<string, { sigkills?: number; oom_kills?: number }> } | undefined : undefined;
    const trends = health ? (health.trends_24h || {}) as Record<string, { sigkills?: number; oom_kills?: number }> : {};

    // Sort bots by rank from liveFleet
    const botsWithMeta = s.bots.map(b => ({
      ...b,
      rank: liveFleet[b.name]?.rank ?? 99,
      role: liveFleet[b.name]?.role ?? '',
    })).sort((a, b) => a.rank - b.rank);

    // Max name length for column alignment (matches !fleet)
    const maxNameLen = botsWithMeta.reduce((max, b) => Math.max(max, capitalizeName(b.name).length), 0);

    // Build flat list for CO detection (all bots across all ships)
    const allBotList = sorted.flatMap(ss => ss.bots.map(b => ({
      name: b.name,
      role: liveFleet[b.name]?.role ?? '',
      rank: liveFleet[b.name]?.rank ?? 99,
      status: b.status,
    })));

    for (const [i, bot] of botsWithMeta.entries()) {
      const isLast = i === botsWithMeta.length - 1;
      const role = bot.role?.toLowerCase() ?? '';
      const isSleeping = bot.status === 'sleep' || bot.status === 'dream';
      const botGrade = isSleeping ? '' : computeBotHealthGrade(bot);
      const tree = isLast ? '└ ' : '├ ';
      const botLine = unifiedBotDisplay(buildBotDisplayParams(bot.name, {
        shipEmoji: '',
        status: bot.status,
        health: botGrade || '',
        tokPerDay: bot.tokenThroughput?.day1 ?? 0,
      }), 'short', maxNameLen);

      // Metrics suffix: mem, kills, tok, latency
      const r24 = rolling24h?.bots?.[bot.name];
      const t24 = trends[bot.name];
      const oom24 = r24?.oom_kills ?? t24?.oom_kills ?? 0;
      const sk24 = r24?.sigkills ?? t24?.sigkills ?? 0;
      totalOom24h += oom24;
      const hBot = hBots[bot.name];
      const rss = hBot?.rss_mb != null ? Number(hBot.rss_mb) : 0;
      totalRssMb += rss;
      const rssStr = rss > 0 ? String(rss) : '?';
      const limitStr = hBot?.limit_mb != null ? String(hBot.limit_mb) : '?';
      const mem = `mem ${rssStr}/${limitStr}MB`;
      const kills = (sk24 > 0 || oom24 > 0) ? `SK+${sk24} OOM+${oom24}` : '';
      const tokData = (health?.tokens as Record<string, { total_24h?: number }> | undefined)?.[bot.name];
      const tok24k = tokData?.total_24h != null ? Math.round(tokData.total_24h / 1000) : null;
      const tokFromMetrics = bot.tokenThroughput?.day1 != null && bot.tokenThroughput.day1 > 0
        ? fmtTok(bot.tokenThroughput.day1) : null;
      const tokStr = tok24k != null && tok24k > 0 ? `${tok24k}K` : (tokFromMetrics ?? '?');
      const p50 = bot.responseLatencyP50 != null ? `${bot.responseLatencyP50}s` : '?';
      const p95 = bot.responseLatencyP95 != null ? `${bot.responseLatencyP95}s` : '?';
      const metricsSuffix = [mem, kills, `tok ${tokStr}/d`, `lat ${p50}/${p95}`].filter(Boolean).join(' · ');

      lines.push(`${tree}${botLine} · ${metricsSuffix}`);
    }

    totalInterventions.day1 += s.operator.interventions.day1;
    totalInterventions.day7 += s.operator.interventions.day7;
    totalXCmds.day1 += s.operator.xCommandsIssued.day1;
    totalXCmds.day7 += s.operator.xCommandsIssued.day7;
    lines.push('');
  }

  // Fleet summary footer
  const assigned = sorted.flatMap(s => s.bots.filter(b => b.status !== 'sleep' && b.status !== 'transit'));
  const running = assigned.filter(b => b.processRunning);
  const availability = assigned.length > 0 ? Math.round((running.length / assigned.length) * 100) : 100;
  const avgAutonomy1d = sorted.reduce((sum, s) => sum + s.fleet.autonomyScore.day1, 0) / sorted.length;
  // Collect MTBI from all ships — use minimum (most frequent intervention ship drives the metric)
  const mtbiValues = sorted.map(s => s.operator.mtbi).filter((v): v is number => v != null);
  const mtbiStr = mtbiValues.length > 0 ? ` · MTBI ${Math.min(...mtbiValues)}h (7d)` : '';
  lines.push(
    `**Fleet** · ${sorted.length} ships · avail ${availability}% · autonomy ${r1(avgAutonomy1d)}% (1d) · OOM+${totalOom24h} (24h) · RSS ${totalRssMb}MB`,
    `**Operator** · interventions ${r1(totalInterventions.day1)}/day (1d) · x-cmds ${r1(totalXCmds.day1)}/day (1d)${mtbiStr}`,
  );

  return lines.join('\n');
}

function formatHealthSummary(reports: Array<{ ship: string; data: Record<string, unknown> }>): string {
  if (reports.length === 0) return '⚠️ No health reports available.';

  // Deduplicate: resolve all ship identifiers to canonical names, keep newest per ship
  const ships = safeLoadShips();
  const hostnameToName = new Map<string, string>();
  for (const [name, entry] of Object.entries(ships)) {
    if (entry.hostname) hostnameToName.set(entry.hostname, name);
    hostnameToName.set(name, name);
  }
  const deduped = new Map<string, { shipName: string; data: Record<string, unknown> }>();
  for (const report of reports) {
    const canonical = hostnameToName.get(report.ship) ?? report.ship;
    const existing = deduped.get(canonical);
    const reportTs = Number(report.data.ts || 0);
    const existingTs = Number(existing?.data.ts || 0);
    if (!existing || reportTs > existingTs) {
      deduped.set(canonical, { shipName: canonical, data: report.data });
    }
  }

  const knownBots = new Set(Object.keys(liveFleet));
  const lines: string[] = [`## 4 · Health\n`];
  let total24hOom = 0;

  for (const { shipName, data } of deduped.values()) {
    const cfg = ships[shipName];
    const reportTs = data.ts ? new Date(String(data.ts)) : null;
    const ageMs = reportTs ? Date.now() - reportTs.getTime() : null;
    const age = ageMs != null ? (ageMs < 120_000 ? 'live' : `${Math.round(ageMs / 60_000)}m ago`) : '?';
    const shipDisplay = cfg?.emoji ? `${cfg.emoji} ${shipName}` : shipName;
    lines.push(`**${shipDisplay}** (${age})`);

    const allBots = (data.bots || {}) as Record<string, Record<string, unknown>>;
    const bots = Object.entries(allBots).filter(([n]) => knownBots.has(n));

    const rolling24h = (data.rolling as Record<string, unknown> | undefined)?.['24h'] as
      { bots?: Record<string, { sigkills?: number; oom_kills?: number }> } | undefined;
    const r7d = (data.rolling as Record<string, unknown> | undefined)?.['7d'] as
      { bots?: Record<string, { sigkills?: number; oom_kills?: number }> } | undefined;

    // Sort by rank for consistent ordering
    const sortedBots = bots
      .map(([name, b]) => ({ name, b, rank: liveFleet[name]?.rank ?? 99 }))
      .sort((a, b) => a.rank - b.rank);

    // Compute max name length for alignment within this ship group
    const maxNameLen = sortedBots.reduce((max, { name }) => Math.max(max, capitalizeName(name).length), 0);
    const allBotList = Object.entries(liveFleet).map(([n, e]) => ({ name: n, role: e.role, rank: e.rank, status: e.status }));

    for (const [i, { name, b }] of sortedBots.entries()) {
      const r = rolling24h?.bots?.[name];
      const r7 = r7d?.bots?.[name];
      const oom24 = r?.oom_kills ?? 0;
      const sk24 = r?.sigkills ?? 0;
      total24hOom += oom24;
      if (b.status !== 'ACTIVE' && oom24 === 0 && sk24 === 0) continue;

      const isLast = i === sortedBots.length - 1;
      const tree = isLast ? '└ ' : '├ ';
      const botLine = unifiedBotDisplay(buildBotDisplayParams(name, { shipEmoji: '' }), 'short', maxNameLen);
      const mem = b.rss_mb != null ? `mem ${b.rss_mb}/${b.limit_mb ?? '?'}MB` : '';
      const stats24 = `SK+${sk24} OOM+${oom24} (1d)`;
      const stats7d = r7 ? `SK+${r7.sigkills ?? 0} OOM+${r7.oom_kills ?? 0} (7d)` : '';
      const parts = [mem, stats24, stats7d].filter(Boolean).join(' · ');
      lines.push(`${tree}${botLine} · ${parts}`);
    }
  }

  lines.push(`\n**Totals** · ${deduped.size} ships · OOM+${total24hOom} (24h)`);
  return lines.join('\n');
}

// ── Git hooks ─────────────────────────────────────────────────

/**
 * Sync git hooks from scripts/hooks/ to .git/hooks/.
 *
 * Source files are named `infiniclaw-<hook>` (e.g. `infiniclaw-pre-commit`).
 * They get installed as `<hook>` in .git/hooks/ (e.g. `pre-commit`).
 *
 * Any .git/hooks/ file whose `infiniclaw-` source no longer exists is removed.
 * Files not managed by us (.sample files, hooks without an infiniclaw- source) are left alone.
 */
const HOOK_PREFIX = 'infiniclaw-';

function installGitHooks(): void {
  const root = resolveRoot();
  const srcDir = path.join(root, 'scripts', 'hooks');
  const dstDir = path.join(root, '.git', 'hooks');
  if (!fs.existsSync(srcDir)) return;

  // Install hooks from scripts/hooks/infiniclaw-*
  const managed = new Set<string>();
  for (const file of fs.readdirSync(srcDir)) {
    if (!file.startsWith(HOOK_PREFIX)) continue;
    const hookName = file.slice(HOOK_PREFIX.length);
    if (!hookName) continue;
    managed.add(hookName);

    const src = path.join(srcDir, file);
    const dst = path.join(dstDir, hookName);
    const srcContent = fs.readFileSync(src);
    let needsUpdate = true;
    try {
      const dstContent = fs.readFileSync(dst);
      if (srcContent.equals(dstContent)) needsUpdate = false;
    } catch { /* doesn't exist yet */ }
    if (needsUpdate) {
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o755);
      log(`git hooks: installed ${hookName}`);
    }
  }

  // Remove hooks we previously managed that no longer have a source
  for (const file of fs.readdirSync(dstDir)) {
    if (file.endsWith('.sample')) continue;
    if (managed.has(file)) continue;
    // Only remove if an infiniclaw- source COULD have existed (valid git hook names)
    // Check if this hook was ours by looking for our shebang + comment pattern
    const dst = path.join(dstDir, file);
    try {
      const content = fs.readFileSync(dst, 'utf-8');
      // Only remove hooks that contain our marker — never touch hooks from other tools
      if (!content.includes('# infiniclaw-managed')) continue;
      fs.unlinkSync(dst);
      log(`git hooks: removed stale ${file}`);
    } catch { /* skip */ }
  }
}

// ── Git sync ──────────────────────────────────────────────────

/** Returns true if any source files changed in the last N commits. */
function hasSourceChanges(root: string, commitCount: number): boolean {
  try {
    const execOpts = gitOpts(root, 10_000);
    const changed = execSync(`git diff HEAD~${commitCount}..HEAD --name-only`, execOpts).trim();
    if (!changed) return false;
    return changed.split('\n').some(f =>
      f.endsWith('.ts') || f === 'package.json' || f === 'package-lock.json' ||
      f.startsWith('Dockerfile') || f.endsWith('tsconfig.json') || f.endsWith('tsconfig.build.json')
    );
  } catch {
    return true; // assume source changed on error
  }
}

/** Files that, when changed, require a relay restart. Bot-only changes (main.ts, container-spawn.ts, etc.) don't affect the relay process. */
const RELAY_FILES = [
  'src/relay.ts', 'src/matrix-api.ts', 'src/metrics.ts', 'src/ipc-watcher.ts',
  'src/ship-config.ts', 'src/intercom-relay.ts', 'src/infini-config.ts',
  'src/formatting.ts', 'src/version.ts', 'src/git-utils.ts', 'src/utils.ts',
  'package.json', 'package-lock.json',
];

function hasRelayChanges(root: string, commitCount: number): boolean {
  try {
    const execOpts = gitOpts(root, 10_000);
    const changed = execSync(`git diff HEAD~${commitCount}..HEAD --name-only`, execOpts).trim();
    if (!changed) return false;
    return changed.split('\n').some(f => RELAY_FILES.includes(f));
  } catch {
    return true; // assume relay changed on error
  }
}

/** Compute a fast hash of a directory's file contents for change detection. Cross-platform. */
function hashDir(dir: string): string {
  try {
    const files = execSync('find . -type f', gitOpts(dir, 10_000))
      .trim().split('\n').filter(Boolean).sort();
    const hash = crypto.createHash('sha256');
    for (const file of files) {
      hash.update(file);
      hash.update(fs.readFileSync(path.join(dir, file)));
    }
    return hash.digest('hex');
  } catch {
    return ''; // empty = assume changed
  }
}

function gitSync(force = false): { ok: boolean; output: string; newCommits: number } {
  const root = resolveRoot();
  const opts = gitOpts(root, 30_000);
  try {
    // Fetch + push local commits ahead of origin before pulling.
    // Ensure we're on main first — container may have left a feature branch checked out (#101).
    execSync('git fetch origin --tags --force', opts);
    try {
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { ...opts, timeout: 5_000 }).trim();
      if (currentBranch !== 'main') {
        log(`git sync: on branch '${currentBranch}', switching to main`);
        execSync('git checkout main', { ...opts, timeout: 10_000 });
      }
    } catch (branchErr) {
      log(`git sync: branch check/switch failed: ${errStr(branchErr)}`);
    }
    const aheadCount = parseInt(
      execSync('git rev-list origin/main..HEAD --count', { ...opts, timeout: 5_000 }).trim(), 10,
    ) || 0;
    if (aheadCount > 0) {
      try {
        execSync('git push origin main', { ...opts, timeout: GIT_SYNC_PUSH_TIMEOUT_MS });
        log(`git sync: pushed ${aheadCount} local commit(s)`);
      } catch (pushErr) {
        log(`git sync: push failed: ${errStr(pushErr)}`);
      }
    }
    // Determine target: latest semver tag on origin/main (default) or origin/main HEAD (force).
    // Only tagged commits deploy automatically — untagged commits on main are ignored (#112).
    let targetRef = 'origin/main';
    if (!force) {
      const latestTag = getLatestSemverTagOnRef(root, 'origin/main');
      if (latestTag) {
        targetRef = latestTag;
        const ahead = commitsAheadOfTag(root, 'origin/main');
        if (ahead > 0) {
          log(`git sync: ${ahead} untagged commit(s) on main ahead of ${latestTag} — waiting for tag`);
        }
      }
    }
    // Pull to target ref (gitSyncRepo re-fetches internally — harmless)
    const { pulled, changed, output } = gitSyncRepo(root, targetRef);
    if (changed) {
      try {
        log('git sync: package-lock.json changed, running npm install');
        execSync('npm install', { ...opts, timeout: 300_000 });
      } catch (err) {
        log(`git sync: npm install failed: ${errStr(err)}`);
      }
    }
    return { ok: true, output, newCommits: pulled };
  } catch (err) {
    return { ok: false, output: errStr(err), newCommits: -1 };
  }
}

/** Periodic git sync loop — pull --rebase, notify engineer on failure. */
async function gitSyncLoop(conns: RoomConn[]): Promise<void> {
  await sleep(30_000); // initial delay
  let lastBuildFailed = false;
  while (true) {
    try {
      const result = gitSync();
      if (!result.ok) {
        log(`git sync FAILED: ${result.output}`);
        await reportFailure('code sync', result.output, conns);
      } else if (result.newCommits > 0 || lastBuildFailed) {
        await reportRecovery('code sync', conns);
        if (result.newCommits > 0) log(`git sync: pulled ${result.newCommits} new commit(s)`);
        else log('git sync: retrying failed build');
        if (result.newCommits > 0 && !hasSourceChanges(resolveRoot(), result.newCommits) && !lastBuildFailed) {
          log('git sync: doc-only changes, skipping rebuild and restart');
        } else {
          const buildResult = rebuildInfiniClaw();
          log(`git sync: ${buildResult}`);
          if (buildResult.includes('FAILED')) {
            lastBuildFailed = true;
            await reportFailure('code build', buildResult, conns);
          } else {
            lastBuildFailed = false;
            await reportRecovery('code build', conns);
            const root = resolveRoot();

            // Snapshot per-bot dist hashes BEFORE syncing new code
            const preHashes: Record<string, string> = {};
            for (const bot of getActiveBots()) {
              if (liveFleet[bot]?.ship !== HOSTNAME) continue;
              const instDist = path.join(root, '_runtime', 'instances', bot, 'dist');
              preHashes[bot] = hashDir(instDist);
            }

            // Sync dist/ to ALL local bot instances (including sleeping)
            for (const bot of Object.keys(liveFleet)) {
              if (liveFleet[bot]?.ship !== HOSTNAME) continue;
              try { syncDistToInstance(root, bot); } catch { /* skip bots with no instance dir */ }
            }
            log('git sync: dist synced to all local instances');

            // Only restart bots whose dist/ actually changed
            const engConn = findEngConn(conns);
            let restarted = 0;
            let threadRoot: string | undefined;
            // Reload fleet from disk so status checks reflect transitions that happened
            // while git sync was running (e.g. a bot going to sleep mid-cycle, #85).
            try { liveFleet = loadFleet(); } catch { /* best effort — fall back to cached */ }
            for (const bot of getActiveBots()) {
              if (!(RUNNING_STATUSES as readonly string[]).includes(liveFleet[bot]?.status)) continue;
              // Do NOT restart bots on duty — code changes apply during Dream phase after retrospective.
              if (liveFleet[bot]?.status === 'onduty') {
                log(`git sync: ${bot} is onduty — deferring restart to Dream phase`);
                continue;
              }
              const instDist = path.join(root, '_runtime', 'instances', bot, 'dist');
              const postHash = hashDir(instDist);
              if (preHashes[bot] && preHashes[bot] === postHash) {
                log(`git sync: ${bot} dist unchanged, skipping restart`);
                continue;
              }
              const botSyncEnv = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
              const botName = botSyncEnv?.ASSISTANT_NAME || capitalizeName(bot);
              if (!threadRoot && engConn) {
                threadRoot = await reply(engConn, `📡 git sync: ${result.newCommits} new commit(s) — restarting changed bots`);
              }
              try {
                bootstrapBot(resolveRoot(), bot);
                writeCrewStatus(resolveRoot(), bot);
                injectWbsTasks(resolveRoot(), bot);
                restarted++;
                log(`git sync: restarted ${bot}`);
                if (engConn && threadRoot) await threadReply(engConn, threadRoot, `✅ ${botName} restarted${botVersion(resolveRoot(), bot)}`);
              } catch (err) {
                log(`git sync: failed to restart ${bot}: ${errStr(err)}`);
                if (engConn && threadRoot) await threadReply(engConn, threadRoot, `⛔ ${botName} restart failed: ${errStr(err).slice(0, 100)}`);
              }
            }
            // Deploy dist to sleeping and dreaming bots so they have current code when they wake
            for (const bot of getActiveBots()) {
              if (liveFleet[bot]?.status !== 'sleep' && liveFleet[bot]?.status !== 'dream') continue;
              try {
                deployBot(resolveRoot(), bot);
                log(`git sync: deployed ${bot} (sleeping)`);
                const botDeployEnv = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
                if (engConn && threadRoot) await threadReply(engConn, threadRoot, `✅ ${botDeployEnv?.ASSISTANT_NAME || capitalizeName(bot)} deployed (sleeping)`);
              } catch (err) {
                log(`git sync: failed to deploy ${bot}: ${errStr(err)}`);
              }
            }
            // Post completion summary (only if something changed)
            if (restarted > 0) {
              if (engConn) await reply(engConn, `📡 git sync: ${restarted} bot(s) restarted`);
            } else {
              log('git sync: no bots needed restart (dist unchanged)');
            }
            // Only restart relay if relay-specific files changed (not bot-only code)
            if (hasRelayChanges(resolveRoot(), result.newCommits)) {
              try {
                log('git sync: relay-specific files changed — restarting relay');
                if (engConn && threadRoot) await threadReply(engConn, threadRoot, `📡 relay code changed — restarting (bots preserved)...`);
                // Persist fleet state synchronously before relay restart — prevents
                // status loss when new relay process loads fleet.json from disk.
                await persistFleetSync();
                execSync(`npx pm2 restart ${process.env['INFINICLAW_PM2_NAME'] || 'infiniclaw-relay'}`, gitOpts(resolveRoot(), 10_000));
              } catch (err) {
                log(`git sync: relay self-restart failed: ${errStr(err)}`);
              }
            } else {
              log('git sync: no relay-specific changes, skipping relay restart');
            }
          }
        }
      } else {
        await reportRecovery('code sync', conns);
        log('git sync: up to date');
      }
    } catch (err) {
      log(`git sync loop error: ${errStr(err)}`);
    }
    await sleep(GIT_SYNC_INTERVAL);
  }
}

// ── Host-side relay task queue ──────────────────────────────────────────

const RELAY_TASKS_POLL_INTERVAL = 2_000;

// ── Branch Brain task registry ──────────────────────────────────────────

const BRANCH_BRAIN_RESTART_DELAY = 30_000; // wait 30s after last TB exit before restarting bot
const MAX_BRANCH_BRAINS_PER_BOT = envInt('MAX_BRANCH_BRAINS_PER_BOT', 3);
const branchBrainRestartTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeBranchBrainCount = new Map<string, number>(); // bot → active TB count

// Active branch brain processes indexed by replyThreadId — used for context injection fan-out
const activeBranchBrainProcs = new Map<string, { title: string; stdin: ReturnType<typeof spawn>['stdin'] }>();

interface BranchTaskEntry {
  objective: string;
  chat_jid: string;
  bot?: string;
  createdAt: number;
  sessionId?: string;   // BB session ID stored for context recovery on relay restart
  completed?: boolean;  // true when BB has finished; kept for TTL-based thread reactivation
}

function branchTasksPath(): string {
  return path.join(resolveRoot(), '_runtime', 'data', 'branch-tasks.json');
}

const THREAD_TASK_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function readBranchTasks(): Record<string, BranchTaskEntry> {
  try {
    const p = branchTasksPath();
    if (!fs.existsSync(p)) return {};
    const tasks = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, BranchTaskEntry>;
    // Auto-prune entries older than TTL
    const now = Date.now();
    const stale = Object.keys(tasks).filter(k => !tasks[k].createdAt || now - tasks[k].createdAt > THREAD_TASK_TTL_MS);
    if (stale.length > 0) {
      stale.forEach(k => { delete tasks[k]; });
      try { fs.writeFileSync(p, JSON.stringify(tasks, null, 2)); } catch { /* best-effort */ }
      log(`branchTasks: pruned ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'}`);
    }
    return tasks;
  } catch { return {}; }
}

function writeBranchTask(threadId: string, entry: BranchTaskEntry): void {
  try {
    const p = branchTasksPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tasks = readBranchTasks();
    tasks[threadId] = entry;
    fs.writeFileSync(p, JSON.stringify(tasks, null, 2));
  } catch (err) { log(`branchTasks: write failed: ${errStr(err)}`); }
}

function removeBranchTask(threadId: string): void {
  try {
    const p = branchTasksPath();
    if (!fs.existsSync(p)) return;
    const tasks = readBranchTasks();
    delete tasks[threadId];
    fs.writeFileSync(p, JSON.stringify(tasks, null, 2));
  } catch (err) { log(`branchTasks: remove failed: ${errStr(err)}`); }
}

/** Mark a branch task as completed (kept for TTL-based thread reactivation). */
function completeBranchTask(threadId: string): void {
  try {
    const p = branchTasksPath();
    if (!fs.existsSync(p)) return;
    const tasks = readBranchTasks();
    if (tasks[threadId]) {
      tasks[threadId].completed = true;
      fs.writeFileSync(p, JSON.stringify(tasks, null, 2));
    }
  } catch (err) { log(`branchTasks: complete failed: ${errStr(err)}`); }
}

/**
 * Format the context injection message that is fanned out to active branch brains.
 * Returns a newline-terminated stream-json user_message for stdin injection.
 * Pure function — exported for testability.
 */
export function formatContextInjectionMessage(title: string, msg: string): string {
  const text = `You are branch brain ${title}. Here is a message from main timeline: ${msg}. It may not apply to you. If it does, modify your task accordingly.`;
  return JSON.stringify({ type: 'user_message', content: text }) + '\n';
}

/**
 * Build the reactivation objective for a thread-reactivated Branch Brain.
 * Pure function — exported for testability.
 */
export function buildReactivationObjective(original: string, followUp: string, title: string): string {
  return [
    `Original objective: ${original}`,
    '',
    `Follow-up from Captain in thread "${title}":`,
    followUp,
  ].join('\n');
}

/** Write a context injection message to all active branch brain stdin pipes. */
function fanOutToBranchBrains(msg: string): void {
  if (activeBranchBrainProcs.size === 0) return;
  for (const [threadId, proc] of activeBranchBrainProcs.entries()) {
    try {
      const injected = formatContextInjectionMessage(proc.title, msg);
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write(injected);
        log(`branchBrain: context injected into thread=${threadId.slice(0, 20)}`);
      }
    } catch (err) {
      log(`branchBrain: context injection failed for thread=${threadId.slice(0, 20)}: ${errStr(err)}`);
    }
  }
}

/**
 * Map bot profile env vars to the child process env for a Branch Brain.
 * Pure function — extracted for testability.
 * @param botEnv  - parsed bot env file (null if bot not specified or env unreadable)
 * @param baseEnv - starting env (defaults to process.env); mutated and returned
 */
export function mapBrainEnv(
  botEnv: Record<string, string> | null,
  baseEnv: Record<string, string> = { ...process.env as Record<string, string> },
): Record<string, string> {
  if (botEnv) {
    const oauthToken = botEnv['CLAUDE_CODE_OAUTH_TOKEN'] || botEnv['BRAIN_OAUTH_TOKEN'];
    const apiKey = botEnv['ANTHROPIC_API_KEY'] || botEnv['BRAIN_API_KEY'];
    const model = botEnv['ANTHROPIC_MODEL'] || botEnv['BRAIN_MODEL'];
    if (oauthToken) baseEnv['CLAUDE_CODE_OAUTH_TOKEN'] = oauthToken;
    if (apiKey) baseEnv['ANTHROPIC_API_KEY'] = apiKey;
    if (model) baseEnv['ANTHROPIC_MODEL'] = model;
    if (botEnv['ANTHROPIC_BASE_URL']) baseEnv['ANTHROPIC_BASE_URL'] = botEnv['ANTHROPIC_BASE_URL'];
    if (botEnv['ANTHROPIC_AUTH_TOKEN']) baseEnv['ANTHROPIC_AUTH_TOKEN'] = botEnv['ANTHROPIC_AUTH_TOKEN'];
    if (botEnv['NODE_EXTRA_CA_CERTS']) baseEnv['NODE_EXTRA_CA_CERTS'] = botEnv['NODE_EXTRA_CA_CERTS'];
  }
  delete baseEnv['CLAUDECODE'];
  return baseEnv;
}

/**
 * Find the most recent Claude session ID for a bot by scanning its session JSONL files.
 * Returns the UUID session ID or null if none found.
 */
/**
 * Read the bot's current session ID from the file written by main.ts after each turn (#81).
 * Returns null if the file doesn't exist or can't be read.
 */
/** UUID v4 pattern — session IDs written by main.ts are always UUIDs. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the bot's current session ID from the file written by main.ts after each turn (#81).
 * Returns null if the file doesn't exist, can't be read, or contains an unexpected value.
 */
function readBotSessionId(bot: string): string | null {
  const sessionFile = path.join(resolveRoot(), '_runtime', 'instances', bot, 'data', 'current-session-id');
  try {
    const id = fs.readFileSync(sessionFile, 'utf-8').trim();
    return SESSION_ID_RE.test(id) ? id : null;
  } catch { return null; }
}

/**
 * Spawn a Branch Brain as a host-side claude process.
 * Branch Brain forks the main brain's session (--resume <sessionId> --fork-session) to inherit
 * full conversation context. The session ID is written to current-session-id by main.ts after
 * each turn (#81). Falls back to cold-start if no session file exists yet.
 * Streams assistant output into a visible Matrix thread in the triggering room.
 */
async function spawnBranchBrain(
  task: { thread_id: string; objective: string; chat_jid: string; bot?: string },
  conns: RoomConn[],
): Promise<void> {
  const { thread_id, objective, chat_jid, bot: rawBot } = task;
  // Normalize bot name to lowercase — ASSISTANT_NAME is capitalized but env dirs and fleet keys are lowercase.
  const bot = rawBot?.toLowerCase();
  log(`branchBrain: spawning for thread=${thread_id.slice(0, 20)}`);

  // Guard: reject branch requests from unknown bots. Presence is proven by
  // the IPC call itself — do not gate on duty status (#171 original concern
  // was rooms with no active bot, but bot making the call IS proof of presence).
  if (bot && !liveFleet[bot]) {
    log(`branchBrain: skipped — ${bot} is not in fleet`);
    return;
  }

  // Find the connection for this room (strip matrix: prefix if present)
  const roomId = chat_jid.replace(/^matrix:/, '');
  const conn = conns.find(c => c.roomId === roomId) || findEngConn(conns);
  if (!conn?.accessToken) {
    log(`branchBrain: no active connection for chat_jid=${chat_jid}`);
    return;
  }

  // Announce Branch Brain dispatch on main timeline before spawning.
  // Capture the returned event ID so Branch Brain replies thread under this
  // announcement (not under the triggering message).
  // Send as the bot's own Matrix account so it looks like the bot is threading out work.
  const announcedTitle = objective.split('\n')[0].trim();
  let announcementEventId: string | undefined;
  let botSendToken: string | undefined;
  let botSendHomeserver: string | undefined;
  if (bot) {
    try {
      const { token, homeserver } = await botMatrixLogin(resolveRoot(), bot);
      botSendToken = token;
      botSendHomeserver = homeserver;
    } catch (err) {
      log(`branchBrain: bot login failed, falling back to loudspeaker: ${errStr(err)}`);
    }
  }
  try {
    if (botSendToken && botSendHomeserver) {
      announcementEventId = await relaySend(botSendHomeserver, botSendToken, conn.roomId, `🌿 ${announcedTitle}`);
    } else {
      announcementEventId = await reply(conn, `🌿 ${announcedTitle}`, undefined, { skipMirror: true });
    }
  } catch (err) {
    log(`branchBrain: announce failed: ${errStr(err)}`);
  }
  // Use the announcement event as the thread root; fall back to the triggering thread_id.
  const replyThreadId = announcementEventId ?? thread_id;

  // Helper: send thread replies as the bot when possible, fall back to loudspeaker.
  const bbThreadReply = (text: string): Promise<string | undefined> => {
    if (botSendToken && botSendHomeserver) {
      return relaySend(botSendHomeserver, botSendToken, conn.roomId, text, replyThreadId);
    }
    return threadReply(conn, replyThreadId, text);
  };

  // Try to fork from the bot's active session so BB inherits main brain context.
  // Session ID is written by main.ts after each turn to current-session-id (#81).
  const mainSessionId = bot ? readBotSessionId(bot) : null;
  if (mainSessionId) {
    log(`branchBrain: forking from main session=${mainSessionId.slice(0, 8)}...`);
  }

  // Generate a session ID for this BB instance (stored for context recovery on relay restart).
  const sessionId = crypto.randomUUID();

  // Register task in branch-tasks.json for !todo deep-link annotation and thread reactivation
  writeBranchTask(replyThreadId, { objective, chat_jid, bot, createdAt: Date.now(), sessionId });

  // Load bot credentials so claude can authenticate on the host.
  // Raw env file uses BRAIN_* names; map to CLAUDE_CODE_* / ANTHROPIC_* as needed.
  const botEnv = bot ? (() => { try { return loadProfileEnv(resolveRoot(), bot); } catch (err) { log(`branchBrain: loadProfileEnv failed for ${bot}: ${errStr(err)}`); return null; } })() : null;
  const childEnv = mapBrainEnv(botEnv);
  // Ensure HOME is always the current process HOME so the branch brain writes session-env to the
  // correct location. Old sessions may reference /home/claude (container era) but host branches
  // must use the host HOME so the .claude dir is writable.
  childEnv['HOME'] = process.env['HOME'] ?? os.homedir();
  log(`branchBrain: credentials for ${bot}: oauth=${!!childEnv['CLAUDE_CODE_OAUTH_TOKEN']} apiKey=${!!childEnv['ANTHROPIC_API_KEY']} model=${childEnv['ANTHROPIC_MODEL'] ?? 'none'}`);
  // Use fleet GitHub bot for PR reviews so comments appear as the bot, not the Captain.
  // Fall back to host GH_TOKEN if no bot token configured (#100).
  const ghBotToken = loadGitHubBotToken() || process.env['GH_TOKEN'];
  if (ghBotToken) childEnv['GH_TOKEN'] = ghBotToken;

  // Notes file: Branch Brain can persist key findings here; relay injects as context on bot restart.
  const notesFile = path.join(resolveRoot(), '_runtime', 'data', 'thread-notes', `${replyThreadId.slice(0, 12)}.md`);
  // In container mode the notes dir is bind-mounted at /relay-notes; adjust the path accordingly.
  const notesFilePromptPath = BRANCH_BRAIN_IMAGE
    ? `/relay-notes/${path.basename(notesFile)}`
    : notesFile;

  const fullPrompt = [
    'You are a focused research and implementation agent. Work through the objective below, use available tools, and output your findings as plain text.',
    '',
    'Operating constraints:',
    '- Your text output is streamed live to the Captain in a Matrix thread. Output progress updates every few tool calls so the Captain can follow along — don\'t stay silent for minutes.',
    '- Output channel is stdout only. Matrix/messaging tools (send_message, set_thread, branch_to_thread) are not available in this context.',
    '- Work sequentially with no sub-agents. The branch_to_thread tool is unavailable here.',
    '- Skip any preamble — go straight to the work.',
    '',
    `If you need to persist notes between sessions, write them to: ${notesFilePromptPath}`,
    '',
    'Objective:',
    objective,
  ].join('\n');

  // Spawn branch brain: prefer isolated podman container; fall back to host claude if image unset.
  const useContainer = !!BRANCH_BRAIN_IMAGE;
  let child: ReturnType<typeof spawn>;
  if (useContainer) {
    const notesDir = path.dirname(notesFile);
    fs.mkdirSync(notesDir, { recursive: true });
    fs.chmodSync(notesDir, 0o777);
    // Only pass specific env vars to container — host env vars like HOME break claude CLI.
    const containerEnv: Record<string, string> = {};
    const envKeys = [
      'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'GH_TOKEN',
    ];
    for (const k of envKeys) {
      if (childEnv[k]) containerEnv[k] = childEnv[k];
    }
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(containerEnv)) {
      envArgs.push('--env', `${k}=${v}`);
    }
    log(`branchBrain: container env keys: ${Object.keys(containerEnv).join(', ')}`);
    // Mount corporate CA cert if present on host so SSL works through proxy.
    // Mount InfiniClaw repo read-write so BB can edit source and docs.
    // Mount bot's session data so --continue --fork-session inherits context.
    const infraRoot = resolveRoot();
    const volumeArgs: string[] = [
      `${notesDir}:/relay-notes:rw`,
      `${infraRoot}:/workspace/extra/InfiniClaw:rw`,
    ];
    // Removed: .claude session dir mount was causing UID mismatch (host UID 1000 vs container UID 1001)
    // which made /home/claude/.claude unwritable, breaking all Bash tool calls in BB containers.
    // Copy host's ~/.claude.json to a world-readable location for BB containers.
    // Claude Code needs the oauthAccount data to authenticate. The host file is mode 600
    // (owner-only), but the container runs as user `claude` (UID 1001) which can't read it.
    const claudeJsonDir = path.join(infraRoot, '_runtime', 'data', 'bb-config');
    const claudeJsonPath = path.join(claudeJsonDir, '.claude.json');
    const hostClaudeJson = path.join(os.homedir(), '.claude.json');
    fs.mkdirSync(claudeJsonDir, { recursive: true });
    if (fs.existsSync(hostClaudeJson)) {
      fs.copyFileSync(hostClaudeJson, claudeJsonPath);
    } else if (!fs.existsSync(claudeJsonPath)) {
      fs.writeFileSync(claudeJsonPath, JSON.stringify({ firstStartTime: new Date().toISOString() }));
    }
    fs.chmodSync(claudeJsonPath, 0o644);
    volumeArgs.push(`${claudeJsonPath}:/home/claude/.claude.json:ro`);
    const hostCaCert = process.env['NODE_EXTRA_CA_CERTS'];
    if (hostCaCert && fs.existsSync(hostCaCert)) {
      const containerCaPath = '/etc/ssl/certs/corporate-ca.pem';
      volumeArgs.push(`${hostCaCert}:${containerCaPath}:ro`);
      envArgs.push('--env', `NODE_EXTRA_CA_CERTS=${containerCaPath}`);
    }
    // Build claude args: fresh session in container (fork-session loads the entire
    // conversation transcript into V8 memory before producing output — for long-running
    // bots this exceeds the 10min BB timeout and wastes gigabytes of RAM).
    // Use --input-format stream-json so stdin stays open for context injection.
    const claudeArgs: string[] = [
      '--verbose',
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
    ];
    child = spawn('podman', [
      'run', '--rm', '-i',
      '--network', 'host',
      '--memory', '4g',
      '--pids-limit', '256',
      ...volumeArgs.map(v => ['--volume', v]).flat(),
      ...envArgs,
      BRANCH_BRAIN_IMAGE,
      ...claudeArgs,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    log(`branchBrain: spawning in container image=${BRANCH_BRAIN_IMAGE} fork=${!!mainSessionId} session=${sessionId}`);
  } else {
    // Host path: fork from main brain session if available, else cold-start.
    // Use --input-format stream-json so stdin stays open for context injection.
    const claudeArgs: string[] = [
      '--verbose',
      '--dangerously-skip-permissions',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--add-dir', resolveRoot(),
    ];
    if (mainSessionId) {
      claudeArgs.push('--resume', mainSessionId, '--fork-session');
    }
    log(`branchBrain: host spawn fork=${!!mainSessionId} session=${sessionId}`);
    child = spawn('claude', claudeArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
  }

  // Write the prompt to stdin as a stream-json user message. stdin stays open
  // so context injection (main timeline fan-out) can send follow-up messages.
  setTimeout(() => {
    const promptMsg = JSON.stringify({ type: 'user_message', content: fullPrompt });
    child.stdin?.write(promptMsg + '\n');
    log(`branchBrain: prompt written to stdin (kept open for context injection)`);
  }, 3000);

  // Register this process — stdin stays open for context injection via fanOutToBranchBrains.
  activeBranchBrainProcs.set(replyThreadId, { title: announcedTitle, stdin: child.stdin });

  // Time-limited: after BRANCH_BRAIN_TIMEOUT_MS, send interrupt then SIGKILL
  const timeoutTimer = setTimeout(() => {
    log(`branchBrain: timeout (${BRANCH_BRAIN_TIMEOUT_MS}ms) thread=${replyThreadId.slice(0, 20)}`);
    const interruptMsg = JSON.stringify({ type: 'user_message', content: 'Your allotted time has expired. Please finalize your work immediately and output a summary of what you accomplished.' });
    try {
      child.stdin?.write(interruptMsg + '\n');
      child.stdin?.end();
    } catch { /* stdin may already be closed */ }
    bbThreadReply('⏱️ Branch Brain time limit reached — finalizing…').catch(() => {});
    const killTimer = setTimeout(() => {
      log(`branchBrain: finalize timeout — sending SIGKILL thread=${replyThreadId.slice(0, 20)}`);
      child.kill('SIGKILL');
    }, BRANCH_BRAIN_FINALIZE_MS);
    killTimer.unref();
  }, BRANCH_BRAIN_TIMEOUT_MS);
  timeoutTimer.unref();

  let stdoutBuf = '';
  let postedCount = 0;
  let lastPostedText = ''; // Track last posted content for merge injection
  let capturedSessionId: string = sessionId; // start with our generated UUID; update if BB emits its own
  let lastToolPostMs = 0; // Throttle tool-use activity posts to one per 30s

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    while (true) {
      const idx = stdoutBuf.indexOf('\n');
      if (idx === -1) break;
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          result?: string;
          session_id?: string;
          message?: { content?: Array<{ type: string; text?: string; name?: string }> };
        };
        // Capture session ID emitted by the BB process for resumable context recovery
        if (event.session_id && event.session_id !== capturedSessionId) {
          capturedSessionId = event.session_id;
          try {
            const tasks = readBranchTasks();
            if (tasks[replyThreadId]) {
              tasks[replyThreadId].sessionId = capturedSessionId;
              fs.writeFileSync(branchTasksPath(), JSON.stringify(tasks, null, 2));
            }
          } catch { /* best-effort */ }
          log(`branchBrain: captured session_id=${capturedSessionId}`);
        }
        // Stream assistant text blocks into the thread as they arrive (design: 08-threading.md).
        // Post each assistant content block individually so the Captain can follow progress.
        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text?.trim()) {
              postedCount++;
              lastPostedText = block.text.trim();
              bbThreadReply(lastPostedText).catch((err) => log(`branchBrain: stream post failed: ${errStr(err)}`));
            }
            // Post tool-use activity so Captain can see the BB is working (throttled to one per 30s).
            if (block.type === 'tool_use' && block.name) {
              const now = Date.now();
              if (now - lastToolPostMs >= 30_000) {
                lastToolPostMs = now;
                bbThreadReply(`🔧 ${block.name}`).catch(() => {});
              }
            }
          }
        }
        // Post final result only if nothing was streamed (fallback for non-streaming output).
        if (event.type === 'result' && typeof event.result === 'string' && event.result.trim() && postedCount === 0) {
          postedCount++;
          lastPostedText = event.result.trim();
          bbThreadReply(event.result.trim()).catch((err) => log(`branchBrain: result post failed: ${errStr(err)}`));
        }
      } catch { /* not JSON, skip */ }
    }
  });

  let stderrBuf = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });

  child.on('error', (err) => {
    clearTimeout(timeoutTimer);
    activeBranchBrainProcs.delete(replyThreadId);
    log(`branchBrain: spawn error: ${errStr(err)}`);
    completeBranchTask(replyThreadId);
    if (bot) recordBranchBrainResult(bot, false);
    bbThreadReply(`⚠️ Branch Brain failed to start: ${err.message}`).catch(() => {});
  });

  child.on('close', (code) => {
    clearTimeout(timeoutTimer);
    activeBranchBrainProcs.delete(replyThreadId);
    if (stderrBuf.trim()) log(`branchBrain: stderr: ${stderrBuf.trim().slice(0, 400)}`);
    log(`branchBrain: done exit=${code} posted=${postedCount}`);
    completeBranchTask(replyThreadId);
    if (bot) recordBranchBrainResult(bot, postedCount > 0);
    if (postedCount === 0) {
      // Surface stderr errors so the Captain can see why the BB failed (auth, container, etc.).
      const errDetail = stderrBuf.trim() ? `\n\n\`\`\`\n${stderrBuf.trim().slice(0, 500)}\n\`\`\`` : '';
      bbThreadReply(`Branch Brain completed with no output (exit ${code ?? 'null'})${errDetail}`).catch((err) => log(`branchBrain: post failed: ${errStr(err)}`));
    }

    // Post merge marker in thread — 🪾 keyword + full result description.
    // This closes the thread; any future posts receive a "thread is closed" reply.
    const mergeDescription = lastPostedText ? lastPostedText.slice(0, 2000) : '(no output)';
    bbThreadReply(`🪾 ${announcedTitle} — ${mergeDescription}`).catch((err) => log(`branchBrain: merge marker failed: ${errStr(err)}`));

    // Inject merge content into the main brain via IPC so it processes the BB findings.
    // The main brain sees this as a high-priority message on its next turn.
    if (bot && lastPostedText) {
      try {
        const fleet = loadFleet();
        const botEntry = fleet[bot];
        const role = botEntry?.role?.toLowerCase() ?? '';
        const roleRoom = ROLE_ROOMS[role];
        // Determine the IPC folder for the bot's active room
        const roomFolder = roleRoom?.room ?? 'main';
        const ipcInputDir = path.join(resolveRoot(), '_runtime', 'instances', bot, 'data', 'ipc', roomFolder, 'input');
        fs.mkdirSync(ipcInputDir, { recursive: true });
        const mergeMsg = `🔀 Branch Brain "${announcedTitle}" completed. Last output:\n\n${lastPostedText.slice(0, 4000)}`;
        const filename = `message-${Date.now()}.json`;
        const filepath = path.join(ipcInputDir, filename);
        const tempPath = `${filepath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text: mergeMsg }));
        fs.renameSync(tempPath, filepath);
        log(`branchBrain: injected merge into ${bot} IPC (${roomFolder})`);
      } catch (err) { log(`branchBrain: IPC merge injection failed: ${errStr(err)}`); }
    }

    // Also persist notes to bot data dir for context recovery across restarts.
    if (bot) {
      try {
        const botDataDir = path.join(resolveRoot(), '_runtime', 'instances', bot, 'data');
        fs.mkdirSync(botDataDir, { recursive: true });
        let content = `# Branch Brain: ${announcedTitle}\n\nThread: ${replyThreadId}\n\n`;
        content += lastPostedText || '(no output)';
        fs.writeFileSync(path.join(botDataDir, `bb-pending-${replyThreadId.slice(0, 12)}.md`), content);
      } catch (err) { log(`branchBrain: failed to write pending delivery: ${errStr(err)}`); }
    }

    // Post debounced main-timeline merge notice so Captain sees completion.
    // No bot restart needed — BB forks from main brain session, context is already shared.
    if (bot) {
      const existing = branchBrainRestartTimers.get(bot);
      if (existing) clearTimeout(existing);
      const brainSucceeded = postedCount > 0;
      const timer = setTimeout(() => {
        branchBrainRestartTimers.delete(bot);
        const status = brainSucceeded ? '✅ merged' : '⛔ failed';
        if (conn.accessToken) {
          relaySend(conn.homeserver, conn.accessToken, conn.roomId, `[${replyTag()}] 🪾 ${announcedTitle} — ${status}`).catch((err) => log(`branchBrain: summary post failed: ${errStr(err)}`));
        }
        log(`branchBrain: ${bot} BB completed (${status})`);
      }, BRANCH_BRAIN_RESTART_DELAY);
      branchBrainRestartTimers.set(bot, timer);
    }
  });

  child.unref();
}

/**
 * Poll `_runtime/relay-tasks/` for tasks that require host credentials
 * (e.g. git_push). Written by bots via ipc-commands.ts, executed here on host.
 */
async function relayTasksLoop(conns: RoomConn[]): Promise<void> {
  const tasksDir = path.join(resolveRoot(), '_runtime', 'relay-tasks');
  while (true) {
    try {
      if (fs.existsSync(tasksDir)) {
        const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
        for (const file of files) {
          const filePath = path.join(tasksDir, file);
          const processingPath = `${filePath}.processing`;
          try {
            fs.renameSync(filePath, processingPath);
            const data = JSON.parse(fs.readFileSync(processingPath, 'utf-8')) as Record<string, unknown>;
            if (data['type'] === 'git_push') {
              const remote = typeof data['remote'] === 'string' ? data['remote'] : 'origin';
              const branches = Array.isArray(data['branches']) ? (data['branches'] as unknown[]).map(String) : ['main'];
              if (!/^[a-zA-Z0-9._\-/]+$/.test(remote) || remote.startsWith('-') ||
                  branches.some((b) => !/^[a-zA-Z0-9._\-/]+$/.test(b) || b.startsWith('-'))) {
                log(`relayTasks: git_push rejected — invalid remote or branch`);
              } else {
                try {
                  execFileSync('git', ['push', '--no-verify', remote, ...branches], gitOpts(resolveRoot(), 30_000));
                  log(`relayTasks: git pushed ${branches.join(', ')} → ${remote}`);
                } catch (err) {
                  log(`relayTasks: git_push failed: ${errStr(err)}`);
                }
              }
            } else if (data['type'] === 'branch_brain') {
              const thread_id = typeof data['thread_id'] === 'string' ? data['thread_id'] : '';
              const objective = typeof data['objective'] === 'string' ? data['objective'] : '';
              const chat_jid = typeof data['chat_jid'] === 'string' ? data['chat_jid'] : '';
              const bot = typeof data['bot'] === 'string' ? data['bot'] : undefined;
              if (thread_id && objective) {
                const botKey = bot ?? '__relay__';
                const count = activeBranchBrainCount.get(botKey) ?? 0;
                if (count >= MAX_BRANCH_BRAINS_PER_BOT) {
                  log(`relayTasks: branch_brain rejected — ${botKey} already at limit (${MAX_BRANCH_BRAINS_PER_BOT})`);
                  const roomId = chat_jid.replace(/^matrix:/, '');
                  const conn = conns.find(c => c.roomId === roomId) || findEngConn(conns);
                  if (conn?.accessToken && thread_id) {
                    void threadReply(conn, thread_id, `⚠️ Branch Brain rejected: already at concurrent limit (${MAX_BRANCH_BRAINS_PER_BOT}). Wait for a Branch Brain to finish.`).catch((err) => log(`relayTasks: rejection notify failed: ${errStr(err)}`));
                  }
                } else {
                  activeBranchBrainCount.set(botKey, count + 1);
                  void spawnBranchBrain({ thread_id, objective, chat_jid, bot }, conns).finally(() => {
                    const n = activeBranchBrainCount.get(botKey) ?? 1;
                    if (n <= 1) activeBranchBrainCount.delete(botKey);
                    else activeBranchBrainCount.set(botKey, n - 1);
                  });
                }
              } else {
                log(`relayTasks: branch_brain missing required fields (thread_id or objective)`);
              }
            } else if (data['type'] === 'wbs_complete') {
              // Bot signals that it completed a WBS item: { type, bot, item_id }
              const bot = typeof data['bot'] === 'string' ? data['bot'].trim() : '';
              const itemId = typeof data['item_id'] === 'string' ? data['item_id'].trim() : '';
              if (bot && itemId) {
                completeWbsItem(resolveRoot(), bot, itemId);
              } else {
                log(`relayTasks: wbs_complete missing required fields (bot, item_id)`);
              }
            }
            fs.unlinkSync(processingPath);
          } catch (err) {
            log(`relayTasks: error processing ${file}: ${errStr(err)}`);
            try { fs.renameSync(processingPath, `${filePath}.error`); } catch { /* ignore */ }
          }
        }
      }
    } catch (err) {
      log(`relayTasks loop error: ${errStr(err)}`);
    }
    await sleep(RELAY_TASKS_POLL_INTERVAL);
  }
}

// ── Secrets repo sync ──────────────────────────────────────────

function secretsRepoPath(): string {
  return loadShipConfig().secretsPath;
}

/** Commit a change to the secrets repo: stash → add → commit → push → pop. */
function secretsGitCommit(files: string[], message: string): { ok: boolean; error?: string } {
  const cwd = secretsRepoPath();
  const opts = gitOpts(cwd, 15_000);
  try {
    // Stash any other uncommitted changes
    let didStash = false;
    try {
      const out = execSync('git stash --include-untracked', opts).trim();
      didStash = !out.includes('No local changes');
    } catch (err) {
      const detail = execErrOutput(err);
      if (!detail.includes('No local changes')) {
        throw new Error(`git stash failed${detail ? `: ${detail}` : ''}`);
      }
    }
    try {
      for (const f of files) execFileSync('git', ['add', f], opts);
      execFileSync('git', ['commit', '-m', message], opts);
      execSync('git push', { ...opts, timeout: 30_000 });
      return { ok: true };
    } finally {
      if (didStash) {
        try { execSync('git stash pop', opts); } catch { /* leave in stash */ }
      }
    }
  } catch (err) {
    return { ok: false, error: errStr(err) };
  }
}

/** Pull secrets repo with rebase. */
function secretsGitSync(): { ok: boolean; newCommits: number; output: string } {
  const cwd = secretsRepoPath();
  const opts = gitOpts(cwd, 30_000);
  if (fs.existsSync(path.join(cwd, '.git', 'REBASE_HEAD'))) {
    try { execSync('git rebase --abort', opts); } catch { /* ignore */ }
  }
  try {
    execSync('git fetch origin', opts);
    const countStr = execSync('git rev-list HEAD..origin/main --count', { ...opts, timeout: 5_000 }).trim();
    const newCommits = parseInt(countStr, 10) || 0;
    if (newCommits === 0) {
      // Try to push any unpushed local commits
      const aheadStr = execSync('git rev-list origin/main..HEAD --count', { ...opts, timeout: 5_000 }).trim();
      const ahead = parseInt(aheadStr, 10) || 0;
      if (ahead > 0) {
        try {
          execSync('git push', { ...opts, timeout: 30_000 });
          log(`secrets sync: pushed ${ahead} local commit(s)`);
        } catch (pushErr) {
          return { ok: false, output: `${ahead} unpushed commit(s), push failed: ${errStr(pushErr)}`, newCommits: 0 };
        }
      }
      return { ok: true, output: 'up to date', newCommits: 0 };
    }
    let didStash = false;
    try {
      const out = execSync('git stash --include-untracked', opts).trim();
      didStash = !out.includes('No local changes');
    } catch (err) {
      if (!execErrOutput(err).includes('No local changes')) throw err;
    }
    try {
      const output = execSync('git rebase origin/main', opts).trim();
      return { ok: true, output, newCommits };
    } catch (rebaseErr) {
      // If fleet.json conflicts, accept upstream and continue
      try {
        const conflicting = execSync('git diff --name-only --diff-filter=U', opts).trim();
        if (conflicting === 'bots/fleet.json' || conflicting.split('\n').every(f => f === 'bots/fleet.json')) {
          // During rebase, --ours = upstream (the branch we're rebasing onto)
          execSync('git checkout --ours bots/fleet.json', opts);
          execSync('git add bots/fleet.json', opts);
          execSync('git rebase --continue', { ...opts, env: { ...process.env, GIT_EDITOR: 'true' } });
          log('secrets sync: resolved fleet.json conflict (accepted upstream)');
          // Reload upstream fleet into memory
          try { liveFleet = loadFleet(); } catch { /* best effort */ }
          return { ok: true, output: 'rebased (fleet.json conflict resolved)', newCommits };
        }
      } catch { /* couldn't resolve — fall through */ }
      // Abort failed rebase
      try { execSync('git rebase --abort', opts); } catch { /* ignore */ }
      throw rebaseErr;
    } finally {
      if (didStash) {
        try { execSync('git stash pop', opts); } catch { /* conflict — leave in stash */ }
      }
    }
  } catch (err) {
    return { ok: false, output: errStr(err), newCommits: -1 };
  }
}

/** Periodic secrets repo sync loop. */
async function secretsSyncLoop(conns: RoomConn[]): Promise<void> {
  await sleep(10_000);
  while (true) {
    try {
      const result = secretsGitSync();
      if (!result.ok) {
        log(`secrets sync FAILED: ${result.output}`);
        await reportFailure('secrets sync', result.output, conns);
      } else if (result.newCommits > 0) {
        await reportRecovery('secrets sync', conns);
        log(`secrets sync: pulled ${result.newCommits} new commit(s)`);
        // Reload static config from disk (transport assignments come via git).
        // Only merge structural/static fields — don't overwrite runtime state (status, triggerType, etc.)
        try {
          const diskFleet = loadFleet();
          for (const [bot, entry] of Object.entries(diskFleet)) {
            if (!liveFleet[bot]) { liveFleet[bot] = entry; continue; }
            // Transport pickup: bot assigned to us but inactive (phase 1 by another ship)
            if (entry.ship === HOSTNAME && entry.status === 'transit' && liveFleet[bot].ship !== HOSTNAME) {
              liveFleet[bot].ship = HOSTNAME;
              liveFleet[bot].status = 'transit'; // will be materialized below
            }
            // Merge static fields only (role, rank, title, quartersRoom, ship)
            liveFleet[bot].role = entry.role;
            liveFleet[bot].rank = entry.rank;
            if (entry.title !== undefined) liveFleet[bot].title = entry.title;
            if (entry.quartersRoom !== undefined) liveFleet[bot].quartersRoom = entry.quartersRoom;
          }
        } catch { /* no fleet on disk */ }

        // Materialize — bots assigned here but not active (dematerialized on source ship)
        if (!isShipCommissioned()) { /* decommissioned — skip materialize */ }
        else try {
          for (const [bot, entry] of Object.entries(liveFleet)) {
            if (entry.ship === HOSTNAME && entry.status === 'transit') {
              log(`transport: materializing ${bot}`);
              fleetUpdate(bot, { status: 'quarters', triggerType: 'always' });
              fleetDirty = true;
              persistFleet();
              clearShipConfigCache();
              const root = resolveRoot();
              try {
                ensurePodmanReady();
                bootstrapBot(root, bot);
                writeCrewStatus(root, bot);
                injectWbsTasks(root, bot);
                const matEnv = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
                for (const c of conns) {
                  if (c.accessToken) {
                    await reply(c, `📡 ${matEnv?.ASSISTANT_NAME || capitalizeName(bot)} materialized`).catch(() => {});
                  }
                }
              } catch (err) {
                log(`transport: materialize failed for ${bot}: ${errStr(err)}`);
              }
            }
          }
        } catch (err) {
          log(`transport: materialize check failed: ${errStr(err)}`);
        }

        // Check inbox for pending items targeting this ship
        try {
          const inboxPath = path.join(secretsRepoPath(), 'operator', 'inbox.md');
          if (fs.existsSync(inboxPath)) {
            const content = fs.readFileSync(inboxPath, 'utf-8');
            const pending = content
              .split('\n')
              .filter(line => /^- \[ \]/.test(line))
              .filter(line => {
                const targetMatch = line.match(/\(target:\s*([^,)]+)/i);
                if (!targetMatch) return false;
                const target = targetMatch[1].trim();
                return isThisShip(target) || target.toLowerCase() === 'all';
              });
            if (pending.length > 0) {
              log(`inbox: ${pending.length} pending item(s) for ${HOSTNAME}`);
              // Notify operator via tmux
              try {
                const SESSION = 'operator';
                execFileSync('tmux', ['has-session', '-t', SESSION], { stdio: 'pipe' });
                const msg = `📬 ${pending.length} inbox item(s) for ${HOSTNAME}. Read operator/inbox.md`;
                execFileSync('tmux', ['send-keys', '-t', SESSION, '-l', msg], { stdio: 'pipe' });
                execFileSync('tmux', ['send-keys', '-t', SESSION, 'Enter'], { stdio: 'pipe' });
              } catch { /* no operator session — skip */ }
            }
          }
        } catch { /* inbox check is best-effort */ }
      } else {
        // Success with 0 new commits — still clear any prior failure
        await reportRecovery('secrets sync', conns);
      }
    } catch (err) {
      log(`secrets sync loop error: ${errStr(err)}`);
    }
    await sleep(SECRETS_SYNC_INTERVAL);
  }
}

function appendHealthHistory(report: string): void {
  const root = resolveRoot();
  const historyFile = path.join(root, '_runtime', 'data', 'health-history.jsonl');
  try {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    fs.appendFileSync(historyFile, report.trim() + '\n');
  } catch (err) {
    log(`health history append failed: ${errStr(err)}`);
  }
}

/**
 * Read health-history.jsonl and compute per-bot sigkill/oom deltas over the past `hours` hours.
 * Returns a map of bot name → { sigkills: delta, oom_kills: delta }.
 */
function computeHealthDeltas(historyFile: string, currentBots: Record<string, Record<string, unknown>>, hours: number): Record<string, { sigkills: number; oom_kills: number }> {
  if (!fs.existsSync(historyFile)) return {};
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
  let oldest: Record<string, Record<string, unknown>> | null = null;
  try {
    const lines = fs.readFileSync(historyFile, 'utf-8').trim().split('\n');
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { ts?: string; bots?: Record<string, Record<string, unknown>> };
        if (!entry.ts || !entry.bots) continue;
        if (entry.ts < cutoff) { oldest = entry.bots; continue; }
        break; // first entry after cutoff — stop
      } catch { /* skip */ }
    }
  } catch { return {}; }
  if (!oldest) return {};
  const result: Record<string, { sigkills: number; oom_kills: number }> = {};
  for (const [bot, cur] of Object.entries(currentBots)) {
    const old = oldest[bot];
    if (!old) continue;
    result[bot] = {
      sigkills: Number(cur.sigkills || 0) - Number(old.sigkills || 0),
      oom_kills: Number(cur.oom_kills || 0) - Number(old.oom_kills || 0),
    };
  }
  return result;
}

/** Prune old session JSONL files and telemetry directories. */
function runSessionCleanup(): void {
  const root = resolveRoot();
  try {
    const { freedBytes, cleaned } = sessionCleanup(
      path.join(root, '_runtime', 'instances'), 5
    );
    if (freedBytes > 0) {
      const kb = Math.round(freedBytes / 1024);
      log(`session cleanup: freed ${kb}KB (${cleaned.length} files)`);
    }
  } catch (err) {
    log(`session cleanup error: ${errStr(err)}`);
  }
}

/** Periodic health loop — runs health check and uploads to S3. */
async function healthLoop(): Promise<void> {
  // Wait before first run to let everything stabilize
  await sleep(60_000);
  while (true) {
    try {
      const report = runHealthCheck();
      if (report) {
        appendHealthHistory(report);
        // Enrich upload with 24h trend deltas
        let uploadPayload = report;
        try {
          const parsed = JSON.parse(report) as { bots?: Record<string, Record<string, unknown>> };
          if (parsed.bots) {
            const historyFile = path.join(resolveRoot(), '_runtime', 'data', 'health-history.jsonl');
            const deltas = computeHealthDeltas(historyFile, parsed.bots, 24);
            uploadPayload = JSON.stringify({ ...parsed, trends_24h: deltas });
          }
        } catch { /* upload unmodified if parse fails */ }
        const uploaded = await uploadHealthToS3(uploadPayload);
        log(`health check: ${uploaded ? 'uploaded to S3' : 'S3 unavailable, local only'}`);
      }
    } catch (err) {
      log(`health loop error: ${errStr(err)}`);
    }
    try { runSessionCleanup(); } catch { /* non-critical */ }
    try { removeStaleProcesses(); } catch { /* non-critical */ }
    try { await publishFleetReport(); } catch { /* non-critical */ }
    // Cross-ship health staleness is handled by healthWatchdogLoop (fire-once alerts)
    await sleep(HEALTH_INTERVAL);
  }
}

// ── Health watchdog — alert BTC when a ship's S3 health report goes stale ──

const HEALTH_WATCHDOG_INTERVAL_MS = envInt('HEALTH_WATCHDOG_INTERVAL_MS', 5 * 60_000);
const HEALTH_STALE_THRESHOLD_MS = 30 * 60_000;
const stalenessAlerted = new Set<string>();

async function healthWatchdogLoop(): Promise<void> {
  await sleep(2 * 60_000);
  while (true) {
    try {
      if (getS3Client() && await electSpeaker()) {
        const reports = await fetchAllHealthReports();
        const now = Date.now();
        for (const { ship, data } of reports) {
          const tsMs = new Date(String(data.ts ?? '')).getTime();
          if (isNaN(tsMs)) continue;
          const ageMs = now - tsMs;
          if (ageMs > HEALTH_STALE_THRESHOLD_MS) {
            if (!stalenessAlerted.has(ship)) {
              stalenessAlerted.add(ship);
              const ageMin = Math.round(ageMs / 60_000);
              await postToBTC(`⚠️ Health watchdog: ${ship} S3 health report stale ${ageMin}min — relay may be down`);
            }
          } else if (stalenessAlerted.has(ship)) {
            stalenessAlerted.delete(ship);
            await postToBTC(`✅ Health watchdog: ${ship} health report recovered`);
          }
        }
      }
    } catch (err) {
      log(`health watchdog error: ${errStr(err)}`);
    }
    await sleep(HEALTH_WATCHDOG_INTERVAL_MS);
  }
}

// ── Metrics loop — periodic S3 publish ──────────────────────────────

const METRICS_INTERVAL = envInt('METRICS_INTERVAL_MS', 5 * 60_000); // 5 min default

async function metricsLoop(): Promise<void> {
  await sleep(90_000); // let startup stabilize
  while (true) {
    try {
      await publishMetrics();
    } catch (err) {
      log(`metrics: publish error: ${errStr(err)}`);
    }
    await sleep(METRICS_INTERVAL);
  }
}

// ── Heartbeat — nudge idle bots to do autonomous work ──────────────

const HEARTBEAT_INTERVAL = envInt('HEARTBEAT_INTERVAL_MS', 15 * 60_000); // 15 min default
const AUTO_SLEEP_IDLE_MS = envInt('AUTO_SLEEP_IDLE_MS', 30 * 60_000); // 30 min default; 0 = disabled

/** Check if a bot has a running container. */
function hasRunningContainer(bot: string): boolean {
  try {
    const result = spawnSync('podman', ['ps', '--filter', `name=nanoclaw-${bot}`, '--format', '{{.Names}}'], {
      encoding: 'utf-8', timeout: 5_000, stdio: 'pipe',
    });
    return result.status === 0 && (result.stdout || '').trim().length > 0;
  } catch { return false; }
}

/**
 * Check if a bot is idle: onduty, no running container, and heartbeat stale (or missing).
 * Used by the heartbeat loop to identify bots eligible for WBS assignment and nudging.
 */
function isBotIdle(root: string, bot: string): boolean {
  if (liveFleet[bot]?.status !== 'onduty') return false;
  if (hasRunningContainer(bot)) return false;
  try {
    const hbPath = path.join(root, '_runtime', 'instances', bot, 'data', 'heartbeat');
    const hbAge = Date.now() - fs.statSync(hbPath).mtimeMs;
    if (hbAge < HEARTBEAT_INTERVAL) return false; // heartbeat recent — not truly idle
  } catch { /* no heartbeat file — treat as idle */ }
  return true;
}

/**
 * Periodic heartbeat: nudge idle bots to do autonomous work.
 * Sends a message to the bot's room mentioning it by name, which triggers
 * the bot's trigger pattern and wakes it to do autonomous work.
 *
 * Chief behaviour (WBS 7.0): when the chief is idle, it assigns WBS items to ALL
 * idle non-chief bots in the same room before being nudged to do its own work.
 * Non-chief behaviour: if idle with no WBS assignment, the bot is told to ask
 * the chief for work instead of falling back to GitHub issue scanning.
 */
async function heartbeatLoop(conns: RoomConn[]): Promise<void> {
  await sleep(5 * 60_000); // wait 5 min before first heartbeat
  while (true) {
    try {
      const root = resolveRoot();
      const botRooms = buildBotRoomMap();
      const allBotList = Object.entries(liveFleet).map(([n, e]) => ({ name: n, role: e.role, rank: e.rank, status: e.status }));
      for (const bot of getActiveBots()) {
        if (!isBotIdle(root, bot)) continue;
        const roomName = botRooms[bot];
        if (!roomName) continue;
        const conn = conns.find((c) => c.name === roomName);
        if (!conn?.accessToken) continue;
        // Get the bot's display name for the trigger
        const env = loadProfileEnv(root, bot);
        const name = env?.ASSISTANT_NAME || capitalizeName(bot);

        // Determine if this bot is the chief of its room
        const chiefBot = findRoomChief(roomName, allBotList);
        const isChief = chiefBot === bot;

        // Auto-sleep: if bot has been idle longer than AUTO_SLEEP_IDLE_MS, sleep it instead of nudging
        if (AUTO_SLEEP_IDLE_MS > 0) {
          try {
            const hbPath = path.join(root, '_runtime', 'instances', bot, 'data', 'heartbeat');
            const hbAge = Date.now() - fs.statSync(hbPath).mtimeMs;
            if (hbAge >= AUTO_SLEEP_IDLE_MS) {
              log(`auto-sleep: ${name} idle ${Math.round(hbAge / 60_000)}m — sleeping`);
              stopBot(bot);
              killStaleContainers(bot);
              await setBotDisplayStatus(root, bot, 'sleep');
              reabsorbWbsItems(root, bot);
              fleetUpdate(bot, { status: 'sleep', triggerType: 'never' });
              persistFleet();
              publishFleetReport().catch(() => {});
              continue;
            }
          } catch { /* no heartbeat file — skip auto-sleep check */ }
        }

        let nudge: string;
        if (isChief) {
          // Chief path (WBS 7.0): assign WBS items to idle non-chief bots in the same room,
          // then nudge the chief to review the WBS and assign any remaining unassigned work.
          const crewAssignments: string[] = [];
          for (const crewBot of getActiveBots()) {
            if (crewBot === bot) continue; // skip self
            if (botRooms[crewBot] !== roomName) continue; // different room
            if (!isBotIdle(root, crewBot)) continue; // not idle
            const crewTitle = autoAssignWbsItem(root, crewBot);
            if (crewTitle) {
              const crewEnv = loadProfileEnv(root, crewBot);
              const crewName = crewEnv?.ASSISTANT_NAME || capitalizeName(crewBot);
              crewAssignments.push(`${crewName}: "${crewTitle}"`);
              log(`heartbeat: chief ${name} assigned WBS "${crewTitle}" to ${crewName}`);
            }
          }
          // Self-assign for the chief as well
          const chiefTitle = autoAssignWbsItem(root, bot);
          if (crewAssignments.length > 0) {
            const assignList = crewAssignments.join('; ');
            nudge = chiefTitle
              ? `<m>${name}</m>, you are the chief. Crew assignments dispatched: ${assignList}. Your task: "${chiefTitle}".`
              : `<m>${name}</m>, you are the chief. Crew assignments dispatched: ${assignList}. Check the WBS for any remaining unassigned items.`;
          } else {
            nudge = chiefTitle
              ? `<m>${name}</m>, you are the chief. Work on your next task: "${chiefTitle}".`
              : `<m>${name}</m>, you are the chief. Review the WBS for unassigned ready items and assign work to available crew.`;
          }
          log(`heartbeat: nudged chief ${name} in ${roomName}${chiefTitle ? ` (WBS: "${chiefTitle}")` : ''}${crewAssignments.length > 0 ? ` (assigned ${crewAssignments.length} crew item(s))` : ''}`);
        } else {
          // Non-chief path (WBS 7.0): if idle with no WBS item, ask the chief for work.
          const assignedTitle = autoAssignWbsItem(root, bot);
          if (assignedTitle) {
            nudge = `<m>${name}</m>, work on your next task: "${assignedTitle}".`;
          } else if (chiefBot) {
            const chiefEnv = loadProfileEnv(root, chiefBot);
            const chiefName = chiefEnv?.ASSISTANT_NAME || capitalizeName(chiefBot);
            nudge = `<m>${name}</m>, you have no WBS assignment. Ask <m>${chiefName}</m> for your next task.`;
          } else {
            nudge = `<m>${name}</m>, check GitHub issues and work on the highest priority item you can act on.`;
          }
          log(`heartbeat: nudged ${name} in ${roomName}${assignedTitle ? ` (WBS: "${assignedTitle}")` : ''}`);
        }

        await relaySend(conn.homeserver, conn.accessToken, conn.roomId, nudge);
      }
    } catch (err) {
      log(`heartbeat error: ${errStr(err)}`);
    }
    await sleep(HEARTBEAT_INTERVAL);
  }
}

/**
 * Retrospective sequence: dismiss → send questions → wait → sleep → wake.
 * Called automatically when a bot's duty cycle expires.
 */
async function runRetrospectiveSequence(bot: string, conns: RoomConn[]): Promise<void> {
  const root = resolveRoot();
  const entry = liveFleet[bot];
  if (!entry) return;
  const env = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
  const name = env?.ASSISTANT_NAME || capitalizeName(bot);
  const engConn = findEngConn(conns);
  const quartersRoomId = entry.quartersRoom;
  const quartersConn = quartersRoomId ? conns.find(c => c.roomId === quartersRoomId) : undefined;

  const tr = (text: string) => engConn ? reply(engConn, text).catch(() => {}) : Promise.resolve();
  log(`duty cycle: ${bot} duty expired — starting retrospective`);
  await tr(`🔄 ${name} duty cycle complete — starting retrospective`);

  // Step 1: Dismiss (leave duty room, back to quarters)
  try {
    const loungeId = findShipByHostname()?.[1]?.loungeId as string | undefined;
    const dutyRoomId = conns.find(c => c.name === botDutyRoom(bot))?.roomId;
    try {
      const { token: botToken, homeserver } = await botMatrixLogin(root, bot);
      if (dutyRoomId) await botLeaveRoom(botToken, homeserver, dutyRoomId);
      if (loungeId) await botLeaveRoom(botToken, homeserver, loungeId);
    } catch { /* non-fatal */ }
    // status=retrospective: container keeps running, bot reflects in quarters
    fleetUpdate(bot, { status: 'retrospective', triggerType: 'always', ondutyAt: undefined });
    persistFleet();
    clearShipConfigCache();
    reabsorbWbsItems(root, bot);
    restartBotForRoom(root, bot);
    writeCrewStatus(root, bot);
    publishFleetReport().catch(() => {});
    log(`duty cycle: ${bot} dismissed → retrospective`);
  } catch (err) {
    log(`duty cycle: ${bot} dismiss failed — ${errStr(err)}`);
    return;
  }

  // Step 2: Send retrospective questions to quarters room
  if (quartersConn?.accessToken) {
    const questions = [
      `<m>${name}</m>, your duty cycle is complete. Please reflect:`,
      '1. What went well since your last duty cycle?',
      '2. What didn\'t go well? Any blockers or mistakes?',
      '3. How could you do better next time?',
      '4. Which parts of your CLAUDE.md helped you achieve your goals? Which parts didn\'t?',
      '5. Update your CLAUDE.md and MEMORY.md now. Post "Update complete." when done.',
    ].join('\n');
    try {
      await relaySend(quartersConn.homeserver, quartersConn.accessToken, quartersConn.roomId, questions);
      log(`duty cycle: ${bot} retrospective questions sent`);
    } catch (err) {
      log(`duty cycle: ${bot} could not send retrospective questions — ${errStr(err)}`);
    }
  }

  // Step 3: Wait for retrospective (timeout)
  await sleep(RETROSPECTIVE_TIMEOUT_MS);

  // Step 4: Sleep (stop container — Dream phase begins)
  if (liveFleet[bot]?.status !== 'retrospective') {
    log(`duty cycle: ${bot} retrospective interrupted — aborting cycle`);
    return;
  }
  log(`duty cycle: ${bot} retrospective complete — sleeping`);
  await tr(`💤 ${name} retrospective complete — sleeping`);
  try {
    stopBot(bot);
    killStaleContainers(bot);
    await setBotDisplayStatus(root, bot, 'sleep');
    reabsorbWbsItems(root, bot);
    // status=dream: container stopped, deferred git changes can now apply
    fleetUpdate(bot, { status: 'dream', triggerType: 'never' });
    persistFleet();
    publishFleetReport().catch(() => {});
    log(`duty cycle: ${bot} asleep — Dream phase`);
  } catch (err) {
    log(`duty cycle: ${bot} sleep failed — ${errStr(err)}`);
    return;
  }

  // Step 5: Dream — wait for any pending git sync to apply changes
  await sleep(60_000);

  // Step 6: Wake (Ready phase — fresh start with latest code)
  log(`duty cycle: ${bot} waking for new cycle`);
  await tr(`🟢 ${name} starting fresh cycle`);
  try {
    stopBot(bot);
    killStaleContainers(bot);
    // status=ready: like quarters but signals the bot just completed a duty cycle
    fleetUpdate(bot, { status: 'ready', triggerType: 'always' });
    persistFleet();
    clearShipConfigCache();
    bootstrapBot(root, bot);
    writeCrewStatus(root, bot);
    injectWbsTasks(root, bot);
    await setBotDisplayStatus(root, bot, 'ready');
    sendLifecycleMsg(bot, 'started', entry.rank).catch(() => {});
    publishFleetReport().catch(() => {});
    log(`duty cycle: ${bot} ready — new cycle`);
    await tr(`✅ ${name} ready — new duty cycle`);
  } catch (err) {
    log(`duty cycle: ${bot} wake failed — ${errStr(err)}`);
    await tr(`⛔ ${name} wake failed after retrospective — ${errStr(err)}`);
  }
}

const DUTY_CYCLE_CHECK_INTERVAL = 60_000; // check every minute

/**
 * Periodic duty cycle loop — checks if any onduty bot has exceeded DUTY_CYCLE_MS.
 * When expired: runs dismiss → retrospective → sleep → dream → wake.
 */
async function dutyCycleLoop(conns: RoomConn[]): Promise<void> {
  if (!DUTY_CYCLE_MS) return; // disabled if 0
  // Track bots currently in retrospective to avoid double-triggering
  const inRetrospective = new Set<string>();
  while (true) {
    await sleep(DUTY_CYCLE_CHECK_INTERVAL);
    try {
      const now = Date.now();
      for (const [bot, entry] of Object.entries(liveFleet)) {
        if (entry.status !== 'onduty') continue;
        if (entry.ship !== HOSTNAME) continue;
        if (!entry.ondutyAt) continue;
        if (inRetrospective.has(bot)) continue;
        if (now - entry.ondutyAt < DUTY_CYCLE_MS) continue;
        inRetrospective.add(bot);
        runRetrospectiveSequence(bot, conns)
          .catch(err => log(`duty cycle: ${bot} retrospective sequence error — ${errStr(err)}`))
          .finally(() => inRetrospective.delete(bot));
      }
    } catch (err) {
      log(`duty cycle loop error: ${errStr(err)}`);
    }
  }
}

// ── Command handling ───────────────────────────────────────────────

/**
 * Broadcast a lifecycle event for a bot via its quarters room.
 * Always routes to quarters — lifecycle messages are operational noise that should
 * not clutter duty rooms (engineering/astrometrics). Falls back to duty room only
 * if no quarters room is configured.
 * Format: `[🦁⭐ Herc] BotName stopped|started (rank N)`
 */
async function sendLifecycleMsg(
  botId: string,
  event: 'stopped' | 'started' | 'reranked',
  rank?: number,
): Promise<void> {
  try {
    const root = resolveRoot();
    const env = (() => { try { return loadProfileEnv(root, botId); } catch { return null; } })();
    const botName = env?.ASSISTANT_NAME || capitalizeName(botId);
    const fleetEntry = liveFleet[botId];
    // Always prefer quarters room — lifecycle messages are noise in duty rooms.
    let conn: RoomConn | undefined;
    if (fleetEntry?.quartersRoom) {
      conn = activeConns.find(c => c.roomId === fleetEntry.quartersRoom);
    }
    if (!conn) {
      const roomName = botDutyRoom(botId);
      conn = activeConns.find(c => c.name.toLowerCase() === roomName);
    }
    if (!conn) return;
    const rankPart = rank !== undefined ? ` (rank ${rank})` : '';
    // Use reply() so Loudspeaker sends the announcement (not Intercom directly).
    await reply(conn, `${botName} ${event}${rankPart}`);
  } catch { /* non-fatal — lifecycle broadcast is best-effort */ }
}

async function handleLifecycleCommand(
  action: 'report' | 'dismiss' | 'sleep' | 'wake',
  target: string | undefined,
  conn: RoomConn,
): Promise<void> {
  const root = resolveRoot();
  // BTC is a universal command room — all local bots reachable regardless of status.
  // !report uses assignment-based scope so it can reach bots currently in quarters.
  // All other commands in duty/quarters rooms use presence-based matching.
  const isBTC = conn.roomId === curtainRoomId;
  // In BTC without an explicit bot target, only the speaker ship acts — prevents all ships
  // from executing and replying to the same untargeted lifecycle command (fixes #50).
  if (isBTC && !target && !await electSpeaker()) return;
  const scope = isBTC ? 'ship' : action === 'report' ? 'assigned' : 'present';
  let bots = resolveBots(target, conn, scope);

  // For !wake: a targeted sleeping/dreaming bot on this ship is always wakeable — it is not
  // "in" any duty room but can be bootstrapped from anywhere (fixes #77).
  if (bots.length === 0 && action === 'wake' && target && liveFleet[target]?.ship === HOSTNAME) {
    bots = [target];
  }

  // No local bots matched.
  if (bots.length === 0) {
    // Target is on a different ship — stay silent; that ship handles it (fixes #77).
    if (target && liveFleet[target] && liveFleet[target].ship !== HOSTNAME) return;
    // Explicit target exists on this ship but isn't in the room — warn.
    if (target && scope === 'present' && liveFleet[target]?.ship === HOSTNAME) {
      const tEnv = (() => { try { return loadProfileEnv(root, target); } catch { return null; } })();
      const tName = tEnv?.ASSISTANT_NAME || capitalizeName(target);
      await reply(conn, `📡 ${tName} not in this room`);
      return;
    }
    // Untargeted: only announce in fleet rooms (not quarters).
    const isQuarters = Object.values(liveFleet).some(e => e.quartersRoom === conn.roomId);
    if (!isQuarters && await electSpeaker()) await reply(conn, `📡 no bots here to ${action}`);
    return;
  }

  if (action !== 'dismiss' && action !== 'sleep') {
    if (!isShipCommissioned()) {
      await reply(conn, `⛔ ship decommissioned — use !commission first`);
      return;
    }
    try { ensurePodmanReady(); } catch (err) {
      await reply(conn, `⛔ podman not ready — ${errStr(err)}`);
      return;
    }
  }

  // Thread root for dismiss/sleep/report — one root per command invocation, results as thread replies.
  let cmdThreadRoot: string | undefined;
  if (action === 'dismiss' || action === 'sleep' || action === 'report') {
    const labelEnv = target ? (() => { try { return loadProfileEnv(root, target); } catch { return null; } })() : null;
    const label = labelEnv?.ASSISTANT_NAME || (target ? capitalizeName(target) : `${bots.length} bot${bots.length !== 1 ? 's' : ''}`);
    cmdThreadRoot = await reply(conn, `📡 ${action} ${label}`);
  }

  for (const bot of bots) {
    const env = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
    const name = env?.ASSISTANT_NAME || capitalizeName(bot);
    const rank = liveFleet[bot]?.rank ?? 99;
    log(`!${action} ${name}`);
    // Thread reply helper — falls back to main reply if root unavailable.
    const tr = (text: string) => cmdThreadRoot ? threadReply(conn, cmdThreadRoot, text) : reply(conn, text);

    // Resolve ship room IDs for room management
    const loungeId = findShipByHostname()?.[1]?.loungeId as string | undefined;
    const dutyRoomId = conn.roomId;

    if (action === 'dismiss') {
      // Dismiss: leave duty room. Restart bot to monitor quarters with full capabilities.
      try {
        try {
          const { token: botToken, homeserver } = await botMatrixLogin(root, bot);
          await botLeaveRoom(botToken, homeserver, dutyRoomId);
          if (loungeId) await botLeaveRoom(botToken, homeserver, loungeId);
          log(`${name}: returned to quarters`);
        } catch (roomErr) {
          log(`${name}: room leave failed (non-fatal): ${errStr(roomErr)}`);
        }
        fleetUpdate(bot, { status: 'quarters', triggerType: 'always', ondutyAt: undefined });
        persistFleet();
        clearShipConfigCache();
        // Restart bot so NanoClaw monitors quarters (lightweight — no rebuild)
        reabsorbWbsItems(root, bot);
        restartBotForRoom(root, bot);
        writeCrewStatus(root, bot);
        await tr(`✅ ${name} dismissed`);
        publishFleetReport().catch(() => {});
      } catch (err) {
        log(`!dismiss ${name} failed: ${errStr(err)}`);
        await tr(`⛔ ${name} dismiss failed — ${errStr(err)}`);
      }
    } else if (action === 'sleep') {
      // Sleep only allowed from quarters — bot must be in quarters status
      if (liveFleet[bot]?.status !== 'quarters') {
        await tr(`⚠️ ${name} must be in quarters to sleep — use !dismiss first`);
        continue;
      }
      try {
        stopBot(bot);
        killStaleContainers(bot);
        await setBotDisplayStatus(root, bot, 'sleep');
        // Leave non-quarters rooms
        const qid = liveFleet[bot]?.quartersRoom;
        try {
          const { token: botToken, homeserver } = await botMatrixLogin(root, bot);
          for (const rid of [dutyRoomId, loungeId]) {
            if (rid && rid !== qid) await botLeaveRoom(botToken, homeserver, rid);
          }
        } catch { /* non-fatal */ }
        reabsorbWbsItems(root, bot);
        fleetUpdate(bot, { status: 'sleep', triggerType: 'never' });
        persistFleet();
        await tr(`✅ ${name} asleep`);
        publishFleetReport().catch(() => {});
      } catch (err) {
        await tr(`⛔ ${name} sleep failed — ${errStr(err)}`);
      }
    } else if (action === 'wake') {
      // Wake sleeping/dreaming bot or restart already-awake bot (preserves current status)
      const currentStatus = liveFleet[bot]?.status;
      const isRestart = currentStatus !== 'sleep' && currentStatus !== 'dream';
      const verb = isRestart ? 'restarting' : 'waking';
      const doneVerb = isRestart ? 'restarted' : 'awake';
      const startedAt = Date.now();
      const role = env?.ASSISTANT_ROLE || liveFleet[bot]?.role || '?';
      // When bot is in quarters, route progress messages to their quarters room (#168)
      const qRoom = liveFleet[bot]?.quartersRoom;
      const progressConn = (currentStatus === 'quarters' && qRoom)
        ? (activeConns.find(c => c.roomId === qRoom) ?? conn)
        : conn;
      const threadRoot = await reply(progressConn, `📡 ${verb} ${name}`);
      if (!threadRoot) continue;
      let stepN = 0;
      const totalSteps = 4;
      const step = (text: string) => threadReply(progressConn, threadRoot, `[${++stepN}/${totalSteps} ${formatDuration(Date.now() - startedAt)}] ${text}`);
      try {
        await setBotDisplayStatus(root, bot, 'building');
        await step('🔄 building');
        if (!isRestart) {
          fleetUpdate(bot, { status: 'quarters', triggerType: 'always' });
          persistFleet();
          clearShipConfigCache();
        }
        stopBot(bot);
        killStaleContainers(bot);
        deployBot(root, bot);
        await setBotDisplayStatus(root, bot, 'starting');
        await step('🚀 starting');
        startBot(root, bot);
        writeCrewStatus(root, bot);
        injectWbsTasks(root, bot);
        await setBotDisplayStatus(root, bot, 'waiting');
        await step('🟡 waiting for first output');
        const model = env?.BRAIN_MODEL || '?';
        const roleIcon = ROLE_ICONS[role.toLowerCase()] ?? '';
        const medal = rankMedal(rank, false);
        const ver = botVersion(root, bot);
        await setBotDisplayStatus(root, bot, 'online');
        await step(`🟢 online · ${[roleIcon, medal].filter(Boolean).join(' ')} · ${model}${ver}`);
        await reply(progressConn, `✅ ${name} ${doneVerb}`);
        publishFleetReport().catch(() => {});
      } catch (err) {
        log(`!wake ${name} failed: ${errStr(err)}`);
        recordInfraFailure(`wake-${bot}`);
        if (!isRestart) await setBotDisplayStatus(root, bot, 'sleep');
        const fail = `⛔ wake ${name} failed — ${errStr(err)}`;
        await step(fail);
        await reply(progressConn, fail);
        // Count build/deploy failures in infra metrics
        recordInfraFailure('wake-build');
      }
    } else {
      // Report: move awake bot to duty room. Skip sleeping/dreaming bots.
      if (liveFleet[bot]?.status === 'sleep' || liveFleet[bot]?.status === 'dream') {
        log(`!report ${name}: skipping (${liveFleet[bot]?.status})`);
        continue;
      }
      if (liveFleet[bot]?.status === 'onduty') {
        await tr(`⚠️ ${name} already on duty`);
        continue;
      }
      // Normie enforcement (#118): bots whose role has rw:[] in fleet.json roles
      // have no duty-room access and must stay in quarters.
      const botRole = liveFleet[bot]?.role?.toLowerCase() ?? '';
      if (isQuartersOnlyRole(botRole)) {
        await tr(`⚠️ ${name} has no duty room (quarters only)`);
        continue;
      }
      try {
        // Move bot: leave any non-quarters room → join duty room
        try {
          const { token: botToken, homeserver, userId: botUserId } = await botMatrixLogin(root, bot);
          if (loungeId) await botLeaveRoom(botToken, homeserver, loungeId);
          await botJoinRoom(botToken, homeserver, dutyRoomId, conn, botUserId);
        } catch (roomErr) {
          log(`${name}: room move failed: ${errStr(roomErr)}`);
          await tr(`⛔ ${name} report failed — ${errStr(roomErr)}`);
          continue;
        }
        fleetUpdate(bot, { status: 'onduty', triggerType: 'callout', ship: HOSTNAME, ondutyAt: Date.now() });
        persistFleet();
        clearShipConfigCache();
        // Full redeploy so bot gets latest code (rsync + npm ci + build + stamp).
        // Previously only re-seeded rooms (restartBotForRoom) which left bots on
        // stale versions when !report interrupted a duty cycle retrospective.
        stopBot(bot);
        killStaleContainers(bot);
        deployBot(root, bot);
        // Re-seed with exact dutyRoomId to avoid intercom.json lookup issues (#193)
        restartBotForRoom(root, bot, dutyRoomId);
        writeCrewStatus(root, bot);
        injectWbsTasks(root, bot);
        await tr(`✅ ${name} on duty`);
        sendLifecycleMsg(bot, 'started', rank).catch(() => {});
        publishFleetReport().catch(() => {});
      } catch (err) {
        log(`!report ${name} failed: ${errStr(err)}`);
        await tr(`⛔ ${name} report failed — returned to quarters`);
      }
    }
  }

}

/** Send bot to a non-quarters, non-duty room. No args = list available rooms. */
async function handleGoCommand(cmd: string, conn: RoomConn): Promise<void> {
  const root = resolveRoot();
  const loungeId = findShipByHostname()?.[1]?.loungeId as string | undefined;

  // Build available room map
  const rooms: Record<string, string> = {};
  if (loungeId) rooms['lounge'] = loungeId;

  const args = cmd.slice('!go'.length).trim().split(/\s+/).filter(Boolean);

  // No args — list available rooms
  if (args.length === 0) {
    if (Object.keys(rooms).length === 0) {
      await helpReply(conn, 'No available rooms');
      return;
    }
    const list = Object.keys(rooms).map(r => `  • ${r}`).join('\n');
    await helpReply(conn, `Available rooms:\n${list}\n\nUsage: \`!go <room> [bot]\``);
    return;
  }

  const roomName = args[0].toLowerCase();
  const targetBot = args[1]?.toLowerCase();

  const roomId = rooms[roomName];
  if (!roomId) {
    await helpReply(conn, `Unknown room: ${roomName}. Available: ${Object.keys(rooms).join(', ')}`);
    return;
  }

  const isBTC = conn.roomId === curtainRoomId;
  const scope = isBTC ? 'assigned' : 'present' as const;
  const bots = resolveBots(targetBot, conn, scope);
  const labelEnv = targetBot ? (() => { try { return loadProfileEnv(root, targetBot); } catch { return null; } })() : null;
  if (bots.length === 0) {
    if (targetBot && scope === 'present' && liveFleet[targetBot]?.ship === HOSTNAME) {
      await reply(conn, `📡 ${labelEnv?.ASSISTANT_NAME || capitalizeName(targetBot)} not in this room`);
    } else if (targetBot) {
      await helpReply(conn, `No local bot: ${targetBot}`);
    }
    return;
  }

  const label = labelEnv?.ASSISTANT_NAME || (targetBot ? capitalizeName(targetBot) : `${bots.length} bot${bots.length !== 1 ? 's' : ''}`);
  const goThreadRoot = await reply(conn, `📡 go ${roomName} ${label}`);
  const tr = (text: string) => goThreadRoot ? threadReply(conn, goThreadRoot, text) : reply(conn, text);

  for (const bot of bots) {
    const env = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
    const name = env?.ASSISTANT_NAME || capitalizeName(bot);
    log(`!go ${roomName} ${name}`);
    try {
      const { token: botToken, homeserver, userId: botUserId } = await botMatrixLogin(root, bot);
      await botJoinRoom(botToken, homeserver, roomId, conn, botUserId);
      await tr(`✅ ${name} → ${roomName}`);
    } catch (err) {
      log(`!go ${roomName} ${name} failed: ${errStr(err)}`);
      await tr(`⛔ go ${roomName} ${name} failed — ${errStr(err)}`);
    }
  }
}

// ── Combined metrics + health handler ────────────────────────────

/** Handle !metrics — combined observability output (health + metrics). */
async function handleMetricsHealth(cmd: string, conn: RoomConn): Promise<void> {
  try {
    let scope = cmd.slice('!metrics'.length).trim();
    if (!scope) {
      const roomName = conn.name.toLowerCase();
      if (conn.name === 'BehindTheCurtain' || conn.roomId === curtainRoomId) {
        scope = 'all';
      } else if (roomName === 'bridge') {
        scope = 'fleet';
      } else if (roomName === 'engineering') {
        scope = 'engineering';
      } else {
        const qBot = Object.entries(liveFleet).find(([, e]) => e.quartersRoom === conn.roomId);
        scope = qBot ? qBot[0] : 'all';
      }
    }

    const snapshot = computeMetrics();
    snapshot.shipMetrics.codeVersion = relayVersion(resolveRoot());
    publishMetrics().catch(err => log(`metrics: publish error: ${errStr(err)}`));

    // For fleet/all scopes: run and upload health check on every ship.
    const wantsHealth = scope === 'fleet' || scope === 'all';
    if (wantsHealth) {
      const healthReport = runHealthCheck();
      if (healthReport) uploadHealthToS3(healthReport).catch(() => {});
    }

    const cmdTs = Date.now();
    const qBot = Object.entries(liveFleet).find(([, e]) => e.quartersRoom === conn.roomId);
    const isLocal = !!qBot; // quarters-room commands are always local; BTC goes through speaker check
    const speaker = !isLocal && await electSpeaker();

    if (!isLocal && !speaker) {
      // Speaker failover: stagger by rank, then check if speaker already responded.
      // If S3 is unavailable, stay silent to avoid duplicate responses.
      const s3 = getS3Client();
      if (!s3) return;
      const myRank = findShipByHostname()?.[1]?.rank ?? 99;
      await sleep(myRank * 3_000);
      try {
        const resp = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: METRICS_ASSEMBLED_S3_KEY }));
        const chunks: Uint8Array[] = [];
        for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
        const claim = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { ts: number };
        if (claim.ts && claim.ts > cmdTs - 1_000) return; // speaker already responded
      } catch { /* no claim yet — proceed as fallback assembler */ }
    }

    // Write assembly claim so other relays know this ship is responding
    const s3ForClaim = getS3Client();
    if (s3ForClaim && !isLocal) {
      s3ForClaim.client.send(new PutObjectCommand({
        Bucket: s3ForClaim.bucket,
        Key: METRICS_ASSEMBLED_S3_KEY,
        Body: Buffer.from(JSON.stringify({ assembler: HOSTNAME, ts: Date.now() })),
        ContentType: 'application/json',
      })).catch(() => {});
    }

    // For 'all' scope: aggregate metrics from all ships via S3.
    let text: string;
    if (scope === 'all' && !isLocal) {
      await sleep(3_000); // let other ships publish their metrics
      const allSnapshots = await fetchAllMetricsSnapshots();
      // Fetch health in parallel with the already-elapsed wait
      let healthReports: Array<{ ship: string; data: Record<string, unknown> }> = [];
      if (wantsHealth) {
        healthReports = await fetchAllHealthReports();
      }
      text = allSnapshots.length > 0
        ? formatCombinedMetrics(allSnapshots, healthReports.length > 0 ? healthReports : undefined)
        : formatScopeMetrics(snapshot, scope);
    } else {
      text = formatScopeMetrics(snapshot, scope);
      // Assembler appends health summary to fleet scope output.
      if (wantsHealth && !isLocal) {
        await sleep(3_000);
        const healthReports = await fetchAllHealthReports();
        if (healthReports.length > 0) {
          text += '\n\n' + formatHealthSummary(healthReports);
        }
      }
    }

    // Post as a thread: root is the scope label, content as thread reply.
    const scopeLabel = `📊 metrics${scope !== 'all' ? ` · ${scope}` : ''}`;
    const threadRoot = await reply(conn, scopeLabel);
    if (threadRoot) {
      await threadReply(conn, threadRoot, text);
    } else {
      await reply(conn, text);
    }
  } catch (err) {
    log(`metrics: command error: ${errStr(err)}`);
    await reply(conn, `⛔ metrics failed — ${errStr(err)}`);
  }
}

// ── Register command handlers with the registry ──────────────────

function registerRelayCommands(): void {
  registerHandlers({
    report: async (cmd, conn) => {
      const parsed = parseTarget(cmd, '!report');
      if (parsed.matched) await handleLifecycleCommand('report', parsed.target, conn);
    },
    dismiss: async (cmd, conn) => {
      const parsed = parseTarget(cmd, '!dismiss');
      if (parsed.matched) await handleLifecycleCommand('dismiss', parsed.target, conn);
    },
    go: async (cmd, conn) => {
      await handleGoCommand(cmd, conn);
    },
    sleep: async (cmd, conn) => {
      const parsed = parseTarget(cmd, '!sleep');
      if (parsed.matched) await handleLifecycleCommand('sleep', parsed.target, conn);
    },
    wake: async (cmd, conn) => {
      const parsed = parseTarget(cmd, '!wake');
      if (parsed.matched) await handleLifecycleCommand('wake', parsed.target, conn);
    },

    operator: async (cmd, conn) => {
      const arg = cmd.slice('!operator'.length).trim();

      // !operator — each ship reports its own status
      if (!arg) {
        const tr = await reply(conn, `📡 operator`);
        const send = (text: string) => tr ? threadReply(conn, tr, text) : reply(conn, text);
        await send(isOperatorRelayEnabled() ? '✅ on' : '🔇 off');
        return;
      }

      const [action, targetShip] = arg.split(/\s+/, 2);

      // !operator reset [ship] — restart the operator Claude Code session
      if (action === 'reset') {
        if (targetShip && !isThisShip(targetShip)) return;
        const tr = await reply(conn, `📡 operator reset`);
        const send = (text: string) => tr ? threadReply(conn, tr, text) : reply(conn, text);
        await send('🔄 restarting operator...');
        // Fire-and-forget — orchestrates tmux restart asynchronously
        resetOperatorSession(conn).catch(err => log(`operator reset failed: ${errStr(err)}`));
        return;
      }

      if (action !== 'on' && action !== 'off') {
        if (await electSpeaker()) await helpReply(conn, `usage: !operator | !operator on [ship] | !operator off [ship] | !operator reset [ship]`);
        return;
      }
      if (targetShip && !isThisShip(targetShip)) return;

      const tr = await reply(conn, `📡 operator ${action}`);
      const send = (text: string) => tr ? threadReply(conn, tr, text) : reply(conn, text);
      try {
        const ships = loadShips();
        const me = Object.entries(ships).find(([, e]) => e.hostname === HOSTNAME);
        if (!me) { await helpReply(conn, `${thisShipName()} not in ships.json`); return; }
        me[1].operatorRelay = action === 'on';
        writeShips(ships);
        secretsGitCommit(['operator/ships.json'], `relay ${action} ${me[0]}`);
        log(`operator relay ${action}`);
        await send(action === 'on' ? '✅ on' : '🔇 off');
      } catch (err) {
        await send(`⛔ failed — ${errStr(err)}`);
      }
    },

    push: async (cmd, conn) => {
      const targetShip = cmd.slice('!push'.length).trim() || null;
      if (targetShip && !isThisShip(targetShip)) return;
      if (!targetShip && conn.roomId === curtainRoomId && !await electSpeaker()) return;
      const branch = 'main';
      const root = resolveRoot();
      const execOpts = gitOpts(root, 30_000);
      const tr = await reply(conn, `📡 push`);
      const send = (text: string) => tr ? threadReply(conn, tr, text) : reply(conn, text);
      try {
        execFileSync('git', ['push', 'origin', branch], execOpts);
        const ver = repoVersion(root);
        await send(`✅ pushed ${branch} ${ver}`);
      } catch (err) {
        log(`!push failed: ${errStr(err)}`);
        await send(`⛔ push failed — ${errStr(err)}`);
      }
    },

    metrics: async (cmd, conn) => { await handleMetricsHealth(cmd, conn); },

    decommission: async (cmd, conn) => {
      const targetShip = cmd.slice('!decommission'.length).trim() || null;
      if (targetShip && !isThisShip(targetShip)) return;
      const tr = await reply(conn, `📡 decommission`);
      const send = (text: string) => tr ? threadReply(conn, tr, text) : reply(conn, text);
      try {
        const ships = loadShips();
        const me = Object.entries(ships).find(([, e]) => e.hostname === HOSTNAME);
        if (!me) { await helpReply(conn, `${thisShipName()} not in ships.json`); return; }
        for (const bot of getActiveBots()) {
          stopBot(bot);
          killStaleContainers(bot);
          fleetUpdate(bot, { status: 'sleep', triggerType: 'never' });
        }
        me[1].commissioned = false;
        writeShips(ships);
        secretsGitCommit(['operator/ships.json'], `decommission ${me[0]}`);
        await send(`✅ decommissioned — all bots asleep`);
      } catch (err) {
        await send(`⛔ decommission failed — ${errStr(err)}`);
      }
    },

    commission: async (cmd, conn) => {
      const targetShip = cmd.slice('!commission'.length).trim() || null;
      if (targetShip && !isThisShip(targetShip)) return;
      const tr = await reply(conn, `📡 commission`);
      const send = (text: string) => tr ? threadReply(conn, tr, text) : reply(conn, text);
      try {
        const ships = loadShips();
        const me = Object.entries(ships).find(([, e]) => e.hostname === HOSTNAME);
        if (!me) { await helpReply(conn, `${thisShipName()} not in ships.json`); return; }
        me[1].commissioned = true;
        writeShips(ships);
        secretsGitCommit(['operator/ships.json'], `commission ${me[0]}`);
        ensurePodmanReady();
        const { started } = restartRunningBots(resolveRoot());
        await send(`✅ commissioned — started ${started.join(', ') || 'no bots assigned'}`);
      } catch (err) {
        await send(`⛔ commission failed — ${errStr(err)}`);
      }
    },

    pull: async (cmd, conn) => {
      const args = cmd.slice('!pull'.length).trim();
      const force = args === '--force' || args.startsWith('--force ');
      const targetShip = (force ? args.slice('--force'.length) : args).trim() || null;
      if (targetShip && !isThisShip(targetShip)) return;
      const startedAt = Date.now();

      const threadRoot = await reply(conn, `📡 pull`);
      if (!threadRoot) return;
      const elapsed = () => Date.now() - startedAt;

      const activeBots = getActiveBots();

      // Stages: sync secrets, sync code, build, bootstrap active, done
      const totalStages = 3 + activeBots.length + 1;
      let stage = 0;
      let warnings = 0;
      let errors = 0;
      const s = (text: string) => threadReply(conn, threadRoot, `[${++stage}/${totalStages} ${formatDuration(elapsed())}] ${text}`);

      try {
        const root = resolveRoot();

        const secretsResult = secretsGitSync();
        const secretsVer = repoVersion(secretsRepoPath());
        if (!secretsResult.ok) {
          warnings++;
          const link = await uploadErrorLog('secrets-sync', new Error(secretsResult.output));
          await s(stageWarn('secrets sync failed', link || secretsVer));
        } else if (secretsResult.newCommits > 0) {
          await s(stageOk(`secrets pulled ${secretsResult.newCommits} commit(s)`, secretsVer));
        } else {
          await s(stageOk('secrets up to date', secretsVer));
        }

        const icResult = gitSync(force);
        const codeVer = repoVersion(root);
        if (!icResult.ok) {
          warnings++;
          const link = await uploadErrorLog('code-sync', new Error(icResult.output));
          await s(stageWarn('code sync failed', link || codeVer));
        } else if (icResult.newCommits > 0) {
          await s(stageOk(`code pulled ${icResult.newCommits} commit(s)`, codeVer));
        } else {
          await s(stageOk('code up to date', codeVer));
        }

        const buildResult = rebuildInfiniClaw();
        if (buildResult.includes('FAILED')) {
          errors++;
          const link = await uploadErrorLog('build', new Error(buildResult));
          await s(stageFail('relay + dist rebuild', link));
          const msg = pullResult('failed', warnings, errors, elapsed());
          await s(msg);
          await reply(conn, msg);
          return;
        }
        await s(stageOk('relay + dist rebuilt', relayVersion(root)));

        // Rebuild container images for all local bots (skips if build context unchanged)
        for (const bot of activeBots) {
          try { rebuildImageIfChanged(root, bot); } catch (err) {
            warnings++;
            log(`!pull: image rebuild failed for ${bot}: ${errStr(err)}`);
          }
        }

        // Semver version gate: skip restarts if the deployed tag matches the latest tag,
        // unless --force was passed. With no semver tags yet, always restart.
        const relayDir = path.join(root, '_runtime', 'relay');
        const latestTag = getLatestSemverTag(root);
        const deployedTag = getStampedSemverTag(relayDir);
        const tagAdvanced = !latestTag || !deployedTag || latestTag !== deployedTag;
        if (!force && !tagAdvanced) {
          await s(stageOk(`version gate: ${latestTag} already deployed — skipping restarts (use !pull --force to override)`));
          persistFleet();
          await publishFleetReport().catch(() => {});
          const msg = pullResult('complete (no new version)', warnings, errors, elapsed());
          await s(msg);
          await reply(conn, msg);
          return;
        }
        if (latestTag) {
          await s(stageOk(`version gate: advancing to ${latestTag}${force ? ' (forced)' : ''}`));
        }

        if (isShipCommissioned()) {
          ensurePodmanReady();
          removeStaleProcesses();

          // Refit restarts running bots, preserving their current status
          const result = restartRunningBots(root);
          for (const bot of result.started) {
            const bEnv = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
            const status = liveFleet[bot]?.status ?? 'quarters';
            await s(stageOk(`${bEnv?.ASSISTANT_NAME || capitalizeName(bot)} restarted (${status})`));
          }
          for (const bot of result.failed) {
            errors++;
            const bEnv = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
            await s(stageFail(`${bEnv?.ASSISTANT_NAME || capitalizeName(bot)} restart`, ''));
          }
          // Report sleeping bots
          for (const bot of activeBots) {
            if (!(RUNNING_STATUSES as readonly string[]).includes(liveFleet[bot]?.status) && liveFleet[bot]?.status !== 'transit') {
              const bEnv = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
              await s(stageOk(`${bEnv?.ASSISTANT_NAME || capitalizeName(bot)} stays ${liveFleet[bot]?.status}`));
            }
          }
        } else {
          await s(stageOk('ship decommissioned — skipping bot startup'));
        }

        // Stamp deployed semver tag so next !pull can compare
        if (latestTag) {
          try {
            fs.mkdirSync(relayDir, { recursive: true });
            fs.writeFileSync(path.join(relayDir, 'SEMVER_VERSION'), `${latestTag}\n`);
          } catch { /* best effort */ }
        }

        persistFleet();
        await publishFleetReport().catch(() => {});
        const msg = pullResult('complete', warnings, errors, elapsed());
        await s(msg);
        await reply(conn, msg);
        await sleep(1_000);
        try {
          execSync(`npx pm2 restart ${process.env['INFINICLAW_PM2_NAME'] || 'infiniclaw-relay'}`, gitOpts(resolveRoot(), 10_000));
        } catch { /* pm2 restart kills us */ }
      } catch (err) {
        errors++;
        const msg = pullResult('failed', warnings, errors, elapsed());
        await threadReply(conn, threadRoot, msg);
        await reply(conn, msg);
      }
    },

    transport: async (cmd, conn) => {
      const parts = cmd.slice('!transport '.length).trim().split(/\s+/);
      if (parts.length !== 2) {
        await helpReply(conn, `Usage: !transport <bot> <ship>`);
        return;
      }
      const [botInput, shipInput] = parts;
      const bot = botInput.toLowerCase();
      if (!liveFleet[bot]) { await helpReply(conn, `Unknown bot: ${botInput}`); return; }
      let targetShip: string; // hostname for fleet.json
      let targetName: string; // display name
      try {
        const ships = loadShips();
        const resolved = resolveShipName(shipInput, ships);
        if (!resolved) { await helpReply(conn, `Unknown ship: ${shipInput}`); return; }
        targetName = resolved;
        targetShip = ships[resolved].hostname;
        if (!ships[resolved].commissioned) { await reply(conn, `⛔ ${targetName} decommissioned — use !commission first`); return; }
      } catch { targetShip = shipInput; targetName = shipInput; }
      if (liveFleet[bot].ship !== HOSTNAME) return;
      const botEnv = (() => { try { return loadProfileEnv(resolveRoot(), bot); } catch { return null; } })();
      const botDisplayName = botEnv?.ASSISTANT_NAME || capitalizeName(bot);
      const tr = await reply(conn, `📡 transport ${botDisplayName} → ${targetName}`);
      const send = (text: string) => tr ? threadReply(conn, tr, text) : reply(conn, text);
      try {
        stopBot(bot);
        killStaleContainers(bot);
        removeBotMounts(bot);
        fleetUpdate(bot, { status: 'transit', triggerType: 'never', ship: targetShip });
        fleetDirty = true;
        persistFleet();
        await send(`✅ ${botDisplayName} dematerialized — awaiting materialization on ${targetName}`);
      } catch (err) {
        await send(`⛔ transport failed — ${errStr(err)}`);
      }
    },

    promote: async (cmd, conn, allConns) => {
      await handleRank(cmd, conn, allConns, true);
    },
    demote: async (cmd, conn, allConns) => {
      await handleRank(cmd, conn, allConns, false);
    },

    fleet: async (cmd, conn) => {
      try {
        // Every relay publishes its own report to S3, then the lowest-rank available relay
        // assembles and responds. FLEET_ASSEMBLED_S3_KEY is used as a coordination lock so
        // only one relay posts the assembled view even when the elected speaker is down.
        const cmdTs = Date.now();
        const [report, isSpeaker] = await Promise.all([publishFleetReport(), electSpeaker()]);
        const s3 = getS3Client();

        if (!isSpeaker) {
          // Non-speaker: stagger by ship rank so the speaker gets first crack.
          // If S3 is unavailable, stay silent (can't coordinate — risk of duplicates).
          if (!s3) return;
          const myRank = findShipByHostname()?.[1]?.rank ?? 99;
          await sleep(myRank * 3_000);
          // Check if another relay already assembled (fresh claim within 30s of this command)
          try {
            const resp = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: FLEET_ASSEMBLED_S3_KEY }));
            const chunks: Uint8Array[] = [];
            for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
            const claim = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { ts: number };
            if (claim.ts && claim.ts > cmdTs - 1_000) return; // already assembled
          } catch { /* no claim yet — proceed as fallback assembler */ }
        }

        // Fleet health grade computed after assembling all reports
        let threadRoot: string | undefined;

        const ships = safeLoadShips();
        const allShipNames = Object.keys(ships);

        // Write assembly claim to S3 so other relays know someone is assembling
        if (s3) {
          s3.client.send(new PutObjectCommand({
            Bucket: s3.bucket,
            Key: FLEET_ASSEMBLED_S3_KEY,
            Body: Buffer.from(JSON.stringify({ assembler: HOSTNAME, ts: Date.now() })),
            ContentType: 'application/json',
          })).catch(() => {});
        }

        // Poll S3 for fresh reports (up to 5s), then read stale as fallback
        const freshReports: Record<string, FleetReport> = { [thisShipName()]: report };
        const staleReports: Record<string, FleetReport> = {};
        if (s3 && allShipNames.length > 1) {
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            const missing = allShipNames.filter(s => !freshReports[s]);
            if (missing.length === 0) break;
            await sleep(500);
            for (const shipName of missing) {
              try {
                const resp = await s3.client.send(new GetObjectCommand({
                  Bucket: s3.bucket,
                  Key: `${FLEET_S3_PREFIX}/${shipName}.json`,
                }));
                const chunks: Uint8Array[] = [];
                for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
                const data = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as FleetReport;
                if (data.ts && Date.now() - data.ts < 10_000) {
                  freshReports[data.ship] = data;
                } else if (data.ts) {
                  staleReports[data.ship] = data;
                }
              } catch { /* not available */ }
            }
          }
        }

        // Merge: fresh reports win, then stale, then liveFleet fallback
        const allReports: Record<string, FleetReport> = { ...staleReports, ...freshReports };

        // Assemble output
        const allBots: Record<string, FleetEntry & { name: string; gitVersion: string; semver?: string; localStatus: string; grade?: string; activity?: string; tokPerDay?: number }> = {};
        for (const [botId, entry] of Object.entries(liveFleet)) {
          allBots[botId] = { ...entry, name: capitalizeName(botId), gitVersion: '', localStatus: entry.status };
        }
        for (const [, shipReport] of Object.entries(allReports)) {
          for (const [botId, botData] of Object.entries(shipReport.bots)) {
            if (allBots[botId]) {
              allBots[botId].name = botData.name;
              allBots[botId].gitVersion = botData.gitVersion;
              allBots[botId].semver = botData.semver;
              allBots[botId].localStatus = botData.status;
              allBots[botId].grade = botData.grade;
              allBots[botId].activity = botData.activity;
              allBots[botId].tokPerDay = botData.tokPerDay;
            }
          }
        }

        // Group by ship (resolve hostname → ship name)
        const hostnameToName: Record<string, string> = {};
        for (const [sName, sEntry] of Object.entries(ships)) hostnameToName[sEntry.hostname] = sName;
        const byShip: Record<string, Array<[string, typeof allBots[string]]>> = {};
        for (const [botId, entry] of Object.entries(allBots)) {
          const s = (entry.ship && hostnameToName[entry.ship]) || entry.ship || 'drydock';
          (byShip[s] ??= []).push([botId, entry]);
        }
        for (const s of Object.keys(ships)) { byShip[s] ??= []; }

        // Compute aggregate fleet health grade
        const botGrades = Object.values(allBots)
          .filter(b => b.localStatus !== 'sleep' && b.localStatus !== 'transit' && b.grade)
          .map(b => b.grade as HealthGrade);
        const fleetGrade = botGrades.length > 0 ? computeFleetHealthGrade(botGrades) : 'A' as HealthGrade;
        const fleetTokPerDay = Object.values(allBots).reduce((sum, b) => sum + (b.tokPerDay ?? 0), 0);
        threadRoot = await reply(conn, `🌌InfiniClaw00·${gradeEmoji(fleetGrade)}${fleetGrade}${activityEmoji(fleetTokPerDay)}`);

        const shipOrder = Object.keys(byShip).sort((a, b) => {
          if (a === 'drydock') return 1;
          if (b === 'drydock') return -1;
          return (ships[a]?.rank ?? 99) - (ships[b]?.rank ?? 99);
        });

        // Global max name length for consistent alignment across all ships
        const globalMaxNameLen = Object.values(allBots).reduce(
          (max, e) => Math.max(max, capitalizeName(e.name).length), 0,
        );

        const lines: string[] = [];
        for (const shipName of shipOrder) {
          const sConfig = ships[shipName];
          const shipReport = allReports[shipName];

          const bots = byShip[shipName].sort((a, b) => a[1].rank - b[1].rank);

          if (shipName === 'drydock') {
            lines.push('🔧 drydock');
          } else {
            const rank = sConfig?.rank ?? 99;
            const commissioned = sConfig?.commissioned !== false;
            const isThisShipSpeaker = commissioned && isSpeakerCached && sConfig?.rank != null &&
              Object.values(ships).filter(s => s.commissioned).every(s => (s.rank ?? 99) >= (sConfig?.rank ?? 99));
            // Aggregate ship health (worst grade) and throughput (sum)
            const gradeOrder = ['A', 'B', 'C', 'F'];
            let worstGrade = 'A';
            let shipTok = 0;
            for (const [, entry] of bots) {
              if (entry.grade && gradeOrder.indexOf(entry.grade) > gradeOrder.indexOf(worstGrade)) {
                worstGrade = entry.grade;
              }
              shipTok += entry.tokPerDay ?? 0;
            }
            lines.push(unifiedShipDisplay({
              name: shipName,
              emoji: sConfig?.emoji ?? '',
              typeEmoji: sConfig?.typeEmoji ?? '',
              type: sConfig?.type ?? '',
              rank,
              isSpeaker: isThisShipSpeaker,
              commissioned,
              health: worstGrade,
              tokPerDay: shipTok,
            }, 'short'));
          }

          // Warn when a commissioned ship has active bots but no health report — relay likely offline (#135)
          const hasReport = shipName in allReports;
          const hasActiveBots = bots.some(([, e]) =>
            e.localStatus !== 'sleep' && e.localStatus !== 'dream' && e.localStatus !== 'transit',
          );
          if (!hasReport && hasActiveBots && sConfig?.commissioned !== false && shipName !== thisShipName()) {
            lines.push(`  ⚠️ relay offline — bots may be unreachable`);
          }

          // Build flat list for CO detection — per duty room (design: 12-co.md)
          const allBotList = Object.entries(allBots).map(([name, e]) => ({ name, role: e.role, rank: e.rank, status: e.localStatus }));

          for (const [idx, [, entry]] of bots.entries()) {
            const role = entry.role?.toLowerCase() ?? '';
            const roleRoom = ROLE_ROOMS[role];
            const co = findRoomChief(roleRoom?.room ?? '', allBotList) === entry.name;
            // Location: onduty → duty room, everything else → quarters
            const isOnDuty = entry.localStatus === 'onduty';
            const locEmoji = isOnDuty ? (roleRoom?.icon ?? '') : '🏠';
            const isSleeping = entry.localStatus === 'sleep' || entry.localStatus === 'dream';
            const isLast = idx === bots.length - 1;
            const tree = isLast ? '└ ' : '├ ';
            const botLine = unifiedBotDisplay(buildBotDisplayParams(entry.name, {
              shipEmoji: '',
              status: entry.localStatus,
              health: entry.grade || (isSleeping ? 'A' : ''),
              tokPerDay: entry.tokPerDay ?? 0,
              version: entry.semver || undefined,
            }), 'short', globalMaxNameLen);
            lines.push(`${tree}${botLine}`);
          }
        }

        // Add blank lines between ship groups for readability
        const spaced = lines.reduce<string[]>((acc, line, i) => {
          // Insert blank line before ship headers (lines that don't start with tree chars), skip first
          if (i > 0 && !line.startsWith('├') && !line.startsWith('└') && !line.startsWith('  ⚠')) acc.push('');
          acc.push(line);
          return acc;
        }, []);

        // Concise summary footer
        const allBotEntries = Object.values(allBots);
        const awake = allBotEntries.filter(b => b.localStatus !== 'sleep' && b.localStatus !== 'dream' && b.localStatus !== 'transit');
        const ondutyCount = allBotEntries.filter(b => b.localStatus === 'onduty').length;
        const sleepCount = allBotEntries.filter(b => b.localStatus === 'sleep' || b.localStatus === 'dream').length;
        const warnCount = allBotEntries.filter(b => b.localStatus === 'warn').length;
        const totalTok = allBotEntries.reduce((sum, b) => sum + (b.tokPerDay ?? 0), 0);
        const parts = [`${allBotEntries.length} bots`, `${ondutyCount} onduty`, `${sleepCount} asleep`];
        if (warnCount > 0) parts.push(`⚠️${warnCount} warn`);
        parts.push(`${fmtTok(totalTok)} tok/d`);
        spaced.push('', `**Fleet** · ${parts.join(' · ')}`);

        if (threadRoot) await threadReply(conn, threadRoot, spaced.join('\n'));
      } catch (err) {
        await reply(conn, `⛔ fleet failed — ${errStr(err)}`);
      }
    },

    todo: async (cmd, conn) => {
      const target = cmd.slice('!todo'.length).trim().toLowerCase() || null;
      const root = resolveRoot();
      const local = getActiveBots();
      const bots = target ? local.filter(b => b === target) : local;
      if (bots.length === 0) return; // not on this ship
      const threadRoot = await reply(conn, `📋 Todo${target ? ` — ${target}` : ''}`);
      if (!threadRoot) return;

      // Load active Branch Brain tasks for deep-link annotation
      const branchTasks = readBranchTasks();
      const homeserverDomain = conn.homeserver.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

      const lines: string[] = [];
      for (const bot of bots) {
        const env = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
        const name = env?.ASSISTANT_NAME || capitalizeName(bot);
        lines.push(`📋 **${name}**`);

        // Active (non-completed) threads dispatched by this bot
        const botThreadEntries = Object.entries(branchTasks).filter(([, t]) => (!t.bot || t.bot === bot) && !t.completed);

        // Read actual todos from most recently modified session todos file
        const todosDir = path.join(root, '_runtime', 'instances', bot, 'data', 'sessions', 'main', '.claude', 'todos');
        try {
          const files = fs.readdirSync(todosDir)
            .map(f => ({ f, mtime: fs.statSync(path.join(todosDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
          if (files.length > 0) {
            const raw = JSON.parse(fs.readFileSync(path.join(todosDir, files[0].f), 'utf-8'));
            const todos: Array<{ content: string; status: string; priority: string }> = Array.isArray(raw) ? raw : [];
            if (todos.length === 0) {
              lines.push('No todos');
            } else {
              const linkedThreadIds = new Set<string>();
              for (const t of todos) {
                const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜';
                // Annotate in-progress items with matrix.to link if a matching thread exists
                let link = '';
                if (t.status === 'in_progress' && botThreadEntries.length > 0) {
                  const contentLower = t.content.toLowerCase();
                  const match = botThreadEntries.find(([, task]) => {
                    const objLower = task.objective.toLowerCase();
                    return objLower.includes(contentLower) || contentLower.includes(objLower.split('\n')[0].slice(0, 40).trim());
                  });
                  if (match) {
                    const [tid, task] = match;
                    linkedThreadIds.add(tid);
                    const via = homeserverDomain ? `?via=${homeserverDomain}` : '';
                    link = ` [🧵](https://matrix.to/#/${encodeURIComponent(task.chat_jid)}/${encodeURIComponent(tid)}${via})`;
                  }
                }
                lines.push(`${icon} ${t.content}${link}`);
              }
              // Show any unlinked active threads below todos
              const unlinked = botThreadEntries.filter(([tid]) => !linkedThreadIds.has(tid));
              if (unlinked.length > 0) {
                lines.push('🧵 Active threads:');
                for (const [tid, task] of unlinked) {
                  const title = task.objective.split('\n')[0].trim().slice(0, 60);
                  const via = homeserverDomain ? `?via=${homeserverDomain}` : '';
                  lines.push(`  → [${title}](https://matrix.to/#/${encodeURIComponent(task.chat_jid)}/${encodeURIComponent(tid)}${via})`);
                }
              }
            }
          } else {
            lines.push('No todos');
          }
        } catch {
          // Fall back to status.json objective if todos dir unavailable
          const room = botDutyRoom(bot);
          const statusPath = path.join(root, '_runtime', 'data', 'ipc', room, 'status.json');
          try {
            const snap = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
            const g = snap.groups?.find((s: { folder: string }) => s.folder === room);
            const objective = g?.lastProgress || g?.currentObjective;
            lines.push(g?.active ? `Currently: ${objective ? objective.slice(0, 200) : 'working'}` : 'idle');
          } catch { lines.push('unknown'); }
        }
        lines.push('');
      }
      await threadReply(conn, threadRoot, lines.join('\n').trim());
    },

    wbs: async (cmd, conn) => {
      // !wbs [room]      — show Work Breakdown Structure for a duty room.
      // !wbs x <id>      — mark item <id> done (completes item, unblocks dependents).
      // Defaults to the current room. Only duty rooms have WBS files.
      const arg = cmd.slice('!wbs'.length).trim();
      const dutyRooms = Object.values(ROLE_ROOMS).map(r => r.room);

      // !wbs x <id> — complete an item by ID
      const xMatch = arg.match(/^x\s+(\S+)$/i);
      if (xMatch) {
        if (!await electSpeaker()) return;
        const itemId = xMatch[1];
        const dataDir = path.join(resolveRoot(), '_runtime', 'data');
        // Search all duty rooms for the item
        let found = false;
        for (const r of dutyRooms) {
          const wbs = readWbs(dataDir, r);
          const item = wbs.items.find(i => i.id === itemId);
          if (item) {
            const unblocked = completeItem(wbs, itemId);
            writeWbs(dataDir, r, wbs);
            const unblockedMsg = unblocked.length > 0 ? ` — unblocked: ${unblocked.join(', ')}` : '';
            await reply(conn, `✅ WBS ${itemId} done${unblockedMsg}`);
            found = true;
            break;
          }
        }
        if (!found) await reply(conn, `⚠️ WBS item "${itemId}" not found`);
        return;
      }

      // Resolve room: explicit arg, or infer from conn.name
      let room = arg.toLowerCase() || conn.name.toLowerCase();
      if (!dutyRooms.includes(room)) {
        // BehindTheCurtain or non-duty room: require explicit room arg
        if (!arg) {
          if (await electSpeaker()) await reply(conn, `📋 WBS — specify a duty room: ${dutyRooms.join(', ')}`);
          return;
        }
        if (!dutyRooms.includes(arg)) {
          if (await electSpeaker()) await reply(conn, `⚠️ No WBS for "${arg}" — duty rooms: ${dutyRooms.join(', ')}`);
          return;
        }
        room = arg;
      }

      if (!await electSpeaker()) return;
      const dataDir = path.join(resolveRoot(), '_runtime', 'data');
      const wbs = readWbs(dataDir, room);

      if (wbs.items.length === 0) {
        await reply(conn, `📋 WBS ${room} — empty`);
        return;
      }

      const STATUS_ICON: Record<string, string> = { done: '✅', in_progress: '🔄', ready: '⬜', backlog: '📥' };
      const lines: string[] = [];
      // Group by status for readability
      for (const status of ['in_progress', 'ready', 'backlog', 'done'] as const) {
        const items = wbs.items.filter(i => i.status === status);
        if (items.length === 0) continue;
        for (const item of items.sort((a, b) => a.priority - b.priority)) {
          const icon = STATUS_ICON[item.status] ?? '❓';
          const assignee = item.assigned_to ? ` → ${capitalizeName(item.assigned_to)}` : '';
          const deps = item.depends_on.length > 0 ? ` [deps: ${item.depends_on.join(',')}]` : '';
          lines.push(`${icon} **${item.id}** ${item.title}${assignee}${deps}`);
        }
      }

      const threadRoot = await reply(conn, `📋 WBS ${room} — ${wbs.items.length} items`);
      if (threadRoot) await threadReply(conn, threadRoot, lines.join('\n'));
    },

    allow: async (cmd, conn) => {
      // Try 3-arg form: !allow <bot> <path> [minutes]
      let match = cmd.match(/^!allow\s+(\S+)\s+(\S+)(?:\s+(\d+))?$/);
      let botName: string, hostPath: string, mins: string | undefined;
      if (match) {
        [, botName, hostPath, mins] = match;
        // If botName looks like a path, re-parse as 2-arg (infer bot from quarters)
        if (botName.startsWith('/') || botName.startsWith('~') || botName.startsWith('.')) {
          const qBot = Object.entries(liveFleet).find(([, e]) => e.quartersRoom === conn.roomId);
          if (!qBot) { await helpReply(conn, 'Usage: !allow <bot> <path> [minutes]'); return; }
          // Re-parse: botName is actually path, hostPath is actually minutes
          mins = hostPath.match(/^\d+$/) ? hostPath : undefined;
          hostPath = botName;
          botName = qBot[0];
        }
      } else {
        // Try 2-arg form from quarters: !allow <path> [minutes]
        const m2 = cmd.match(/^!allow\s+(\S+)(?:\s+(\d+))?$/);
        if (!m2) { await helpReply(conn, 'Usage: !allow <bot> <path> [minutes]'); return; }
        const qBot = Object.entries(liveFleet).find(([, e]) => e.quartersRoom === conn.roomId);
        if (!qBot) { await helpReply(conn, 'Usage: !allow <bot> <path> [minutes]'); return; }
        [, hostPath, mins] = m2;
        botName = qBot[0];
      }
      const local = getActiveBots();
      const allowEnv = (() => { try { return loadProfileEnv(resolveRoot(), botName.toLowerCase()); } catch { return null; } })();
      if (!local.includes(botName.toLowerCase())) {
        await helpReply(conn, `${allowEnv?.ASSISTANT_NAME || capitalizeName(botName)} is not on this ship`);
        return;
      }
      const defaultDuration = 30;
      const parsedDuration = parseInt(mins ?? String(defaultDuration), 10);
      let duration = parsedDuration <= 0 ? defaultDuration : parsedDuration;
      if (duration > 1440) duration = 1440;
      try {
        grantMount(botName.toLowerCase(), hostPath, duration);
        const expiry = new Date(Date.now() + duration * 60 * 1000).toLocaleTimeString();
        await reply(conn, `📡 mount granted to ${allowEnv?.ASSISTANT_NAME || capitalizeName(botName)}: ${hostPath} (rw, expires ~${expiry}) — restart required`);
      } catch (err) {
        await reply(conn, `⛔ allow failed — ${errStr(err)}`);
      }
    },

    deny: async (cmd, conn) => {
      // Try 2-arg form: !deny <bot> <path>
      let match = cmd.match(/^!deny\s+(\S+)\s+(\S+)$/);
      let botName: string, hostPath: string;
      if (match) {
        [, botName, hostPath] = match;
        if (botName.startsWith('/') || botName.startsWith('~') || botName.startsWith('.')) {
          const qBot = Object.entries(liveFleet).find(([, e]) => e.quartersRoom === conn.roomId);
          if (!qBot) { await helpReply(conn, 'Usage: !deny <bot> <path>'); return; }
          hostPath = botName;
          botName = qBot[0];
        }
      } else {
        // Try 1-arg form from quarters: !deny <path>
        const m1 = cmd.match(/^!deny\s+(\S+)$/);
        if (!m1) { await helpReply(conn, 'Usage: !deny <bot> <path>'); return; }
        const qBot = Object.entries(liveFleet).find(([, e]) => e.quartersRoom === conn.roomId);
        if (!qBot) { await helpReply(conn, 'Usage: !deny <bot> <path>'); return; }
        [, hostPath] = m1;
        botName = qBot[0];
      }
      const local = getActiveBots();
      const denyEnv = (() => { try { return loadProfileEnv(resolveRoot(), botName.toLowerCase()); } catch { return null; } })();
      if (!local.includes(botName.toLowerCase())) {
        await helpReply(conn, `${denyEnv?.ASSISTANT_NAME || capitalizeName(botName)} is not on this ship`);
        return;
      }
      try {
        const removed = revokeMount(botName.toLowerCase(), hostPath);
        await reply(conn, `📡 ${denyEnv?.ASSISTANT_NAME || capitalizeName(botName)} ${removed ? `mount revoked: ${hostPath}` : `no mount found: ${hostPath}`}`);
      } catch (err) {
        await reply(conn, `⛔ deny failed — ${errStr(err)}`);
      }
    },

    version: async (cmd, conn) => {
      if (!await electSpeaker()) return;
      const arg = cmd.slice('?version'.length).trim();
      const count = Math.min(Math.max(parseInt(arg, 10) || 10, 1), 50);
      const root = resolveRoot();
      try {
        // Get the N most recent version tags with their one-line messages
        const raw = execSync(
          `git tag -l 'v*' --sort=-v:refname --format='%(refname:short) %(subject)' | head -${count}`,
          { cwd: root, encoding: 'utf-8', timeout: 10000 },
        ).trim();
        if (!raw) {
          await reply(conn, '📦 no version tags found');
          return;
        }
        const lines = raw.split('\n').map(line => {
          const spaceIdx = line.indexOf(' ');
          const tag = spaceIdx > 0 ? line.slice(0, spaceIdx) : line;
          const msg = spaceIdx > 0 ? line.slice(spaceIdx + 1) : '';
          return `\`${tag}\` ${msg}`;
        });
        const threadRoot = await reply(conn, `📦 last ${lines.length} version${lines.length !== 1 ? 's' : ''}`);
        if (threadRoot) await threadReply(conn, threadRoot, lines.join('\n'));
      } catch (err) {
        await reply(conn, `⛔ version failed — ${errStr(err)}`);
      }
    },
  });
}

/** Shared promote/demote handler */
async function handleRank(cmd: string, conn: RoomConn, allConns: RoomConn[], isPromote: boolean): Promise<void> {
  const direction = isPromote ? 'up' : 'down';
  const verb = isPromote ? 'promote' : 'demote';
  const rawTarget = cmd.slice(isPromote ? '!promote '.length : '!demote '.length).trim();

  // Try ship name first (case-insensitive)
  const ships = safeLoadShips();
  const shipName = Object.keys(ships).length > 0 ? resolveShipName(rawTarget, ships) : null;
  if (shipName) {
    const target = shipName;
    if (!await electSpeaker()) return;
    const tr = await reply(conn, `📡 ${verb} ${target}`);
    const send = (text: string) => tr ? threadReply(conn, tr, text) : reply(conn, text);
    const result = rankSwap(Object.entries(ships), target, direction);
    if (!result) {
      await send(`📡 ${target} already ${isPromote ? 'highest' : 'lowest'} rank ship`);
      return;
    }
    writeShips(ships);
    secretsGitCommit(['operator/ships.json'], `rerank ships: ${result.target} #${result.targetRank}, ${result.swap} #${result.swapRank}`);
    await send(formatRerankShipMsg(result.target, result.targetRank, result.swap, result.swapRank));
    return;
  }

  const target = rawTarget.toLowerCase();
  const local = getActiveBots();
  if (!local.includes(target)) return;
  if (!liveFleet[target]) { await helpReply(conn, `Unknown bot: ${rawTarget}`); return; }
  const root = resolveRoot();
  const botEnv = (() => { try { return loadProfileEnv(root, target); } catch { return null; } })();
  const botDisplayName = botEnv?.ASSISTANT_NAME || capitalizeName(target);
  const tr = await reply(conn, `📡 ${verb} ${botDisplayName}`);
  const send = (text: string) => tr ? threadReply(conn, tr, text) : reply(conn, text);
  const role = liveFleet[target].role;
  const sameRole = Object.entries(liveFleet).filter(([_, b]) => b.role === role);
  const result = rankSwap(sameRole, target, direction);
  if (!result) {
    await send(`📡 ${botDisplayName} already ${isPromote ? 'highest' : 'lowest'} rank in ${role}`);
    return;
  }
  fleetUpdate(result.target, { rank: result.targetRank });
  fleetUpdate(result.swap, { rank: result.swapRank });
  fleetDirty = true;
  persistFleet();
  const swapEnv = (() => { try { return loadProfileEnv(root, result.swap); } catch { return null; } })();
  const swapDisplayName = swapEnv?.ASSISTANT_NAME || capitalizeName(result.swap);
  await send(formatRerankBotMsg(botDisplayName, result.targetRank, swapDisplayName, result.swapRank, role));

  const botRoom = botDutyRoom(target);

  const targetConn = allConns.find(c => c.name === botRoom) || conn;
  if (targetConn.accessToken) {
    await reply(targetConn, formatRerankNotification(botDisplayName, result.targetRank));
    await reply(targetConn, formatRerankNotification(swapDisplayName, result.swapRank));
  }
  sendLifecycleMsg(target, 'reranked', result.targetRank).catch(() => {});
  sendLifecycleMsg(result.swap, 'reranked', result.swapRank).catch(() => {});
}

async function handleCommand(cmd: string, conn: RoomConn, allConns?: RoomConn[]): Promise<void> {
  // ! (bare) — print help via help account (speaker only, one reply)

  if (cmd === '!' || cmd === '?') {
    if (!await electSpeaker()) return;
    await helpReply(conn, buildHelpText());
    return;
  }
  const matched = await dispatch(cmd, conn, allConns || []);
  if (!matched) {
    const cmdName = cmd.split(/\s/)[0];
    await helpReply(conn, `Unknown command: \`${cmdName}\`. Use \`!\` or \`?\` for help.`);
  }
}

/** Build the ship tag for relay replies. ⭐ when speaker, otherwise shipTag default (/💤). */
function replyTag(): string {
  return shipTag(undefined, isSpeakerCached ? '⭐' : undefined);
}

async function reply(conn: RoomConn, text: string, threadRootId?: string, opts?: { skipMirror?: boolean }): Promise<string | undefined> {
  const tagged = `[${replyTag()}] ${text}`;
  const ls = loadLoudspeakerConfig();
  let eventId: string | undefined;
  if (ls) {
    const token = await getLoudspeakerToken(ls.homeserver, ls.username, ls.password);
    if (token) {
      eventId = await relaySend(ls.homeserver, token, conn.roomId, tagged, threadRootId);
      if (eventId) {
        // Mirror non-thread command output to BehindTheCurtain
        if (!threadRootId && !opts?.skipMirror && curtainRoomId && conn.roomId !== curtainRoomId) {
          relaySend(ls.homeserver, token, curtainRoomId, tagged).catch(() => {});
        }
        return eventId;
      }
      // Loudspeaker send failed (e.g. not in BTC room) — fall through to conn.accessToken
    }
  }
  if (!conn.accessToken) return undefined;
  return relaySend(conn.homeserver, conn.accessToken, conn.roomId, tagged, threadRootId);
}

/** Reply via the help account (for help text, unknown command errors).
 *  Falls back to loudspeaker if help account is not configured yet. */
async function helpReply(conn: RoomConn, text: string): Promise<string | undefined> {
  const tagged = `[${replyTag()}] ${text}`;
  const hc = loadHelpConfig();
  if (hc) {
    const token = await getHelpToken(hc.homeserver, hc.username, hc.password);
    if (token) {
      const eventId = await relaySend(hc.homeserver, token, conn.roomId, tagged);
      if (eventId) return eventId;
    }
  }
  // Fall back to loudspeaker → operator account (e.g. help account not in BTC)
  return reply(conn, text);
}

/** Reply in a thread. Thread steps omit [shipTag] — the thread root already identifies the ship. */
async function threadReply(conn: RoomConn, threadRootId: string, text: string): Promise<string | undefined> {
  const ls = loadLoudspeakerConfig();
  if (ls) {
    const token = await getLoudspeakerToken(ls.homeserver, ls.username, ls.password);
    if (token) {
      const eventId = await relaySend(ls.homeserver, token, conn.roomId, text, threadRootId);
      if (eventId) return eventId;
      // Loudspeaker not in room (e.g. BTC) — fall through to conn.accessToken
    }
  }
  if (!conn.accessToken) return undefined;
  return relaySend(conn.homeserver, conn.accessToken, conn.roomId, text, threadRootId);
}

/** Ship report — every ship that receives the command replies with its own data. */
async function shipReport(conn: RoomConn, text: string): Promise<string | undefined> {
  return reply(conn, text);
}

/** Speaker report — only the elected speaker replies, avoiding duplicate aggregates. */
async function speakerReport(conn: RoomConn, text: string): Promise<string | undefined> {
  if (!await electSpeaker()) return undefined;
  return reply(conn, text);
}

// ── BehindTheCurtain — direct operator chat ────────────────────────

/** Watch BehindTheCurtain using the @operator account. Every Captain message
 *  is piped verbatim to the 'operator' tmux session, creating a seamless
 *  direct chat between the Captain and the active operator instance. */
async function curtainLoop(captainUserId: string): Promise<void> {
  const opFile = path.join(secretsRepoPath(), 'operator', 'operator-matrix.json');
  let opConfig: { homeserver: string; accessToken: string; userId: string; rooms?: Record<string, string> };
  try {
    opConfig = JSON.parse(fs.readFileSync(opFile, 'utf-8'));
  } catch {
    log('curtain: operator-matrix.json not found — skipping BehindTheCurtain');
    return;
  }

  const roomId = opConfig.rooms?.['BehindTheCurtain'];
  if (!roomId) {
    log('curtain: no BehindTheCurtain room configured — skipping');
    return;
  }

  // Build roomId → room name lookup from intercom config so commands from
  // non-BTC rooms (e.g. engineering) resolve correctly in resolveBots.
  const roomIdToName: Record<string, string> = {};
  const intercom = loadIntercomConfig();
  if (intercom) {
    for (const [name, room] of Object.entries(intercom.rooms)) {
      roomIdToName[room.roomId] = name;
    }
  }

  // Build set of room IDs this relay instance manages — for cross-fleet isolation.
  // Only process commands from: BTC, intercom rooms, and quarters rooms of bots in this fleet.
  const knownRoomIds = new Set<string>([roomId]); // BTC
  for (const rid of Object.keys(roomIdToName)) knownRoomIds.add(rid); // intercom rooms
  for (const entry of Object.values(liveFleet)) {
    if (entry.quartersRoom) knownRoomIds.add(entry.quartersRoom); // quarters rooms
  }

  const { homeserver, accessToken, userId } = opConfig;
  if (!accessToken || !userId) {
    log('curtain: missing accessToken or userId in operator-matrix.json — skipping');
    return;
  }

  curtainRoomId = roomId;
  log(`curtain: watching BehindTheCurtain as ${userId}`);

  const filterId = await matrixCreateFilter(homeserver, accessToken, userId).catch(() => null);
  // Resume from persisted token so commands sent during restart are replayed
  let syncToken: string | null = loadSyncToken('curtain');
  let retryDelay = RETRY_DELAY_BASE;

  // Initial sync: if no saved token, skip old messages; otherwise resume from saved token
  while (!syncToken) {
    try {
      const initial = await matrixSync(homeserver, accessToken, null, filterId, 0);
      syncToken = initial.next_batch;
      saveSyncToken('curtain', syncToken);
      log('curtain: initial sync done, watching for Captain messages');
      retryDelay = RETRY_DELAY_BASE;
    } catch (err) {
      log(`curtain: initial sync failed (retry in ${Math.round(retryDelay / 1000)}s): ${errStr(err)}`);
      await sleep(retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_DELAY_MAX);
    }
  }

  while (true) {
    try {
      const data = await matrixSync(homeserver, accessToken, syncToken, filterId, SYNC_TIMEOUT);
      syncToken = data.next_batch;
      saveSyncToken('curtain', syncToken);
      retryDelay = RETRY_DELAY_BASE;

      const joinedRooms = data.rooms?.join;
      if (!joinedRooms) continue;

      for (const [rid, roomData] of Object.entries(joinedRooms)) {
        for (const event of (roomData as any).timeline?.events || []) {
          // Cache bot message event IDs for score reaction enrichment
          if (event.type === 'm.room.message' && event.event_id && event.sender) {
            const botName = botUserIdMap.get(event.sender);
            if (botName) {
              recentBotEventIds.set(event.event_id, botName);
              // Cap cache at 500 entries
              if (recentBotEventIds.size > 500) {
                const oldest = recentBotEventIds.keys().next().value;
                if (oldest) recentBotEventIds.delete(oldest);
              }
            }
          }
          // Record operator messages for metrics (before any filtering)
          if (event.type === 'm.room.message' && event.content?.msgtype === 'm.text' && event.content?.body) {
            recordOperatorMessage(event.sender, rid, String(event.content.body), event.origin_server_ts ?? Date.now());
          }
          // Record scoring reactions for metrics — resolve bot name from cached event IDs
          if (event.type === 'm.reaction') {
            const relates = event.content?.['m.relates_to'];
            if (relates?.key) {
              const botName = recentBotEventIds.get(relates.event_id) ?? '';
              recordScoreReaction(event.sender, relates.key, botName, event.origin_server_ts ?? Date.now());
            }
          }

          if (event.type !== 'm.room.message') continue;
          if (event.content?.msgtype !== 'm.text') continue;
          // Skip own non-command messages (operator commands should still be processed)
          if (event.sender === userId && !event.content.body?.trim()?.startsWith('!') && !event.content.body?.trim()?.startsWith('?')) continue;
          const body = event.content.body?.trim();
          if (!body) continue;

          // 📡 — relay received acknowledgement for Captain messages
          if (event.sender === captainUserId && event.event_id) {
            relayAck(homeserver, accessToken, rid, event.event_id);
          }

          // Mention-wake: mention of a sleeping bot in any room wakes it.
          // Matches: <m>Name</m> in body, @Name in body, or mention pill in formatted_body.
          const formattedBody = event.content.formatted_body as string || '';
          for (const [bot, entry] of Object.entries(liveFleet)) {
            if (entry.status !== 'sleep' || entry.ship !== HOSTNAME) continue;
            const name = capitalizeName(bot);
            const escaped = escapeRegex(name);
            const mentioned =
              new RegExp(`<m>${escaped}</m>`, 'i').test(body) ||
              new RegExp(`@${escaped}\\b`, 'i').test(body) ||
              new RegExp(`matrix\\.to/#/@${bot}[^"]*">${escaped}`, 'i').test(formattedBody);
            if (mentioned) {
              log(`mention-wake: ${name} triggered by ${event.sender} in ${rid}`);
              const wakeConn: RoomConn = {
                name: 'mention-wake', roomId: rid, homeserver,
                username: '', password: '', accessToken, syncToken, filterId, userId,
              };
              try {
                await handleLifecycleCommand('wake', bot, wakeConn);
              } catch (err) {
                log(`mention-wake: ${name} failed: ${errStr(err)}`);
              }
            }
          }

          // !/?  commands — only from rooms this relay manages (cross-fleet isolation)
          if ((body.startsWith('!') || body.startsWith('?')) && knownRoomIds.has(rid) && isAuthorized(event.sender, captainUserId, userId) && markProcessed(event.event_id)) {
            const cmdConn: RoomConn = {
              name: rid === roomId ? 'BehindTheCurtain' : (roomIdToName[rid] ?? `operator:${rid}`),
              roomId: rid, homeserver,
              username: '', password: '', accessToken, syncToken, filterId, userId,
            };
            log(`${cmdConn.name}: command from ${event.sender}: ${body.slice(0, 80)}`);
            try {
              await handleCommand(body, cmdConn, []);
            } catch (err) {
              log(`${cmdConn.name}: command error: ${errStr(err)}`);
            }
            continue;
          }

          // BehindTheCurtain-specific handling (@ relay to operator tmux)
          if (rid !== roomId) continue;
          if (captainUserId && event.sender !== captainUserId) continue; // Captain only

          if (!isOperatorRelayEnabled()) continue;

          log(`curtain: message from ${event.sender}: ${body.slice(0, 80)}`);
          const SESSION = 'operator';
          try {
            let existed = true;
            try { execFileSync('tmux', ['has-session', '-t', SESSION], { stdio: 'pipe' }); } catch { existed = false; }
            if (!existed) {
              execFileSync('tmux', ['new-session', '-d', '-s', SESSION, '-c', path.dirname(secretsRepoPath()), 'claude'], { stdio: ['pipe', 'pipe', 'pipe'] });
              await sleep(3000);
            }
            execFileSync('tmux', ['send-keys', '-t', SESSION, '-l', `[BehindTheCurtain | ${roomId}] ${body}`], { stdio: 'pipe' });
            execFileSync('tmux', ['send-keys', '-t', SESSION, 'Enter'], { stdio: 'pipe' });
          } catch (err) {
            log(`curtain: tmux send failed: ${errStr(err)}`);
          }
        }
      }
    } catch (err) {
      log(`curtain: sync error (retry in ${Math.round(retryDelay / 1000)}s): ${errStr(err)}`);
      await sleep(retryDelay);
      if (!isTransientServerError(err)) retryDelay = Math.min(retryDelay * 2, RETRY_DELAY_MAX);
    }
  }
}

// ── Sync loop per room ─────────────────────────────────────────────

async function connectRoom(conn: RoomConn): Promise<void> {
  const { accessToken, userId } = await matrixLogin(conn.homeserver, conn.username, conn.password);
  conn.accessToken = accessToken;
  conn.userId = userId;
  conn.filterId = await matrixCreateFilter(conn.homeserver, accessToken, userId);
  log(`connected to ${conn.name} as ${userId}`);
}

async function dialtone(conn: RoomConn, captainUserId: string, operatorUserId: string, conns: RoomConn[]): Promise<void> {
  let retryDelay = RETRY_DELAY_BASE;

  // Resume from persisted token so commands sent during restart are replayed
  conn.syncToken = loadSyncToken(`dialtone-${conn.name}`);

  // Initial sync: if no saved token, skip old messages; otherwise resume from saved token
  while (!conn.syncToken) {
    try {
      await connectRoom(conn);
      const initial = await matrixSync(conn.homeserver, conn.accessToken!, conn.syncToken, conn.filterId, 0);
      conn.syncToken = initial.next_batch;
      saveSyncToken(`dialtone-${conn.name}`, conn.syncToken);
      retryDelay = RETRY_DELAY_BASE;
      log(`${conn.name}: initial sync done, watching for commands`);
    } catch (err) {
      log(`${conn.name}: initial sync failed (retry in ${Math.round(retryDelay / 1000)}s): ${errStr(err)}`);
      conn.accessToken = null;
      await sleep(retryDelay);
      if (!isTransientServerError(err)) retryDelay = Math.min(retryDelay * 2, RETRY_DELAY_MAX);
    }
  }

  while (true) {
    try {
      if (!conn.accessToken) {
        await connectRoom(conn);
        // Re-sync to skip anything that arrived while disconnected
        const catchup = await matrixSync(conn.homeserver, conn.accessToken!, conn.syncToken, conn.filterId, 0);
        conn.syncToken = catchup.next_batch;
      }

      const data = await matrixSync(conn.homeserver, conn.accessToken!, conn.syncToken, conn.filterId, SYNC_TIMEOUT);
      conn.syncToken = data.next_batch;
      saveSyncToken(`dialtone-${conn.name}`, conn.syncToken);
      retryDelay = RETRY_DELAY_BASE; // reset on success

      // Process timeline events
      const joinedRooms = data.rooms?.join;
      if (joinedRooms) {
        for (const roomEvents of Object.values(joinedRooms)) {
          for (const event of roomEvents.timeline?.events || []) {
            if (event.type !== 'm.room.message') continue;
            if (event.content?.msgtype !== 'm.text') continue;
            const body = event.content.body?.trim() || '';

            // ── Response latency tracking ──
            // Extract sender's local username (strip @...:domain)
            const senderLocal = event.sender?.startsWith('@')
              ? event.sender.slice(1, event.sender.indexOf(':'))
              : '';
            const evTs = event.origin_server_ts ?? Date.now();
            if (senderLocal && liveFleet[senderLocal]) {
              // Bot message — stop the latency clock
              recordBotReply(senderLocal, evTs);
            } else if (event.sender === captainUserId && conn.userId !== event.sender) {
              // Captain message in a duty/quarters room — start latency clock for local bots in this room
              for (const [bot, entry] of Object.entries(liveFleet)) {
                if (entry.ship !== HOSTNAME) continue;
                if (entry.status !== 'onduty' && entry.status !== 'quarters') continue;
                const dutyRoom = ROLE_ROOMS[entry.role?.toLowerCase() ?? '']?.room ?? '';
                const quartersRoom = entry.quartersRoom ?? bot;
                if (conn.name === dutyRoom || conn.name === quartersRoom) {
                  recordMessageDelivery(bot, evTs);
                }
              }
            }

            // 📡 — relay received acknowledgement for Captain messages
            if (event.sender === captainUserId && event.event_id && conn.accessToken) {
              relayAck(conn.homeserver, conn.accessToken, conn.roomId, event.event_id);
            }

            // ── Branch Brain: context injection + thread closure ──────────
            if (body && !body.startsWith('!')) {
              const relates = (event.content as Record<string, unknown>)?.['m.relates_to'] as { rel_type?: string; event_id?: string } | undefined;
              const isThreadReply = relates?.rel_type === 'm.thread' && !!relates.event_id;

              if (isThreadReply && relates?.event_id) {
                // Thread closure: completed BB threads are dead. Reply via loudspeaker.
                const tasks = readBranchTasks();
                const task = tasks[relates.event_id];
                if (task?.completed && event.sender !== conn.userId) {
                  log(`dialtone: closed BB thread reply from ${event.sender} in thread=${relates.event_id.slice(0, 20)}`);
                  void threadReply(conn, relates.event_id, '📢 This thread is closed. The branch has merged — start a new branch if you need follow-up work.');
                }
              } else if (!isThreadReply) {
                // Main-timeline message from ANY sender — fan out to all active branch brains.
                // Spec: main brain, Captain, and other bot messages are all injected.
                fanOutToBranchBrains(body);
              }
            }

            // Captain-only: @ <text> — pipe to operator tmux (if relay enabled)
            if (event.sender === captainUserId && body.startsWith('@') && isOperatorRelayEnabled()) {
              const text = body.slice(1).trim();
              if (text) {
                log(`${conn.name}: @ message from captain: ${text.slice(0, 80)}`);
                const SESSION = 'operator';
                try {
                  let existed = true;
                  try { execFileSync('tmux', ['has-session', '-t', SESSION], { stdio: 'pipe' }); } catch { existed = false; }
                  if (!existed) {
                    execFileSync('tmux', ['new-session', '-d', '-s', SESSION, '-c', path.dirname(loadShipConfig().secretsPath), 'claude'], { stdio: ['pipe', 'pipe', 'pipe'] });
                    await sleep(3000);
                  }
                  execFileSync('tmux', ['send-keys', '-t', SESSION, '-l', `[${conn.name} | ${conn.roomId}] ${text}`], { stdio: 'pipe' });
                  execFileSync('tmux', ['send-keys', '-t', SESSION, 'Enter'], { stdio: 'pipe' });
                } catch (err) {
                  log(`${conn.name}: @ tmux send failed: ${errStr(err)}`);
                }
              }
              continue;
            }

            // @loudspeaker: <message> — on-duty bot broadcasts to all duty rooms
            // @loudspeaker (alone) — relay responds with fleet status in this room
            const lsCallout = /^@loudspeaker(?::\s*(.+))?$/is.exec(body);
            if (lsCallout && event.sender !== captainUserId && event.sender !== operatorUserId && event.sender !== conn.userId) {
              const message = lsCallout[1]?.trim();
              const senderName = event.sender.startsWith('@') ? event.sender.slice(1, event.sender.indexOf(':')) : event.sender;
              if (message) {
                // Broadcast to all other duty rooms
                const targets = conns.filter(t => t.roomId !== conn.roomId);
                const targetNames = targets.map(t => t.name).join(', ');
                log(`${conn.name}: @loudspeaker broadcast from ${senderName}: ${message.slice(0, 80)}`);
                const broadcast = `${capitalizeName(senderName)} (${conn.name}): ${message}`;
                for (const target of targets) {
                  await reply(target, broadcast);
                }
                await reply(conn, `📡 broadcast → ${targetNames || 'no other rooms'}`);
              } else {
                // Fleet status in this room
                log(`${conn.name}: @loudspeaker fleet status requested by ${senderName}`);
                const fleetConn: RoomConn = { ...conn };
                await handleCommand('!fleet', fleetConn, conns);
              }
              continue;
            }

            if (!body.startsWith('!') && !body.startsWith('?')) continue;

            if (!isAuthorized(event.sender, captainUserId, operatorUserId)) {
              log(`${conn.name}: unauthorized command from ${event.sender}: ${body.slice(0, 50)}`);
              continue;
            }

            // Dedup: curtainLoop may have already handled this event
            if (!markProcessed(event.event_id)) continue;

            log(`${conn.name}: command from ${event.sender}: ${body}`);
            try {
              await handleCommand(body, conn, conns);
            } catch (err) {
              log(`${conn.name}: command error: ${errStr(err)}`);
              await reply(conn, `⛔ command error — ${errStr(err)}`);
            }
          }
        }
      }
    } catch (err) {
      log(`${conn.name}: sync error (retry in ${Math.round(retryDelay / 1000)}s): ${errStr(err)}`);
      conn.accessToken = null;
      await sleep(retryDelay);
      if (!isTransientServerError(err)) retryDelay = Math.min(retryDelay * 2, RETRY_DELAY_MAX);
    }
  }
}

// ── Utilities ──────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.error(`[${ts}] relay: ${msg}`);
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`starting on ${HOSTNAME}`);
  refreshLocalCommitEpoch();
  log(`relay commit epoch: ${localCommitEpoch}`);
  publishCommitEpoch().catch(() => {});
  // Eagerly elect speaker on startup so isSpeakerCached is warm before any commands arrive.
  // This ensures '!' help responds instantly even on the first call after restart.
  electSpeaker().catch(() => {});
  registerRelayCommands();

  const intercom = loadIntercomConfig();
  if (!intercom) {
    log('no intercom config found — exiting');
    process.exit(1);
  }
  const captainUserId = resolveCaptainUserId();
  const operatorUserId = resolveOperatorUserId();
  if (!captainUserId && !operatorUserId) {
    log('WARNING: no captain or operator user ID found — no commands will be authorized');
  }
  if (captainUserId) log(`captain: ${captainUserId}`);
  if (operatorUserId) log(`operator: ${operatorUserId}`);

  // Initialize metrics subsystem with identity info
  {
    const opFile = path.join(secretsRepoPath(), 'operator', 'operator-matrix.json');
    let btcRoomId = '';
    try {
      const opConf = JSON.parse(fs.readFileSync(opFile, 'utf-8'));
      btcRoomId = opConf.rooms?.['BehindTheCurtain'] ?? '';
    } catch { /* ok — curtainLoop will also handle this */ }
    initMetrics({ btcRoomId, operatorUid: operatorUserId, captainUid: captainUserId });
    log('metrics: initialized');
  }

  const conns: RoomConn[] = [];
  for (const [name, room] of Object.entries(intercom.rooms)) {
    conns.push({
      name,
      roomId: room.roomId,
      homeserver: intercom.homeserver,
      username: room.username,
      password: room.password,
      accessToken: null,
      syncToken: null,
      filterId: null,
      userId: null,
    });
  }

  if (conns.length === 0) {
    log('no rooms configured in intercom.json — exiting');
    process.exit(1);
  }

  log(`watching ${conns.length} room(s): ${conns.map((c) => c.name).join(', ')}`);
  activeConns = conns;

  // Ensure git hooks are installed
  try { installGitHooks(); } catch (err) { log(`git hooks install failed: ${errStr(err)}`); }

  // Initialize in-memory fleet state: disk (static) + S3 (runtime) via loadFleetAsync
  try {
    liveFleet = await loadFleetAsync();
    log(`fleet: loaded ${Object.keys(liveFleet).length} bot(s) (disk + S3 overlay)`);
  } catch (err) {
    log(`fleet: async load failed, falling back to disk: ${errStr(err)}`);
    try { liveFleet = loadFleet(); } catch { /* give up */ }
  }

  // Persist fleet on shutdown — blocking S3 write before exit
  const shutdown = async () => {
    log('shutting down — persisting fleet state');
    await persistFleetSync();
    try { await pushAll(resolveRoot()); }
    catch (err) { log(`S3 push on shutdown failed: ${errStr(err)}`); }
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });

  // Start Matrix sync loops immediately so we catch up on lifecycle messages
  const loops = conns.map((conn, i) =>
    sleep(i * STARTUP_SYNC_DELAY).then(() => dialtone(conn, captainUserId, operatorUserId, conns)),
  );

  // Wait 30s for Matrix sync to catch up before bootstrapping bots
  log('warming up — syncing Matrix for 30s before bootstrap...');
  await sleep(30_000);

  // Bootstrap bots — only start bots that aren't already running.
  // When the relay restarts (code update), bot pm2 processes survive — don't disrupt them.
  if (isShipCommissioned()) {
    try {
      ensurePodmanReady();
      const root = resolveRoot();
      removeStaleProcesses();
      // Check which bots already have running pm2 processes
      const alreadyRunning = new Set<string>();
      try {
        const pm2List = JSON.parse(execSync('npx pm2 jlist 2>/dev/null', gitOpts(root, 5_000))) as Array<{ name: string; pm2_env?: { status?: string } }>;
        for (const p of pm2List) {
          const pfx = process.env['INFINICLAW_PM2_PREFIX'] || 'infiniclaw';
          const relayName = process.env['INFINICLAW_PM2_NAME'] || 'infiniclaw-relay';
          if (p.pm2_env?.status === 'online' && p.name.startsWith(`${pfx}-`) && p.name !== relayName) {
            alreadyRunning.add(p.name.replace(`${pfx}-`, ''));
          }
        }
      } catch { /* pm2 not available or no processes */ }

      if (alreadyRunning.size > 0) {
        log(`bootstrap: ${alreadyRunning.size} bot(s) already running — preserving: ${[...alreadyRunning].join(', ')}`);
      }

      // Check ROOM_STATE stamps for preserved bots — restart if stale (Tali bug fix)
      for (const bot of alreadyRunning) {
        const entry = liveFleet[bot];
        if (!entry || entry.ship !== HOSTNAME) continue;
        const stamp = readRoomStateStamp(root, bot);
        if (stamp && stamp.status !== entry.status) {
          log(`bootstrap: ${bot} ROOM_STATE mismatch (stamp=${stamp.status}, fleet=${entry.status}) — restarting`);
          alreadyRunning.delete(bot); // will be picked up by the bootstrap loop below
        }
      }

      const started: string[] = [];
      const failed: string[] = [];
      for (const [bot, entry] of Object.entries(liveFleet)) {
        if (entry.ship !== HOSTNAME) continue;
        if (!(RUNNING_STATUSES as readonly string[]).includes(entry.status)) continue;
        if (alreadyRunning.has(bot)) continue; // Don't restart already-running bots
        try {
          stopBot(bot);
          killStaleContainers(bot);
          bootstrapBot(root, bot);
          writeCrewStatus(root, bot);
          injectWbsTasks(root, bot);
          started.push(bot);
        } catch (err) {
          log(`bootstrap: ${bot} failed — ${errStr(err)}`);
          failed.push(bot);
        }
      }
      if (started.length > 0 || failed.length > 0) { fleetDirty = true; persistFleet(); }
      log(`bootstrap: ${started.length} started, ${failed.length} failed, ${alreadyRunning.size} preserved`);
    } catch (err) {
      log(`bootstrap failed: ${errStr(err)}`);
    }
  } else {
    log('ship is decommissioned — skipping bot startup');
  }

  // Ensure all rooms/spaces have correct emoji-prefixed names
  ensureRoomNames().catch((err) => log(`ensureRoomNames failed: ${errStr(err)}`));

  // Sync all bot display names to current format
  syncBotDisplayNames().catch((err) => log(`syncBotDisplayNames failed: ${errStr(err)}`));

  // Build userId → botName map for score reaction enrichment
  botUserIdMap = collectBotMatrixUserMap();

  // Back-fill operator metrics from Matrix history
  {
    const opFile = path.join(secretsRepoPath(), 'operator', 'operator-matrix.json');
    try {
      const opConf = JSON.parse(fs.readFileSync(opFile, 'utf-8'));
      const allRoomIds = conns.map(c => c.roomId);
      // Add quarters room IDs from fleet
      for (const entry of Object.values(liveFleet)) {
        if (entry.quartersRoom) allRoomIds.push(entry.quartersRoom);
      }
      backfillOperatorEvents(opConf.homeserver, opConf.accessToken, allRoomIds)
        .then(() => log('metrics: backfill complete'))
        .catch(err => log(`metrics: backfill failed: ${errStr(err)}`));
    } catch { log('metrics: skipping backfill (no operator config)'); }
  }

  // Start background loops (non-blocking alongside room sync loops)
  healthLoop().catch((err) => log(`health loop fatal: ${errStr(err)}`));
  gitSyncLoop(conns).catch((err) => log(`git sync loop fatal: ${errStr(err)}`));
  relayTasksLoop(conns).catch((err) => log(`relay tasks loop fatal: ${errStr(err)}`));
  secretsSyncLoop(conns).catch((err) => log(`secrets sync loop fatal: ${errStr(err)}`));
  heartbeatLoop(conns).catch((err) => log(`heartbeat loop fatal: ${errStr(err)}`));
  dutyCycleLoop(conns).catch((err) => log(`duty cycle loop fatal: ${errStr(err)}`));
  curtainLoop(captainUserId).catch((err) => log(`curtain loop fatal: ${errStr(err)}`));
  metricsLoop().catch((err) => log(`metrics loop fatal: ${errStr(err)}`));
  healthWatchdogLoop().catch((err) => log(`health watchdog fatal: ${errStr(err)}`));

  await Promise.all(loops);
}

main().catch((err) => {
  log(`fatal: ${errStr(err)}`);
  process.exit(1);
});
