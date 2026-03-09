/**
 * Supervisor relay — lightweight Matrix watcher for fleet lifecycle.
 *
 * Connects to each room via its intercom account (from intercom.json),
 * watches for operator commands (!join, !dismiss, !refresh), and manages
 * bots via pm2 — no CLI needed.
 *
 * Run: node dist/relay.js
 */
import { execFileSync, execSync, spawn, spawnSync } from 'child_process';
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

import { upsertEnvLine } from './env-utils.js';
import {
  matrixLogin,
  matrixCreateFilter,
  matrixSync,
  matrixSend,
  matrixInvite,
  matrixJoin,
  matrixLeave,
  markdownToHtml,
  loadIntercomConfig,
  clearIntercomConfigCache,
} from './matrix-api.js';
import type { IntercomConfig, SyncResponse } from './matrix-api.js';
import { loadShipConfig, loadFleet, writeFleet, loadShips, writeShips, isShipActive, clearShipConfigCache } from './ship-config.js';
import { removeBotMounts, grantMount, revokeMount } from './allow-list.js';
import { registerHandlers, dispatch, buildHelpText } from './command-registry.js';
import type { RoomConn } from './command-registry.js';
import {
  resolveRoot,
  getActiveBots,
  bootstrapBot,
  deployBot,
  stopBot,
  refreshBot,
  ensurePodmanReady,
  killStaleContainers,
  loadProfileEnv,
  removeStaleProcesses,
} from './service.js';
import { sleep, shellQuote, errStr } from './utils.js';
import { gitOpts, execErrOutput, gitSyncRepo } from './git-utils.js';

// ── Config ─────────────────────────────────────────────────────────

const HOSTNAME = os.hostname();
const SYNC_TIMEOUT = 30_000;

const RETRY_DELAY_BASE = 10_000;
const RETRY_DELAY_MAX = 5 * 60_000;
const STARTUP_SYNC_DELAY = 3_000;

// Configurable intervals (env vars in milliseconds, or use defaults)
const GITHUB_REPO_URL = 'https://github.com/wawiesel/InfiniClaw';
const GIT_SYNC_INTERVAL = parseInt(process.env.GIT_SYNC_INTERVAL || '', 10) || 3 * 60_000;     // default 3 min
const SECRETS_SYNC_INTERVAL = parseInt(process.env.SECRETS_SYNC_INTERVAL || '', 10) || 30_000;  // default 30s
const HEALTH_INTERVAL = parseInt(process.env.HEALTH_INTERVAL || '', 10) || 30 * 60_000;         // default 30 min

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

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hrs = (ms / 3_600_000).toFixed(1).replace(/\.0$/, '');
  return `${hrs}h`;
}

function formatTimestamp(): string {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

/** Standard status line: `<emoji> <what> (<ship>) <status> (<time>)` */
function statusLine(emoji: string, what: string, status: string, elapsedMs: number): string {
  const time = elapsedMs > 0
    ? `${formatTimestamp()} · ${formatDuration(elapsedMs)}`
    : formatTimestamp();
  return `${emoji} ${what} (${HOSTNAME}) ${status} (${time})`;
}

/** Stage result: `✅ <what><suffix>` or `⛔ <what><suffix>` or `⚠️ <what><suffix>` */
function stageOk(what: string, suffix = ''): string { return `✅ ${what}${suffix}`; }
function stageFail(what: string, suffix = ''): string { return `⛔ ${what}${suffix}`; }
function stageWarn(what: string, suffix = ''): string { return `⚠️ ${what}${suffix}`; }
function resultEmoji(warnings: number, errors: number): string { return errors > 0 ? '⛔' : warnings > 0 ? '⚠️' : '✅'; }
function refitResult(outcome: string, warnings: number, errors: number, elapsedMs: number): string {
  return statusLine(resultEmoji(warnings, errors), 'refit', `${outcome} (${warnings}W ${errors}E)`, elapsedMs);
}

async function reportFailure(system: string, detail: string, conns: RoomConn[]): Promise<void> {
  const now = Date.now();
  const conn = findEngConn(conns);
  if (!conn?.accessToken) return;

  const existing = failureStates[system];
  if (!existing) {
    // First failure — create thread
    const rootId = await reply(conn, statusLine('⚠️', system, 'down', 0));
    if (!rootId) return;
    await threadReply(conn, rootId, detail.slice(0, 500));
    failureStates[system] = {
      startedAt: now,
      threadRootId: rootId,
      nextAlertAt: now + FAILURE_INITIAL_INTERVAL,
      intervalMs: FAILURE_INITIAL_INTERVAL,
    };
    return;
  }

  // Subsequent failure — only post if past nextAlertAt
  if (now < existing.nextAlertAt) return;
  await threadReply(conn, existing.threadRootId, statusLine('⚠️', system, 'down', now - existing.startedAt));
  existing.intervalMs = Math.min(existing.intervalMs * 2, FAILURE_MAX_INTERVAL);
  existing.nextAlertAt = now + existing.intervalMs;
}

async function reportRecovery(system: string, conns: RoomConn[]): Promise<void> {
  const state = failureStates[system];
  if (!state) return;
  delete failureStates[system];

  const conn = findEngConn(conns);
  if (!conn?.accessToken) return;
  const recoveryMsg = statusLine('✅', system, 'operational', Date.now() - state.startedAt);
  await threadReply(conn, state.threadRootId, recoveryMsg);
  await reply(conn, recoveryMsg);
}

// ── In-memory fleet state (authoritative at runtime, persisted on shutdown) ──

type BotStatus = 'onduty' | 'lounge' | 'quarters' | 'sleep' | 'transit';
type FleetEntry = { role: string; rank: number; ship: string | null; status: BotStatus; title?: string; quartersRoom?: string; activeBrainModel?: string };
let liveFleet: Record<string, FleetEntry> = {};
/** Read this ship's operatorRelay flag from ships.json (default: true). */
function isOperatorRelayEnabled(): boolean {
  try { return loadShips()[HOSTNAME]?.operatorRelay !== false; } catch { return true; }
}
let fleetDirty = false;

function fleetUpdate(bot: string, updates: Partial<FleetEntry>): void {
  if (!liveFleet[bot]) return;
  Object.assign(liveFleet[bot], updates);
  fleetDirty = true;
}

function persistFleet(): void {
  if (!fleetDirty) return;
  try {
    writeFleet(liveFleet);
    secretsGitCommit(['bots/fleet.json'], `fleet: persist on ${HOSTNAME}`);
    fleetDirty = false;
    log('fleet: persisted to fleet.json');
  } catch (err) {
    log(`fleet: persist failed: ${errStr(err)}`);
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

// ── Sync/rebuild helpers (shared by !provision and !refit) ────────

function formatSyncResult(name: string, r: { ok: boolean; newCommits: number; output: string }): string {
  if (!r.ok) return `${name}: failed — ${r.output.slice(0, 200)}`;
  return r.newCommits > 0 ? `${name}: pulled ${r.newCommits} commit(s)` : `${name}: up to date`;
}

function rebuildInfiniClaw(): string {
  const root = resolveRoot();
  try {
    const nodeBinDir = path.dirname(process.execPath);
    const execOpts = { cwd: root, encoding: 'utf-8' as const, stdio: 'pipe' as const, env: { ...process.env, PATH: `${nodeBinDir}:${process.env.PATH}` } };
    // Use rebuild script (pulled via git, so it's always up to date)
    const script = path.join(root, 'scripts', 'rebuild.sh');
    if (fs.existsSync(script)) {
      execSync(`bash ${shellQuote(script)}`, { ...execOpts, timeout: 300_000 });
    } else {
      // Fallback for repos without the script
      execSync('npm run build', { ...execOpts, timeout: 120_000 });
    }
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
    const lsFile = path.join(secretsRepoPath(), 'operator', 'loudspeaker-matrix.json');
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

function resolveOperatorUserId(): string {
  return resolveOperatorConfig().userId;
}

/** Captain and operator are both fully trusted. */
function isAuthorized(sender: string, captainUserId: string, operatorUserId: string): boolean {
  return sender === captainUserId || sender === operatorUserId;
}

/** Is this ship the "speaker" — lowest-rank active ship? Used to avoid duplicate replies. */
// ── Git version helper ────────────────────────────────────────────

/** Format version string: ` · 📦 [sha](github) (age) ↑N|↓N` */
function fmtVersion(sha: string, ageMs: number, ud: string): string {
  const url = `${GITHUB_REPO_URL}/commit/${sha}`;
  return ` · 📦 [${sha}](${url}) (${formatDuration(ageMs)}) ${ud}`;
}

/** Compute ↑N/↓N relation between two refs. */
function gitRelation(root: string, local: string, upstream: string): string {
  const execOpts = { encoding: 'utf-8' as const, timeout: 5_000, stdio: 'pipe' as const, cwd: root };
  const ahead = parseInt(execSync(`git rev-list ${upstream}..${local} --count`, execOpts).trim(), 10) || 0;
  const behind = parseInt(execSync(`git rev-list ${local}..${upstream} --count`, execOpts).trim(), 10) || 0;
  if (ahead > 0 && behind > 0) return `↑${ahead}↓${behind}`;
  if (ahead > 0) return `↑${ahead}`;
  if (behind > 0) return `↓${behind}`;
  return '↑0';
}

/** Commit age in ms from a sha. */
function commitAge(root: string, sha: string): number {
  const execOpts = { encoding: 'utf-8' as const, timeout: 5_000, stdio: 'pipe' as const, cwd: root };
  const epoch = parseInt(execSync(`git log -1 --format=%ct ${sha}`, execOpts).trim(), 10) * 1000;
  return Date.now() - epoch;
}

/** Version string for a repo: HEAD vs origin/main. */
function repoVersion(repoDir: string): string {
  try {
    const execOpts = { encoding: 'utf-8' as const, timeout: 5_000, stdio: 'pipe' as const, cwd: repoDir };
    const sha = execSync('git rev-parse --short HEAD', execOpts).trim();
    if (!sha) return '';
    return fmtVersion(sha, commitAge(repoDir, sha), gitRelation(repoDir, 'HEAD', 'origin/main'));
  } catch { return ''; }
}

/** Version string for the relay dist: HEAD vs origin (relay is built from repo HEAD). */
function relayVersion(root: string): string {
  return repoVersion(root);
}

/** Version string for a bot's deployed instance: stamped sha vs HEAD. */
function botVersion(root: string, bot: string): string {
  try {
    const versionFile = path.join(root, '_runtime', 'instances', bot, 'GIT_VERSION');
    const sha = fs.readFileSync(versionFile, 'utf-8').trim().split(' ')[0];
    if (!sha || !/^[a-f0-9]{7,40}$/.test(sha)) return '';
    return fmtVersion(sha, commitAge(root, sha), gitRelation(root, sha, 'HEAD'));
  } catch { return ''; }
}

// ── Speaker election via S3 commit timestamps ────────────────────

const RELAY_S3_PREFIX = 'relay';
const FLEET_S3_PREFIX = 'fleet-report';
let localCommitEpoch = 0; // epoch seconds of HEAD commit the relay is running

/** Read the commit timestamp of the code this relay is actually running. Called once at startup and after rebuilds. */
function refreshLocalCommitEpoch(): void {
  try {
    const root = resolveRoot();
    const epoch = execSync('git log -1 --format=%ct HEAD', {
      cwd: root, encoding: 'utf-8', timeout: 5_000, stdio: 'pipe',
    }).trim();
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

/** Cached speaker result — refreshed by async election. */
let cachedIsSpeaker = true;

async function electSpeaker(): Promise<boolean> {
  try {
    const ships = loadShips();
    const active = Object.entries(ships).filter(([_, m]) => m.active);
    if (active.length === 0) return true;
    if (!active.some(([name]) => name === HOSTNAME)) return false;

    const epochs = await fetchCommitEpochs();
    // Find the newest commit epoch among active ships
    let maxEpoch = 0;
    for (const [name] of active) {
      const e = epochs[name] ?? 0;
      if (e > maxEpoch) maxEpoch = e;
    }

    const myEpoch = epochs[HOSTNAME] ?? localCommitEpoch;

    if (myEpoch < maxEpoch) {
      log(`speaker: deferring — local commit ${myEpoch} < newest ${maxEpoch}`);
      return false;
    }

    // Tiebreak: among ships at maxEpoch, lowest rank wins
    const atMax = active
      .filter(([name]) => (epochs[name] ?? 0) >= maxEpoch)
      .sort((a, b) => (a[1].rank ?? 99) - (b[1].rank ?? 99));
    return atMax.length > 0 && atMax[0][0] === HOSTNAME;
  } catch {
    return true;
  }
}

function isSpeaker(): boolean {
  // Trigger async re-election in background, return cached result
  electSpeaker().then(v => { cachedIsSpeaker = v; }).catch(() => {});
  return cachedIsSpeaker;
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

// ── Bot resolution (multi-ship aware) ───────────────────────────

/** Map local bot name → room name (lowercased) from MAIN_GROUP_NAME in env. */
function buildBotRoomMap(): Record<string, string> {
  const root = resolveRoot();
  const map: Record<string, string> = {};
  for (const bot of getActiveBots()) {
    try {
      const env = loadProfileEnv(root, bot);
      if (env.MAIN_GROUP_NAME) map[bot] = env.MAIN_GROUP_NAME.toLowerCase();
    } catch { /* skip bots with broken env */ }
  }
  return map;
}

function parseTarget(cmd: string, prefix: string): { matched: boolean; target?: string } {
  if (cmd !== prefix && !cmd.startsWith(prefix + ' ')) return { matched: false };
  const target = cmd.slice(prefix.length).trim().toLowerCase() || undefined;
  return { matched: true, target };
}

/** Case-insensitive check: does the input match this ship? */
function isThisShip(input: string): boolean {
  return input.toLowerCase() === HOSTNAME.toLowerCase();
}

/** Case-insensitive ship name lookup — returns canonical name from ships.json or null. */
function resolveShipName(input: string, ships: Record<string, unknown>): string | null {
  const lower = input.toLowerCase();
  return Object.keys(ships).find(s => s.toLowerCase() === lower) ?? null;
}

/**
 * Resolve which local bots a command applies to.
 *
 * - Targeted (`!refresh parker`): returns [parker] ONLY if parker is in
 *   this ship. Returns. Returns [] if not local (silent ignore —
 *   another ship.s relay handles it).
 *
 * - Untargeted (`!refresh` in Engineering): returns local bots whose
 *   MAIN_GROUP_NAME matches the room the command arrived in.
 */
function resolveBots(target: string | undefined, roomName: string, action?: string): string[] {
  const local = getActiveBots();
  if (target) {
    if (local.includes(target)) return [target];
    // For join/sleep/wake, also match inactive/sleeping bots assigned to this ship
    if ((action === 'join' || action === 'sleep' || action === 'wake') && liveFleet[target]?.ship === HOSTNAME) return [target];
    return [];
  }
  // No target — scope to bots in this room on this ship
  const botRooms = buildBotRoomMap();
  return local.filter((bot) => botRooms[bot] === roomName);
}

// ── Health check + S3 ─────────────────────────────────────────

const HEALTH_S3_PREFIX = 'health';

function getS3Client(): { client: S3Client; bucket: string } | null {
  try {
    const config = loadShipConfig();
    if (!config.s3) return null;
    const { endpoint, bucket, accessKey, secretKey } = config.s3;
    return {
      client: new S3Client({
        endpoint,
        region: 'us-east-1',
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
        forcePathStyle: true,
      }),
      bucket,
    };
  } catch { return null; }
}

/** Upload an error log to S3 and return a markdown link, or empty string on failure. */
/** Upload an error log to S3 and return a markdown link (presigned, 7 days), or empty string on failure. */
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
  bots: Record<string, { name: string; badge: string; role: string; rank: number; status: string; gitVersion: string }>;
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
  const botReports: FleetReport['bots'] = {};
  for (const [botId, entry] of Object.entries(liveFleet)) {
    if (entry.ship !== HOSTNAME) continue;
    const env = (() => { try { return loadProfileEnv(root, botId); } catch { return null; } })();
    const name = env?.ASSISTANT_NAME || botId;
    const running = localRunning.has(botId);
    botReports[botId] = {
      name,
      badge: '',
      role: entry.role,
      rank: entry.rank,
      status: entry.status,
      gitVersion: botVersion(root, botId),
    };
    if (entry.status === 'onduty' && !running) {
      botReports[botId].status = 'warn';
    }
  }

  const report: FleetReport = { ship: HOSTNAME, ts: Date.now(), relayVersion: relayVer, bots: botReports };

  const s3 = getS3Client();
  if (s3) {
    try {
      await s3.client.send(new PutObjectCommand({
        Bucket: s3.bucket,
        Key: `${FLEET_S3_PREFIX}/${HOSTNAME}.json`,
        Body: Buffer.from(JSON.stringify(report)),
        ContentType: 'application/json',
      }));
    } catch (err) { log(`fleet S3 publish failed: ${errStr(err)}`); }
  }

  return report;
}

function runHealthCheck(): string | null {
  const root = resolveRoot();
  const script = path.join(root, 'scripts', 'health-check.sh');
  if (!fs.existsSync(script)) return null;
  try {
    return execSync(`bash ${shellQuote(script)} --json`, {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, MACHINE_NAME: HOSTNAME },
    }).trim();
  } catch (err) {
    log(`health-check.sh failed: ${errStr(err)}`);
    return null;
  }
}

async function uploadHealthToS3(report: string): Promise<boolean> {
  const s3 = getS3Client();
  if (!s3) return false;
  const key = `${HEALTH_S3_PREFIX}/${HOSTNAME}.json`;
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

function formatHealthSummary(reports: Array<{ ship: string; data: Record<string, unknown> }>): string {
  if (reports.length === 0) return '⚠️ No health reports available.';
  const lines: string[] = [`🏥 Fleet Health — ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC\n`];
  let totalOom = 0;
  let totalSessions = 0;

  for (const { ship, data } of reports) {
    const bots = (data.bots || {}) as Record<string, Record<string, unknown>>;
    const active = Object.entries(bots).filter(([, b]) => b.status === 'ACTIVE').map(([n]) => n);
    const ts = String(data.ts || '?').slice(0, 19);
    lines.push(`**${ship}** (${ts})`);
    lines.push(`  Active: ${active.length > 0 ? active.join(', ') : 'none'}`);

    const trends = (data.trends_24h || {}) as Record<string, { sigkills: number; oom_kills: number }>;
    for (const [name, b] of Object.entries(bots)) {
      const oom = Number(b.oom_kills || 0);
      const sk = Number(b.sigkills || 0);
      totalOom += oom;
      if (b.status === 'ACTIVE' || oom > 0 || sk > 0) {
        const mem = b.rss_mb != null ? `RSS=${b.rss_mb}/${b.limit_mb}MB` : '';
        const t = trends[name];
        const trend = t ? ` Δ24h: SK+${t.sigkills} OOM+${t.oom_kills}` : '';
        lines.push(`  ${name}: ${b.status} ${mem} SK=${sk} OOM=${oom}${trend}`);
      }
    }
    const sess = Number(data.session_total_mb || 0);
    totalSessions += sess;
    lines.push(`  Sessions: ${sess}MB\n`);
  }

  lines.push(`**Totals:** ${reports.length} ships, ${totalOom} OOM kills, ${totalSessions}MB sessions`);
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
    const execOpts = { cwd: root, encoding: 'utf-8' as const, timeout: 10_000, stdio: 'pipe' as const };
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

function gitSync(): { ok: boolean; output: string; newCommits: number } {
  const root = resolveRoot();
  const opts = gitOpts(root, 30_000);
  try {
    // Fetch + push local commits ahead of origin before pulling
    execSync('git fetch origin', opts);
    const aheadCount = parseInt(
      execSync('git rev-list origin/main..HEAD --count', { ...opts, timeout: 5_000 }).trim(), 10,
    ) || 0;
    if (aheadCount > 0) {
      try {
        execSync('git push origin main', { ...opts, timeout: 30_000 });
        log(`git sync: pushed ${aheadCount} local commit(s)`);
      } catch (pushErr) {
        log(`git sync: push failed: ${errStr(pushErr)}`);
      }
    }
    // Pull new commits (gitSyncRepo re-fetches internally — harmless)
    const { pulled, changed, output } = gitSyncRepo(root);
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
  while (true) {
    try {
      const result = gitSync();
      if (!result.ok) {
        log(`git sync FAILED: ${result.output}`);
        await reportFailure('code sync', result.output, conns);
      } else if (result.newCommits > 0) {
        await reportRecovery('code sync', conns);
        log(`git sync: pulled ${result.newCommits} new commit(s)`);
        if (!hasSourceChanges(resolveRoot(), result.newCommits)) {
          log('git sync: doc-only changes, skipping rebuild and restart');
        } else {
          const buildResult = rebuildInfiniClaw();
          log(`git sync: ${buildResult}`);
          if (buildResult.includes('FAILED')) {
            await reportFailure('code build', buildResult, conns);
          } else {
            await reportRecovery('code build', conns);
            // Restart running bots so they pick up new code (skip dismissed)
            const engConn = findEngConn(conns);
            const threadRoot = engConn
              ? await reply(engConn, `🔄 git sync: ${result.newCommits} new commit(s) — restarting fleet`)
              : undefined;
            for (const bot of getActiveBots()) {
              if (liveFleet[bot]?.status !== 'onduty') continue;
              try {
                bootstrapBot(resolveRoot(), bot);
                log(`git sync: restarted ${bot}`);
                if (engConn && threadRoot) await threadReply(engConn, threadRoot, `✅ ${bot} restarted${botVersion(resolveRoot(), bot)}`);
              } catch (err) {
                log(`git sync: failed to restart ${bot}: ${errStr(err)}`);
                if (engConn && threadRoot) await threadReply(engConn, threadRoot, `⛔ ${bot} restart failed: ${errStr(err).slice(0, 100)}`);
              }
            }
            // Post completion summary before relay restarts
            if (engConn) await reply(engConn, `✅ git sync: fleet restarted`);
            // Restart relay itself to pick up new relay code
            try {
              log('git sync: restarting relay to pick up new code');
              if (engConn && threadRoot) await threadReply(engConn, threadRoot, `🔄 relay restarting...`);
              execSync('npx pm2 restart infiniclaw-relay', { cwd: resolveRoot(), encoding: 'utf-8', timeout: 10_000, stdio: 'pipe' });
            } catch (err) {
              log(`git sync: relay self-restart failed: ${errStr(err)}`);
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

// ── Thread Brain task registry ──────────────────────────────────────────

const THREAD_BRAIN_RESTART_DELAY = 30_000; // wait 30s after last TB exit before restarting bot
const MAX_THREAD_BRAINS_PER_BOT = parseInt(process.env.MAX_THREAD_BRAINS_PER_BOT || '3', 10);
const threadBrainRestartTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeThreadBrainCount = new Map<string, number>(); // bot → active TB count

interface ThreadTaskEntry {
  objective: string;
  chat_jid: string;
  bot?: string;
  createdAt: number;
}

function threadTasksPath(): string {
  return path.join(resolveRoot(), '_runtime', 'data', 'thread-tasks.json');
}

const THREAD_TASK_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function readThreadTasks(): Record<string, ThreadTaskEntry> {
  try {
    const p = threadTasksPath();
    if (!fs.existsSync(p)) return {};
    const tasks = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, ThreadTaskEntry>;
    // Auto-prune entries older than TTL
    const now = Date.now();
    const stale = Object.keys(tasks).filter(k => !tasks[k].createdAt || now - tasks[k].createdAt > THREAD_TASK_TTL_MS);
    if (stale.length > 0) {
      stale.forEach(k => { delete tasks[k]; });
      try { fs.writeFileSync(p, JSON.stringify(tasks, null, 2)); } catch { /* best-effort */ }
      log(`threadTasks: pruned ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'}`);
    }
    return tasks;
  } catch { return {}; }
}

function writeThreadTask(threadId: string, entry: ThreadTaskEntry): void {
  try {
    const p = threadTasksPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tasks = readThreadTasks();
    tasks[threadId] = entry;
    fs.writeFileSync(p, JSON.stringify(tasks, null, 2));
  } catch (err) { log(`threadTasks: write failed: ${errStr(err)}`); }
}

function removeThreadTask(threadId: string): void {
  try {
    const p = threadTasksPath();
    if (!fs.existsSync(p)) return;
    const tasks = readThreadTasks();
    delete tasks[threadId];
    fs.writeFileSync(p, JSON.stringify(tasks, null, 2));
  } catch (err) { log(`threadTasks: remove failed: ${errStr(err)}`); }
}

/**
 * Spawn a Thread Brain as a host-side claude process (BUG-14 fix).
 * Thread Brain runs independently of the bot container, capturing stdout
 * and posting results to the specified Matrix thread.
 */
async function spawnThreadBrain(
  task: { thread_id: string; objective: string; chat_jid: string; bot?: string },
  conns: RoomConn[],
): Promise<void> {
  const { thread_id, objective, chat_jid, bot } = task;
  log(`threadBrain: spawning for thread=${thread_id.slice(0, 20)}`);

  // Find the connection for this room (strip matrix: prefix if present)
  const roomId = chat_jid.replace(/^matrix:/, '');
  const conn = conns.find(c => c.roomId === roomId) || findEngConn(conns);
  if (!conn?.accessToken) {
    log(`threadBrain: no active connection for chat_jid=${chat_jid}`);
    return;
  }

  // Announce Thread Brain dispatch on main timeline before spawning.
  // Capture the returned event ID so Thread Brain replies thread under this
  // announcement (not under the triggering message).
  const announcedTitle = objective.split('\n')[0].trim().slice(0, 80);
  let announcementEventId: string | undefined;
  try {
    announcementEventId = await reply(conn, `🧵 Thread Brain: ${announcedTitle}`);
  } catch (err) {
    log(`threadBrain: announce failed: ${errStr(err)}`);
  }
  // Use the announcement event as the thread root; fall back to the triggering thread_id.
  const replyThreadId = announcementEventId ?? thread_id;

  // Register task in thread-tasks.json for !todo deep-link annotation
  writeThreadTask(replyThreadId, { objective, chat_jid, bot, createdAt: Date.now() });

  // Load bot credentials so claude can authenticate on the host.
  // Raw env file uses BRAIN_* names; map to CLAUDE_CODE_* / ANTHROPIC_* as needed.
  const botEnv = bot ? (() => { try { return loadProfileEnv(resolveRoot(), bot); } catch { return null; } })() : null;
  const childEnv: Record<string, string> = { ...process.env as Record<string, string> };
  const oauthToken = botEnv?.CLAUDE_CODE_OAUTH_TOKEN || botEnv?.BRAIN_OAUTH_TOKEN;
  const apiKey = botEnv?.ANTHROPIC_API_KEY || botEnv?.BRAIN_API_KEY;
  if (oauthToken) childEnv['CLAUDE_CODE_OAUTH_TOKEN'] = oauthToken;
  if (apiKey) childEnv['ANTHROPIC_API_KEY'] = apiKey;
  if (botEnv?.ANTHROPIC_BASE_URL) childEnv['ANTHROPIC_BASE_URL'] = botEnv.ANTHROPIC_BASE_URL;
  if (botEnv?.ANTHROPIC_AUTH_TOKEN) childEnv['ANTHROPIC_AUTH_TOKEN'] = botEnv.ANTHROPIC_AUTH_TOKEN;
  if (botEnv?.NODE_EXTRA_CA_CERTS) childEnv['NODE_EXTRA_CA_CERTS'] = botEnv.NODE_EXTRA_CA_CERTS;
  // Prevent nested Claude Code rejection
  delete childEnv['CLAUDECODE'];

  // Notes file: Thread Brain can persist key findings here; relay injects as context on bot restart.
  const notesFile = path.join(resolveRoot(), '_runtime', 'data', 'thread-notes', `${replyThreadId.slice(0, 12)}.md`);

  const fullPrompt = [
    'You are a Thread Brain — a focused research/analysis agent.',
    'Output your findings as plain text. Do NOT call send_message, set_thread, or any Matrix communication tools.',
    'Do NOT announce that you are starting. Just do the work and output findings at the end.',
    '',
    'Before finishing: if you discovered persistent findings, decisions, or architectural notes worth saving,',
    `write them in Markdown to: ${notesFile}`,
    '(Create parent directories as needed. Skip if nothing persistent to record.)',
    '',
    'Objective:',
    objective,
  ].join('\n');

  const child = spawn('claude', [
    '--print',
    '--verbose',
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--add-dir', resolveRoot(),
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
  });

  child.stdin?.write(fullPrompt);
  child.stdin?.end();

  let stdoutBuf = '';
  let postedCount = 0;

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
          message?: { content?: Array<{ type: string; text?: string }> };
        };
        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          const text = event.message.content
            .filter(b => b.type === 'text')
            .map(b => b.text ?? '')
            .join('');
          if (text.trim()) {
            postedCount++;
            threadReply(conn, replyThreadId, text.trim()).catch((err) => log(`threadBrain: stream post failed: ${errStr(err)}`));
          }
        } else if (event.type === 'result' && typeof event.result === 'string' && event.result.trim() && postedCount === 0) {
          postedCount++;
          threadReply(conn, replyThreadId, event.result.trim()).catch((err) => log(`threadBrain: result post failed: ${errStr(err)}`));
        }
      } catch { /* not JSON, skip */ }
    }
  });

  let stderrBuf = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });

  child.on('error', (err) => {
    log(`threadBrain: spawn error: ${errStr(err)}`);
    removeThreadTask(replyThreadId);
    threadReply(conn, replyThreadId, `⚠️ Thread Brain failed to start: ${err.message}`).catch(() => {});
  });

  child.on('close', (code) => {
    if (stderrBuf.trim()) log(`threadBrain: stderr: ${stderrBuf.trim().slice(0, 400)}`);
    log(`threadBrain: done exit=${code} posted=${postedCount}`);
    removeThreadTask(replyThreadId);
    if (postedCount === 0) {
      threadReply(conn, replyThreadId, `Thread Brain completed with no output (exit ${code ?? 'null'})`).catch((err) => log(`threadBrain: post failed: ${errStr(err)}`));
    }

    // Schedule debounced main-brain restart so it picks up Thread Brain findings (30s delay).
    // Reset timer on each successive TB exit; fires once all TBs for this bot are done.
    if (bot && getActiveBots().includes(bot)) {
      const existing = threadBrainRestartTimers.get(bot);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        threadBrainRestartTimers.delete(bot);
        log(`threadBrain: restarting ${bot} to pick up findings`);
        try {
          bootstrapBot(resolveRoot(), bot);
          log(`threadBrain: ${bot} restarted`);
        } catch (err) {
          log(`threadBrain: restart ${bot} failed: ${errStr(err)}`);
        }
      }, THREAD_BRAIN_RESTART_DELAY);
      threadBrainRestartTimers.set(bot, timer);
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
                  execFileSync('git', ['push', remote, ...branches], {
                    cwd: resolveRoot(), encoding: 'utf-8', timeout: 30_000, stdio: 'pipe',
                  });
                  log(`relayTasks: git pushed ${branches.join(', ')} → ${remote}`);
                } catch (err) {
                  log(`relayTasks: git_push failed: ${errStr(err)}`);
                }
              }
            } else if (data['type'] === 'thread_brain') {
              const thread_id = typeof data['thread_id'] === 'string' ? data['thread_id'] : '';
              const objective = typeof data['objective'] === 'string' ? data['objective'] : '';
              const chat_jid = typeof data['chat_jid'] === 'string' ? data['chat_jid'] : '';
              const bot = typeof data['bot'] === 'string' ? data['bot'] : undefined;
              if (thread_id && objective) {
                const botKey = bot ?? '__relay__';
                const count = activeThreadBrainCount.get(botKey) ?? 0;
                if (count >= MAX_THREAD_BRAINS_PER_BOT) {
                  log(`relayTasks: thread_brain rejected — ${botKey} already at limit (${MAX_THREAD_BRAINS_PER_BOT})`);
                } else {
                  activeThreadBrainCount.set(botKey, count + 1);
                  void spawnThreadBrain({ thread_id, objective, chat_jid, bot }, conns).finally(() => {
                    const n = activeThreadBrainCount.get(botKey) ?? 1;
                    if (n <= 1) activeThreadBrainCount.delete(botKey);
                    else activeThreadBrainCount.set(botKey, n - 1);
                  });
                }
              } else {
                log(`relayTasks: thread_brain missing required fields (thread_id or objective)`);
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
        // Reload fleet.json from disk (may have transport assignments from other ships)
        try {
          const diskFleet = loadFleet();
          // Merge disk state into liveFleet — transport assignments come via git
          for (const [bot, entry] of Object.entries(diskFleet)) {
            if (!liveFleet[bot]) { liveFleet[bot] = entry; continue; }
            // Transport pickup: bot assigned to us but inactive (phase 1 by another ship)
            if (entry.ship === HOSTNAME && entry.status === 'transit' && liveFleet[bot].ship !== HOSTNAME) {
              liveFleet[bot].ship = HOSTNAME;
              liveFleet[bot].status = 'transit'; // will be materialized below
            }
          }
        } catch { /* no fleet on disk */ }

        // Materialize — bots assigned here but not active (dematerialized on source ship)
        if (!isShipActive()) { /* decommissioned — skip materialize */ }
        else try {
          for (const [bot, entry] of Object.entries(liveFleet)) {
            if (entry.ship === HOSTNAME && entry.status === 'transit') {
              log(`transport: materializing ${bot}`);
              fleetUpdate(bot, { status: 'onduty' });
              writeFleet(liveFleet);
              clearShipConfigCache(); // so bootstrapBot sees updated onduty state
              secretsGitCommit(['bots/fleet.json'], `transport: ${bot} materialized on ${HOSTNAME}`);
              fleetDirty = false;
              const root = resolveRoot();
              try {
                ensurePodmanReady();
                bootstrapBot(root, bot);
                for (const c of conns) {
                  if (c.accessToken) {
                    await reply(c, `${bot} materialized and started`).catch(() => {});
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

/** Run session cleanup to prune old JSONL files and telemetry. */
function runSessionCleanup(): void {
  const root = resolveRoot();
  const script = path.join(root, 'scripts', 'session-cleanup.sh');
  if (!fs.existsSync(script)) return;
  try {
    const output = execSync(`bash "${script}" --keep 5`, {
      cwd: root, encoding: 'utf-8', timeout: 30_000, stdio: 'pipe',
    }).trim();
    if (output.includes('Freed') && !output.includes('Freed ~0KB')) {
      log(`session cleanup: ${output.split('\n').pop()}`);
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
    await sleep(HEALTH_INTERVAL);
  }
}

// ── Heartbeat — nudge idle bots to do autonomous work ──────────────

const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '', 10) || 30 * 60_000; // 30 min default

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
 * Periodic heartbeat: nudge idle bots to check NEXT.md.
 * Sends a message to the bot's room mentioning it by name, which triggers
 * the bot's trigger pattern and wakes it to do autonomous work.
 */
async function heartbeatLoop(conns: RoomConn[]): Promise<void> {
  await sleep(5 * 60_000); // wait 5 min before first heartbeat
  while (true) {
    try {
      const root = resolveRoot();
      const botRooms = buildBotRoomMap();
      for (const bot of getActiveBots()) {
        if (liveFleet[bot]?.status !== 'onduty') continue; // not on duty — skip nudges
        if (hasRunningContainer(bot)) continue; // container running — active
        // Also check heartbeat file: if written recently, bot just restarted — skip nudge
        try {
          const hbPath = path.join(root, '_runtime', 'instances', bot, 'data', 'heartbeat');
          const hbAge = Date.now() - fs.statSync(hbPath).mtimeMs;
          if (hbAge < HEARTBEAT_INTERVAL) continue; // heartbeat recent — not truly idle
        } catch { /* no heartbeat file — proceed */ }
        const roomName = botRooms[bot];
        if (!roomName) continue;
        const conn = conns.find((c) => c.name === roomName);
        if (!conn?.accessToken) continue;
        // Get the bot's display name for the trigger
        const env = loadProfileEnv(root, bot);
        const name = env?.ASSISTANT_NAME || bot;
        await relaySend(conn.homeserver, conn.accessToken, conn.roomId,
          `${name}, check NEXT.md and work on the highest priority item you can act on.`);
        log(`heartbeat: nudged ${name} in ${roomName}`);
      }
    } catch (err) {
      log(`heartbeat error: ${errStr(err)}`);
    }
    await sleep(HEARTBEAT_INTERVAL);
  }
}

// ── Command handling ───────────────────────────────────────────────

async function handleLifecycleCommand(
  action: 'join' | 'dismiss' | 'refresh' | 'sleep' | 'wake',
  target: string | undefined,
  conn: RoomConn,
): Promise<void> {
  const root = resolveRoot();
  const bots = resolveBots(target, conn.name, action);

  // No local bots matched — silently ignore. Another ship handles it,
  // or the room simply has no bots from this ship.
  if (bots.length === 0) return;

  if (action !== 'dismiss' && action !== 'sleep') {
    if (!isShipActive()) {
      await reply(conn, `ship is decommissioned — use !commission first`);
      return;
    }
    try { ensurePodmanReady(); } catch (err) {
      await reply(conn, `podman not ready — ${errStr(err)}`);
      return;
    }
  }

  for (const bot of bots) {
    const env = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
    const name = env?.ASSISTANT_NAME || bot;
    const rank = liveFleet[bot]?.rank ?? 99;
    log(`!${action} ${name}`);

    // Resolve ship room IDs for room management
    const ships = (() => { try { return loadShips(); } catch { return {}; } })();
    const loungeId = ships[HOSTNAME]?.loungeId as string | undefined;
    const dutyRoomId = conn.roomId;

    if (action === 'dismiss') {
      // Dismiss: stop bot, downgrade brain to sonnet, disable lobes, move to lounge
      try {
        stopBot(bot);
        killStaleContainers(bot);
        // Save current brain model and downgrade to sonnet
        const config = loadShipConfig();
        const envFile = path.join(config.secretsPath, 'bots', bot, 'env');
        if (env?.BRAIN_MODEL && env.BRAIN_MODEL !== 'claude-sonnet-4-6') {
          fleetUpdate(bot, { activeBrainModel: env.BRAIN_MODEL });
        }
        try {
          upsertEnvLine(envFile, 'BRAIN_MODEL', 'claude-sonnet-4-6');
          upsertEnvLine(envFile, 'CONTAINER_ENV_LOBES_DISABLED', '1');
          log(`${name}: brain downgraded to sonnet, lobes disabled`);
        } catch (envErr) {
          log(`${name}: env update failed (non-fatal): ${errStr(envErr)}`);
        }
        // Move bot: leave duty room → join lounge
        try {
          const { token: botToken, homeserver, userId: botUserId } = await botMatrixLogin(root, bot);
          await botLeaveRoom(botToken, homeserver, dutyRoomId);
          if (loungeId) await botJoinRoom(botToken, homeserver, loungeId, conn, botUserId);
          log(`${name}: moved to lounge`);
        } catch (roomErr) {
          log(`${name}: room move failed (non-fatal): ${errStr(roomErr)}`);
        }
        fleetUpdate(bot, { status: 'lounge' });
        await reply(conn, `🔴 ${name} dismissed → lounge (sonnet, no lobes)`);
        publishFleetReport().catch(() => {});
      } catch (err) {
        log(`!dismiss ${name} failed: ${errStr(err)}`);
        await reply(conn, `⛔ !dismiss ${name} — ${errStr(err)}`);
      }
    } else if (action === 'sleep') {
      // Sleep: hard stop — move to quarters, stop container
      try {
        stopBot(bot);
        killStaleContainers(bot);
        const quartersRoomId = liveFleet[bot]?.quartersRoom;
        // Move bot: leave current room (duty or lounge) → quarters only
        try {
          const { token: botToken, homeserver, userId: botUserId } = await botMatrixLogin(root, bot);
          await botLeaveRoom(botToken, homeserver, dutyRoomId);
          if (loungeId) await botLeaveRoom(botToken, homeserver, loungeId);
          log(`${name}: moved to quarters (sleeping)`);
        } catch (roomErr) {
          log(`${name}: room move failed (non-fatal): ${errStr(roomErr)}`);
        }
        fleetUpdate(bot, { status: 'sleep' });
        await reply(conn, `😴 ${name} sleeping (quarters, container stopped)`);
        publishFleetReport().catch(() => {});
      } catch (err) {
        log(`!sleep ${name} failed: ${errStr(err)}`);
        await reply(conn, `⛔ !sleep ${name} — ${errStr(err)}`);
      }
    } else if (action === 'wake') {
      // Wake: restart in quarters (bot stays in quarters room, not duty room)
      const startedAt = Date.now();
      const role = env?.ASSISTANT_ROLE || liveFleet[bot]?.role || '?';
      const threadRoot = await reply(conn, `☀️ ${name} waking`);
      if (!threadRoot) continue;
      const step = (text: string) => threadReply(conn, threadRoot, `[${formatDuration(Date.now() - startedAt)}] ${text}`);
      try {
        await step('building...');
        fleetUpdate(bot, { status: 'quarters' }); // awake but not on duty
        writeFleet(liveFleet);
        clearShipConfigCache();
        bootstrapBot(root, bot);
        const model = env?.BRAIN_MODEL || '?';
        const ver = botVersion(root, bot);
        await step(`✅ awake · ${role}[${rank}] · ${model} · ${HOSTNAME}${ver}`);
        await reply(conn, `☀️ ${name} awake (quarters)`);
        publishFleetReport().catch(() => {});
      } catch (err) {
        log(`!wake ${name} failed: ${errStr(err)}`);
        const fail = `⛔ !wake ${name} — ${errStr(err)}`;
        await step(fail);
        await reply(conn, fail);
      }
    } else {
      // Join: no-op if already onduty
      if (action === 'join' && liveFleet[bot]?.status === 'onduty') {
        await reply(conn, `${name} is already on duty`);
        continue;
      }
      // Join is slow (build) — use a thread
      const startedAt = Date.now();
      const role = env?.ASSISTANT_ROLE || liveFleet[bot]?.role || '?';
      const threadRoot = await reply(conn, `🟢 ${name} joining`);
      if (!threadRoot) continue;
      const step = (text: string) => threadReply(conn, threadRoot, `[${formatDuration(Date.now() - startedAt)}] ${text}`);
      try {
        // Restore brain model and enable lobes
        const config = loadShipConfig();
        const envFile = path.join(config.secretsPath, 'bots', bot, 'env');
        const savedModel = liveFleet[bot]?.activeBrainModel;
        if (savedModel) {
          try {
            upsertEnvLine(envFile, 'BRAIN_MODEL', savedModel);
            upsertEnvLine(envFile, 'CONTAINER_ENV_LOBES_DISABLED', '');
            log(`${name}: brain restored to ${savedModel}, lobes enabled`);
          } catch (envErr) {
            log(`${name}: env restore failed (non-fatal): ${errStr(envErr)}`);
          }
        } else {
          try {
            upsertEnvLine(envFile, 'CONTAINER_ENV_LOBES_DISABLED', '');
          } catch { /* ignore */ }
        }
        fleetUpdate(bot, { status: 'onduty', ship: HOSTNAME });
        writeFleet(liveFleet);
        clearShipConfigCache();
        // Move bot: leave lounge → join duty room
        try {
          const { token: botToken, homeserver, userId: botUserId } = await botMatrixLogin(root, bot);
          if (loungeId) await botLeaveRoom(botToken, homeserver, loungeId);
          await botJoinRoom(botToken, homeserver, dutyRoomId, conn, botUserId);
          await step('room joined');
        } catch (roomErr) {
          log(`${name}: room move failed (non-fatal): ${errStr(roomErr)}`);
          await step(`room move failed: ${errStr(roomErr)}`);
        }
        // Sync latest code before starting
        const syncResult = gitSync();
        if (!syncResult.ok) {
          await step(`⚠️ code sync failed — ${syncResult.output.slice(0, 100)}`);
        } else if (syncResult.newCommits > 0) {
          await step(`pulled ${syncResult.newCommits} commit(s), rebuilding...`);
          const buildResult = rebuildInfiniClaw();
          if (buildResult.includes('FAILED')) await step(`⚠️ rebuild failed — bot starting on previous build`);
        }
        await step('building...');
        bootstrapBot(root, bot);
        const model = env?.BRAIN_MODEL || '?';
        const ver = botVersion(root, bot);
        await step(`✅ online · ${role}[${rank}] · ${model} · ${HOSTNAME}${ver}`);
        await reply(conn, `✅ ${name} online`);
        publishFleetReport().catch(() => {});
        // Trigger the bot to acknowledge in the thread
        await threadReply(conn, threadRoot, `${name}, reporting for duty!`);
      } catch (err) {
        log(`!join ${name} failed: ${errStr(err)}`);
        const fail = `⛔ !join ${name} — ${errStr(err)}`;
        await step(fail);
        await reply(conn, fail);
      }
    }
  }

}

/** Lightweight refresh: stop → rebuild → start. No brain/lobe/room changes. */
async function handleRefresh(target: string | undefined, conn: RoomConn): Promise<void> {
  const root = resolveRoot();
  const bots = resolveBots(target, conn.name, 'join');
  if (bots.length === 0) return;

  if (!isShipActive()) {
    await reply(conn, `ship is decommissioned — use !commission first`);
    return;
  }
  try { ensurePodmanReady(); } catch (err) {
    await reply(conn, `podman not ready — ${errStr(err)}`);
    return;
  }

  for (const bot of bots) {
    const env = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
    const name = env?.ASSISTANT_NAME || bot;
    const role = env?.ASSISTANT_ROLE || liveFleet[bot]?.role || '?';
    const rank = liveFleet[bot]?.rank ?? 99;
    log(`!refresh ${name}`);

    const startedAt = Date.now();
    const threadRoot = await reply(conn, `🔄 ${name} refreshing`);
    if (!threadRoot) continue;
    const step = (text: string) => threadReply(conn, threadRoot, `[${formatDuration(Date.now() - startedAt)}] ${text}`);

    try {
      await step('refreshing...');
      refreshBot(root, bot);
      const model = env?.BRAIN_MODEL || '?';
      const ver = botVersion(root, bot);
      await step(`✅ refreshed · ${role}[${rank}] · ${model} · ${HOSTNAME}${ver}`);
      await reply(conn, `✅ ${name} refreshed`);
      publishFleetReport().catch(() => {});
    } catch (err) {
      log(`!refresh ${name} failed: ${errStr(err)}`);
      const fail = `⛔ !refresh ${name} — ${errStr(err)}`;
      await step(fail);
      await reply(conn, fail);
    }
  }
}

// ── Register command handlers with the registry ──────────────────

function registerRelayCommands(): void {
  registerHandlers({
    join: async (cmd, conn) => {
      const parsed = parseTarget(cmd, '!join');
      if (parsed.matched) await handleLifecycleCommand('join', parsed.target, conn);
    },
    dismiss: async (cmd, conn) => {
      const parsed = parseTarget(cmd, '!dismiss');
      if (parsed.matched) await handleLifecycleCommand('dismiss', parsed.target, conn);
    },
    rejoin: async (cmd, conn) => {
      const parsed = parseTarget(cmd, '!rejoin');
      if (parsed.matched) {
        await handleLifecycleCommand('dismiss', parsed.target, conn);
        await handleLifecycleCommand('join', parsed.target, conn);
      }
    },
    refresh: async (cmd, conn) => {
      const parsed = parseTarget(cmd, '!refresh');
      if (parsed.matched) await handleRefresh(parsed.target, conn);
    },
    sleep: async (cmd, conn) => {
      const parsed = parseTarget(cmd, '!sleep');
      if (parsed.matched) await handleLifecycleCommand('sleep', parsed.target, conn);
    },
    wake: async (cmd, conn) => {
      const parsed = parseTarget(cmd, '!wake');
      if (parsed.matched) await handleLifecycleCommand('wake', parsed.target, conn);
    },

    relay: async (cmd, conn) => {
      const arg = cmd.slice('!relay'.length).trim();

      // !relay — each ship reports only its own status (ship report)
      if (!arg) {
        const status = isOperatorRelayEnabled() ? '✅ on' : '🔇 off';
        await shipReport(conn, `${HOSTNAME}: operator relay ${status}`);
        return;
      }

      const [action, targetShip] = arg.split(/\s+/, 2);
      if (action !== 'on' && action !== 'off') {
        await reply(conn, `usage: !relay | !relay on [ship] | !relay off [ship]`);
        return;
      }
      if (targetShip && !isThisShip(targetShip)) return; // not for this ship

      try {
        const ships = loadShips();
        if (!ships[HOSTNAME]) { await reply(conn, `${HOSTNAME} not in ships.json`); return; }
        ships[HOSTNAME].operatorRelay = action === 'on';
        writeShips(ships);
        secretsGitCommit(['operator/ships.json'], `relay ${action} ${HOSTNAME}`);
        log(`operator relay ${action}`);
        await reply(conn, `${HOSTNAME}: operator relay ${action === 'on' ? 'on ✅' : 'off 🔇'}`);
      } catch (err) {
        await reply(conn, `!relay failed — ${errStr(err)}`);
      }
    },

    push: async (cmd, conn) => {
      const arg = cmd.slice('!push'.length).trim();
      const branch = arg || 'main';
      if (!/^[a-zA-Z0-9._\-/]+$/.test(branch) || branch.startsWith('-')) {
        await reply(conn, `⛔ !push: invalid branch name`);
        return;
      }
      const root = resolveRoot();
      const execOpts = { cwd: root, encoding: 'utf-8' as const, timeout: 30_000, stdio: 'pipe' as const };
      try {
        execFileSync('git', ['push', 'origin', branch], execOpts);
        const ver = repoVersion(root);
        await reply(conn, `✅ pushed ${branch} to origin ${ver}`);
      } catch (err) {
        log(`!push failed: ${errStr(err)}`);
        await reply(conn, `⛔ !push failed — ${errStr(err)}`);
      }
    },

    health: async (_cmd, conn) => {
      const report = runHealthCheck();
      if (report) await uploadHealthToS3(report);
      if (isSpeaker()) {
        await sleep(3_000);
        const reports = await fetchAllHealthReports();
        const summary = formatHealthSummary(reports);
        await speakerReport(conn, summary);
      }
    },

    decommission: async (cmd, conn) => {
      const targetShip = cmd.slice('!decommission'.length).trim() || null;
      if (targetShip && !isThisShip(targetShip)) return;
      try {
        const ships = loadShips();
        if (!ships[HOSTNAME]) { await reply(conn, `not in ships.json`); return; }
        for (const bot of getActiveBots()) {
          stopBot(bot);
          killStaleContainers(bot);
          fleetUpdate(bot, { status: 'sleep' });
        }
        ships[HOSTNAME].active = false;
        writeShips(ships);
        secretsGitCommit(['operator/ships.json'], `decommission ${HOSTNAME}: bots stopped, relay only`);
        await reply(conn, `decommissioned — all bots stopped, relay still running`);
      } catch (err) {
        await reply(conn, `decommission failed — ${errStr(err)}`);
      }
    },

    commission: async (cmd, conn) => {
      const targetShip = cmd.slice('!commission'.length).trim() || null;
      if (targetShip && !isThisShip(targetShip)) return;
      try {
        const ships = loadShips();
        if (!ships[HOSTNAME]) { await reply(conn, `not in ships.json`); return; }
        ships[HOSTNAME].active = true;
        writeShips(ships);
        secretsGitCommit(['operator/ships.json'], `commission ${HOSTNAME}`);
        const fleet = loadFleet();
        const root = resolveRoot();
        ensurePodmanReady();
        const started: string[] = [];
        for (const [name, entry] of Object.entries(fleet)) {
          if (entry.ship === HOSTNAME && entry.status === 'onduty') {
            bootstrapBot(root, name);
            started.push(name);
          }
        }
        await reply(conn, `commissioned — started ${started.join(', ') || 'no bots assigned'}`);
      } catch (err) {
        await reply(conn, `commission failed — ${errStr(err)}`);
      }
    },

    provision: async (cmd, conn) => {
      const target = cmd.slice('!provision'.length).trim() || null;
      const results: string[] = [];

      const syncRepo = (name: string, repoPath: string): string => {
        const resolved = repoPath.replace(/^~/, os.homedir());
        if (!fs.existsSync(path.join(resolved, '.git'))) return `${name}: not a git repo`;
        try {
          const opts = { cwd: resolved, encoding: 'utf-8' as const, timeout: 30_000, stdio: 'pipe' as const };
          execSync('git fetch origin', opts);
          const count = parseInt(execSync('git rev-list HEAD..origin/main --count', { ...opts, timeout: 5_000 }).trim(), 10) || 0;
          if (count === 0) return `${name}: up to date`;
          execSync('git pull --rebase', opts);
          return `${name}: pulled ${count} commit(s)`;
        } catch (err) {
          return `${name}: sync failed — ${errStr(err).slice(0, 200)}`;
        }
      };

      try {
        if (!target) {
          const secretsResult = secretsGitSync();
          results.push(formatSyncResult('secrets', secretsResult));
          const icResult = gitSync();
          results.push(formatSyncResult('infiniclaw', icResult));
          if (icResult.ok && icResult.newCommits > 0) results.push(rebuildInfiniClaw());
        } else if (target === 'secrets') {
          results.push(formatSyncResult('secrets', secretsGitSync()));
        } else if (target === 'infiniclaw') {
          const r = gitSync();
          results.push(formatSyncResult('infiniclaw', r));
          if (r.ok && r.newCommits > 0) results.push(rebuildInfiniClaw());
        } else {
          let paths: Record<string, string> = {};
          try {
            const configDir = path.dirname(secretsRepoPath());
            paths = JSON.parse(fs.readFileSync(path.join(configDir, 'paths.json'), 'utf-8'));
          } catch { /* no paths.json */ }
          if (paths[target]) {
            results.push(syncRepo(target, paths[target]));
          } else {
            await reply(conn, `unknown target "${target}" — not in paths.json`);
            return;
          }
        }
        await reply(conn, `${results.join('\n')}`);
      } catch (err) {
        await reply(conn, `!provision failed — ${errStr(err)}`);
      }
    },

    refit: async (cmd, conn) => {
      const targetShip = cmd.slice('!refit'.length).trim() || null;
      if (targetShip && !isThisShip(targetShip)) return;
      const startedAt = Date.now();

      const threadRoot = await reply(conn, statusLine('⚓', 'refit', 'starting', 0));
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

        const icResult = gitSync();
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
          const msg = refitResult('failed', warnings, errors, elapsed());
          await s(msg);
          await reply(conn, msg);
          return;
        }
        await s(stageOk('relay + dist rebuilt', relayVersion(root)));

        ensurePodmanReady();

        // Restart active bots via lightweight refresh (stop+kill+start, no room/brain changes)
        for (const bot of activeBots) {
          const bEnv = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
          const bName = bEnv?.ASSISTANT_NAME || bot;
          try {
            refreshBot(root, bot);
            await s(stageOk(`${bName} restarted`));
          } catch (err) {
            errors++;
            await s(stageFail(`${bName} restart`, ` — ${errStr(err)}`));
          }
        }

        persistFleet();
        await publishFleetReport().catch(() => {});
        const msg = refitResult('complete', warnings, errors, elapsed());
        await s(msg);
        await reply(conn, msg);
        await sleep(1_000);
        try {
          execSync('npx pm2 restart infiniclaw-relay', { cwd: resolveRoot(), encoding: 'utf-8', timeout: 10_000, stdio: 'pipe' });
        } catch { /* pm2 restart kills us */ }
      } catch (err) {
        errors++;
        const msg = refitResult('failed', warnings, errors, elapsed());
        await threadReply(conn, threadRoot, msg);
        await reply(conn, msg);
      }
    },

    transport: async (cmd, conn) => {
      const parts = cmd.slice('!transport '.length).trim().split(/\s+/);
      if (parts.length !== 2) {
        await reply(conn, `Usage: !transport <bot> <ship>`);
        return;
      }
      const [botInput, shipInput] = parts;
      const bot = botInput.toLowerCase();
      if (!liveFleet[bot]) { await reply(conn, `Unknown bot: ${botInput}`); return; }
      let targetShip: string;
      try {
        const ships = loadShips();
        const resolved = resolveShipName(shipInput, ships);
        if (!resolved) { await reply(conn, `Unknown ship: ${shipInput}`); return; }
        targetShip = resolved;
        if (!ships[targetShip].active) { await reply(conn, `${targetShip} is decommissioned`); return; }
      } catch { targetShip = shipInput; /* ships.json missing — skip validation */ }
      if (liveFleet[bot].ship !== HOSTNAME) return;
      try {
        stopBot(bot);
        killStaleContainers(bot);
        removeBotMounts(bot);
        fleetUpdate(bot, { status: 'transit', ship: targetShip });
        writeFleet(liveFleet);
        const result = secretsGitCommit(['bots/fleet.json'], `transport: ${bot} dematerialized → ${targetShip}`);
        fleetDirty = false;
        if (!result.ok) throw new Error(result.error);
        await reply(conn, `${bot} dematerialized — awaiting materialization on ${targetShip}`);
      } catch (err) {
        await reply(conn, `transport failed — ${errStr(err)}`);
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
        // Create the thread immediately for responsiveness
        const threadRoot = await reply(conn, '📋 Fleet');

        // Every ship publishes its report, then the speaker assembles
        const report = await publishFleetReport();

        if (!await electSpeaker()) return;

        const ships = (() => { try { return loadShips(); } catch { return {}; } })();
        const allShipNames = Object.keys(ships);
        const s3 = getS3Client();

        // Poll S3 for fresh reports (up to 5s), then read stale as fallback
        const freshReports: Record<string, FleetReport> = { [HOSTNAME]: report };
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
        const allBots: Record<string, FleetEntry & { name: string; gitVersion: string; localStatus: string }> = {};
        for (const [botId, entry] of Object.entries(liveFleet)) {
          allBots[botId] = { ...entry, name: botId, gitVersion: '', localStatus: entry.status };
        }
        for (const [, shipReport] of Object.entries(allReports)) {
          for (const [botId, botData] of Object.entries(shipReport.bots)) {
            if (allBots[botId]) {
              allBots[botId].name = botData.name;
              allBots[botId].gitVersion = botData.gitVersion;
              allBots[botId].localStatus = botData.status;
            }
          }
        }

        // Group by ship
        const byShip: Record<string, Array<[string, typeof allBots[string]]>> = {};
        for (const [botId, entry] of Object.entries(allBots)) {
          const s = entry.ship || 'drydock';
          (byShip[s] ??= []).push([botId, entry]);
        }
        for (const s of Object.keys(ships)) { byShip[s] ??= []; }

        const shipOrder = Object.keys(byShip).sort((a, b) => {
          if (a === 'drydock') return 1;
          if (b === 'drydock') return -1;
          return (ships[a]?.rank ?? 99) - (ships[b]?.rank ?? 99);
        });

        const lines: string[] = [];
        for (const shipName of shipOrder) {
          const sConfig = ships[shipName];
          const shipReport = allReports[shipName];

          if (shipName === 'drydock') {
            lines.push('🔧 drydock');
          } else {
            const rank = sConfig?.rank ?? '?';
            const shipIcon = sConfig?.active ? '⚓' : '🚫';
            let shipStatus: string;
            if (shipReport) {
              const isFresh = freshReports[shipName] != null;
              const rv = shipReport.relayVersion ?? '';
              shipStatus = isFresh ? rv : ` · last seen ${formatDuration(Date.now() - shipReport.ts)} ago${rv}`;
            } else {
              shipStatus = ' · unknown';
            }
            lines.push(`${shipIcon} ${shipName}[${rank}]${shipStatus}`);
          }

          const bots = byShip[shipName].sort((a, b) => a[1].rank - b[1].rank);
          for (const [i, [, entry]] of bots.entries()) {
            const isLast = i === bots.length - 1;
            const isCO = entry.status === 'onduty' && !Object.values(allBots).some(
              e => e.role === entry.role && e.status === 'onduty' && e.rank < entry.rank && e !== entry
            );

            let badge: string;
            if (entry.localStatus === 'transit') badge = '🚀';
            else if (entry.localStatus === 'sleep') badge = '💤';
            else if (entry.localStatus === 'warn') badge = '⚠️';
            else if (entry.localStatus === 'lounge') badge = '🍸';
            else if (entry.localStatus === 'quarters') badge = '🏠';
            else if (entry.localStatus !== 'onduty') badge = '❓';
            else if (isCO) badge = '⭐';
            else badge = '🟢';

            const prefix = isLast ? '\u00A0\u00A0└' : '\u00A0\u00A0├';
            lines.push(`${prefix} ${entry.name} ${badge} · ${entry.role}[${entry.rank}]${entry.gitVersion}`);
          }
        }

        if (threadRoot) await threadReply(conn, threadRoot, lines.join('\n'));
      } catch (err) {
        await reply(conn, `!fleet failed: ${errStr(err)}`);
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

      // Load active Thread Brain tasks for deep-link annotation
      const threadTasks = readThreadTasks();
      const homeserverDomain = conn.homeserver.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

      const lines: string[] = [];
      for (const bot of bots) {
        const env = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
        const name = env?.ASSISTANT_NAME || bot;
        lines.push(`📋 **${name}**`);

        // Threads dispatched by this bot
        const botThreadEntries = Object.entries(threadTasks).filter(([, t]) => !t.bot || t.bot === bot);

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
          const room = (env?.MAIN_GROUP_NAME || '').toLowerCase();
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

    allow: async (cmd, conn) => {
      const match = cmd.match(/^!allow\s+(\S+)\s+(\S+)(?:\s+(\d+))?$/);
      if (!match) { await reply(conn, 'Usage: !allow <bot> <path> [minutes]'); return; }
      const [, botName, hostPath, mins] = match;
      const local = getActiveBots();
      if (!local.includes(botName.toLowerCase())) return; // not on this ship
      const defaultDuration = 30;
      const parsedDuration = parseInt(mins ?? String(defaultDuration), 10);
      let duration = parsedDuration <= 0 ? defaultDuration : parsedDuration;
      if (duration > 1440) duration = 1440;
      try {
        grantMount(botName.toLowerCase(), hostPath, duration);
        const expiry = new Date(Date.now() + duration * 60 * 1000).toLocaleTimeString();
        await reply(conn, `✅ Mount granted to ${botName}: ${hostPath} (rw, expires ~${expiry})\nRestart required to pick up new mount.`);
      } catch (err) {
        await reply(conn, `⛔ !allow failed: ${errStr(err)}`);
      }
    },

    deny: async (cmd, conn) => {
      const match = cmd.match(/^!deny\s+(\S+)\s+(\S+)$/);
      if (!match) { await reply(conn, 'Usage: !deny <bot> <path>'); return; }
      const [, botName, hostPath] = match;
      const local = getActiveBots();
      if (!local.includes(botName.toLowerCase())) return; // not on this ship
      try {
        const removed = revokeMount(botName.toLowerCase(), hostPath);
        await reply(conn, `${removed ? `✅ Mount revoked: ${hostPath}` : `ℹ️ No mount found for: ${hostPath}`}`);
      } catch (err) {
        await reply(conn, `⛔ !deny failed: ${errStr(err)}`);
      }
    },
  });
}

/** Shared promote/demote handler */
async function handleRank(cmd: string, conn: RoomConn, allConns: RoomConn[], isPromote: boolean): Promise<void> {
  const direction = isPromote ? 'up' : 'down';
  const rawTarget = cmd.slice(isPromote ? '!promote '.length : '!demote '.length).trim();

  // Try ship name first (case-insensitive)
  const ships = (() => { try { return loadShips(); } catch { return null; } })();
  const shipName = ships ? resolveShipName(rawTarget, ships) : null;
  if (ships && shipName) {
    const target = shipName;
    if (!isSpeaker()) return;
    const result = rankSwap(Object.entries(ships), target, direction);
    if (!result) {
      await speakerReport(conn, `${target} is already ${isPromote ? 'highest' : 'lowest'} rank ship`);
      return;
    }
    writeShips(ships);
    secretsGitCommit(['operator/ships.json'], `rerank ships: ${result.target} #${result.targetRank}, ${result.swap} #${result.swapRank}`);
    await speakerReport(conn, `${result.target} now rank ${result.targetRank}, ${result.swap} now rank ${result.swapRank}`);
    return;
  }

  const target = rawTarget.toLowerCase();
  const local = getActiveBots();
  if (!local.includes(target)) return;
  if (!liveFleet[target]) { await reply(conn, `Unknown: ${rawTarget}`); return; }
  const role = liveFleet[target].role;
  const sameRole = Object.entries(liveFleet).filter(([_, b]) => b.role === role);
  const result = rankSwap(sameRole, target, direction);
  if (!result) {
    await reply(conn, `${target} is already ${isPromote ? 'highest' : 'lowest'} rank in ${role}`);
    return;
  }
  fleetUpdate(result.target, { rank: result.targetRank });
  fleetUpdate(result.swap, { rank: result.swapRank });
  writeFleet(liveFleet);
  secretsGitCommit(['bots/fleet.json'], `rerank ${role}: ${result.target} #${result.targetRank}, ${result.swap} #${result.swapRank}`);
  fleetDirty = false;
  await reply(conn, `${result.target} now rank ${result.targetRank}, ${result.swap} now rank ${result.swapRank} (in ${role})`);

  const root = resolveRoot();
  const botEnv = (() => { try { return loadProfileEnv(root, target); } catch { return null; } })();
  const swapEnv = (() => { try { return loadProfileEnv(root, result.swap); } catch { return null; } })();
  const botDisplayName = botEnv?.ASSISTANT_NAME || target;
  const swapDisplayName = swapEnv?.ASSISTANT_NAME || result.swap;
  const botRoom = (botEnv?.MAIN_GROUP_NAME || '').toLowerCase();

  const targetConn = allConns.find(c => c.name === botRoom) || conn;
  if (targetConn.accessToken) {
    await reply(targetConn, `${botDisplayName} reranked (rank ${result.targetRank})`);
    await reply(targetConn, `${swapDisplayName} reranked (rank ${result.swapRank})`);
  }
}

async function handleCommand(cmd: string, conn: RoomConn, allConns?: RoomConn[]): Promise<void> {
  // ! (bare) — print help (speaker only, one reply)
  if (cmd === '!') {
    await speakerReport(conn, buildHelpText());
    return;
  }
  await dispatch(cmd, conn, allConns || []);
}

async function reply(conn: RoomConn, text: string, threadRootId?: string): Promise<string | undefined> {
  const tagged = `[${HOSTNAME}] ${text}`;
  const ls = loadLoudspeakerConfig();
  if (ls) {
    const token = await getLoudspeakerToken(ls.homeserver, ls.username, ls.password);
    if (token) return relaySend(ls.homeserver, token, conn.roomId, tagged, threadRootId);
  }
  if (!conn.accessToken) return undefined;
  return relaySend(conn.homeserver, conn.accessToken, conn.roomId, tagged, threadRootId);
}

/** Alias: reply in a thread. */
async function threadReply(conn: RoomConn, threadRootId: string, text: string): Promise<string | undefined> {
  return reply(conn, text, threadRootId);
}

/** Ship report — every ship that receives the command replies with its own data. */
async function shipReport(conn: RoomConn, text: string): Promise<string | undefined> {
  return reply(conn, text);
}

/** Speaker report — only the lowest-rank active ship replies, avoiding duplicate aggregates. */
async function speakerReport(conn: RoomConn, text: string): Promise<string | undefined> {
  if (!isSpeaker()) return undefined;
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

  const { homeserver, accessToken, userId } = opConfig;
  if (!accessToken || !userId) {
    log('curtain: missing accessToken or userId in operator-matrix.json — skipping');
    return;
  }

  log(`curtain: watching BehindTheCurtain as ${userId}`);

  const filterId = await matrixCreateFilter(homeserver, accessToken, userId).catch(() => null);
  let syncToken: string | null = null;
  let retryDelay = RETRY_DELAY_BASE;

  // Initial sync to skip old messages
  while (!syncToken) {
    try {
      const initial = await matrixSync(homeserver, accessToken, null, filterId, 0);
      syncToken = initial.next_batch;
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
      retryDelay = RETRY_DELAY_BASE;

      const joinedRooms = data.rooms?.join;
      if (!joinedRooms) continue;

      for (const [rid, roomData] of Object.entries(joinedRooms)) {
        if (rid !== roomId) continue;
        for (const event of (roomData as any).timeline?.events || []) {
          if (event.type !== 'm.room.message') continue;
          if (event.content?.msgtype !== 'm.text') continue;
          if (event.sender === userId) continue; // skip own messages
          if (captainUserId && event.sender !== captainUserId) continue; // Captain only
          const body = event.content.body?.trim();
          if (!body) continue;

          const curtainConn: RoomConn = {
            name: 'BehindTheCurtain', roomId, homeserver,
            username: '', password: '', accessToken, syncToken, filterId, userId,
          };

          // ! commands — execute and reply to BehindTheCurtain
          if (body.startsWith('!')) {
            log(`curtain: command from ${event.sender}: ${body.slice(0, 80)}`);
            try {
              await handleCommand(body, curtainConn, []);
            } catch (err) {
              log(`curtain: command error: ${errStr(err)}`);
            }
            continue;
          }

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
      retryDelay = Math.min(retryDelay * 2, RETRY_DELAY_MAX);
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

  // Initial sync to get the since token (discard old events)
  while (!conn.syncToken) {
    try {
      await connectRoom(conn);
      const initial = await matrixSync(conn.homeserver, conn.accessToken!, conn.syncToken, conn.filterId, 0);
      conn.syncToken = initial.next_batch;
      retryDelay = RETRY_DELAY_BASE;
      log(`${conn.name}: initial sync done, watching for commands`);
    } catch (err) {
      log(`${conn.name}: initial sync failed (retry in ${Math.round(retryDelay / 1000)}s): ${errStr(err)}`);
      conn.accessToken = null;
      await sleep(retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_DELAY_MAX);
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
      retryDelay = RETRY_DELAY_BASE; // reset on success

      // Process timeline events
      const joinedRooms = data.rooms?.join;
      if (joinedRooms) {
        for (const events of Object.values(joinedRooms)) {
          for (const event of events.timeline?.events || []) {
            if (event.type !== 'm.room.message') continue;
            if (event.content?.msgtype !== 'm.text') continue;
            const body = event.content.body?.trim() || '';

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

            if (!body.startsWith('!')) continue;

            if (!isAuthorized(event.sender, captainUserId, operatorUserId)) {
              log(`${conn.name}: unauthorized command from ${event.sender}: ${body.slice(0, 50)}`);
              continue;
            }

            log(`${conn.name}: command from ${event.sender}: ${body}`);
            try {
              await handleCommand(body, conn, conns);
            } catch (err) {
              log(`${conn.name}: command error: ${errStr(err)}`);
              await reply(conn, `Command error: ${errStr(err)}`);
            }
          }
        }
      }
    } catch (err) {
      log(`${conn.name}: sync error (retry in ${Math.round(retryDelay / 1000)}s): ${errStr(err)}`);
      conn.accessToken = null;
      await sleep(retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_DELAY_MAX);
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

  // Ensure git hooks are installed
  try { installGitHooks(); } catch (err) { log(`git hooks install failed: ${errStr(err)}`); }

  // Initialize in-memory fleet state from fleet.json
  try {
    liveFleet = loadFleet();
    log(`fleet: loaded ${Object.keys(liveFleet).length} bot(s) from fleet.json`);
  } catch (err) {
    log(`fleet: failed to load fleet.json: ${errStr(err)}`);
  }

  // Persist fleet on shutdown
  const shutdown = () => {
    log('shutting down — persisting fleet state');
    persistFleet();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Start Matrix sync loops immediately so we catch up on lifecycle messages
  const loops = conns.map((conn, i) =>
    sleep(i * STARTUP_SYNC_DELAY).then(() => dialtone(conn, captainUserId, operatorUserId, conns)),
  );

  // Wait 30s for Matrix sync to catch up before bootstrapping bots
  log('warming up — syncing Matrix for 30s before bootstrap...');
  await sleep(30_000);

  // Bootstrap all bots assigned to this ship
  if (isShipActive()) {
    try {
      ensurePodmanReady();
      const root = resolveRoot();
      removeStaleProcesses();
      killStaleContainers();
      for (const [bot, entry] of Object.entries(liveFleet)) {
        if (entry.ship === HOSTNAME && entry.status === 'onduty') {
          try {
            bootstrapBot(root, bot);
            log(`bootstrap: ${bot} started`);
          } catch (err) {
            log(`bootstrap: ${bot} failed — ${errStr(err)}`);
          }
        }
      }
    } catch (err) {
      log(`bootstrap failed: ${errStr(err)}`);
    }
  } else {
    log('ship is decommissioned — skipping bot startup');
  }

  // Start background loops (non-blocking alongside room sync loops)
  healthLoop().catch((err) => log(`health loop fatal: ${errStr(err)}`));
  gitSyncLoop(conns).catch((err) => log(`git sync loop fatal: ${errStr(err)}`));
  relayTasksLoop(conns).catch((err) => log(`relay tasks loop fatal: ${errStr(err)}`));
  secretsSyncLoop(conns).catch((err) => log(`secrets sync loop fatal: ${errStr(err)}`));
  heartbeatLoop(conns).catch((err) => log(`heartbeat loop fatal: ${errStr(err)}`));
  curtainLoop(captainUserId).catch((err) => log(`curtain loop fatal: ${errStr(err)}`));

  await Promise.all(loops);
}

main().catch((err) => {
  log(`fatal: ${errStr(err)}`);
  process.exit(1);
});
