/**
 * Supervisor relay — lightweight Matrix watcher for fleet lifecycle.
 *
 * Connects to each room via its intercom account (from intercom.json),
 * watches for operator commands (!join, !dismiss, !restart), and manages
 * bots via pm2 — no CLI needed.
 *
 * Run: node dist/relay.js
 */
import { execFileSync, execSync } from 'child_process';
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
  ensurePodmanReady,
  killStaleContainers,
  loadProfileEnv,
  removeStaleProcesses,
} from './service.js';

// ── Types ──────────────────────────────────────────────────────────

interface IntercomConfig {
  homeserver: string;
  rooms: Record<string, {
    roomId: string;
    username: string;
    password: string;
  }>;
}

interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, {
      timeline?: {
        events?: Array<{
          type: string;
          sender: string;
          content?: { msgtype?: string; body?: string };
          event_id: string;
          origin_server_ts: number;
        }>;
      };
    }>;
  };
}

// RoomConn imported from command-registry.ts

// ── Config ─────────────────────────────────────────────────────────

const HOSTNAME = os.hostname();
const SYNC_TIMEOUT = 30_000;

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
const RETRY_DELAY_BASE = 10_000;
const RETRY_DELAY_MAX = 5 * 60_000; // cap at 5 minutes
const STARTUP_SYNC_DELAY = 3_000;

// Configurable intervals (env vars in milliseconds, or use defaults)
const GIT_SYNC_INTERVAL = parseInt(process.env.GIT_SYNC_INTERVAL || '', 10) || 10 * 60_000;    // default 10 min
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

type BotStatus = 'active' | 'dismissed' | 'transit';
type FleetEntry = { role: string; rank: number; ship: string | null; status: BotStatus; title?: string };
let liveFleet: Record<string, FleetEntry> = {};
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
    execSync('npm run build', {
      cwd: root, encoding: 'utf-8', timeout: 120_000, stdio: 'pipe',
      env: { ...process.env, PATH: `${nodeBinDir}:${process.env.PATH}` },
    });
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

function loadIntercomConfig(): IntercomConfig {
  const config = loadShipConfig();
  const configPath = path.join(config.secretsPath, 'operator', 'intercom.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
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

function resolveOperatorUserId(): string {
  try {
    const opFile = path.join(secretsRepoPath(), 'operator', 'operator-matrix.json');
    const config = JSON.parse(fs.readFileSync(opFile, 'utf-8'));
    return config.userId || '';
  } catch { return ''; }
}

/** Captain and operator are both fully trusted. */
function isAuthorized(sender: string, captainUserId: string, operatorUserId: string): boolean {
  return sender === captainUserId || sender === operatorUserId;
}

/** Is this ship the "speaker" — lowest-rank active ship? Used to avoid duplicate replies. */
// ── Git version helper ────────────────────────────────────────────

/** Get git version string for a bot's deployed instance: " · sha ↑N↓N (age)" */
/**
 * Git version string: ` · sha ↑0|↓N (age)`
 *
 * When distFile is provided, the sha is the commit at or before the file's
 * mtime and the age is relative to that mtime. When distFile is omitted or
 * doesn't exist, uses HEAD with HEAD commit time for age.
 */
function gitVersionStr(root: string, distFile?: string): string {
  const execOpts = { encoding: 'utf-8' as const, timeout: 5_000, stdio: 'pipe' as const };
  try {
    let sha: string;
    let ageMs: number;

    if (distFile && fs.existsSync(distFile)) {
      const mtime = fs.statSync(distFile).mtimeMs;
      ageMs = Date.now() - mtime;
      sha = execSync(`git log -1 --format=%h --before="${new Date(mtime).toISOString()}"`, { cwd: root, ...execOpts }).trim() ||
        execSync('git rev-parse --short HEAD', { cwd: root, ...execOpts }).trim();
    } else {
      sha = execSync('git rev-parse --short HEAD', { cwd: root, ...execOpts }).trim();
      const epoch = parseInt(execSync('git log -1 --format=%ct', { cwd: root, ...execOpts }).trim(), 10) * 1000;
      ageMs = Date.now() - epoch;
    }

    if (!sha) return '';
    let ud: string;
    if (distFile) {
      // Dist file mode: how far behind HEAD is the deployed artifact?
      const behind = parseInt(execSync(`git rev-list ${sha}..HEAD --count`, { cwd: root, ...execOpts }).trim(), 10) || 0;
      ud = behind === 0 ? '↑0' : `↓${behind}`;
    } else {
      // Repo mode: show relationship to origin
      const ahead = parseInt(execSync('git rev-list origin/main..HEAD --count', { cwd: root, ...execOpts }).trim(), 10) || 0;
      const behind = parseInt(execSync('git rev-list HEAD..origin/main --count', { cwd: root, ...execOpts }).trim(), 10) || 0;
      if (ahead > 0 && behind > 0) ud = `↑${ahead}↓${behind}`;
      else if (ahead > 0) ud = `↑${ahead}`;
      else if (behind > 0) ud = `↓${behind}`;
      else ud = '↑0';
    }
    return ` · ${sha} ${ud} (${formatDuration(ageMs)})`;
  } catch { return ''; }
}

/** Version string for the relay dist. */
function relayVersion(root: string): string {
  return gitVersionStr(root, path.join(root, 'dist', 'relay.js'));
}

/** Version string for a bot's deployed instance. */
function botVersion(root: string, bot: string): string {
  return gitVersionStr(root, path.join(root, '_runtime', 'instances', bot, 'dist', 'main.js'));
}

/** Version string for a repo (uses HEAD, no dist file). */
function repoVersion(repoDir: string): string {
  return gitVersionStr(repoDir);
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

// ── Matrix API helpers ─────────────────────────────────────────────

async function matrixLogin(homeserver: string, username: string, password: string): Promise<{ accessToken: string; userId: string }> {
  const resp = await fetch(`${homeserver}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      user: username,
      password,
      device_id: `relay-${HOSTNAME}`,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Login failed for ${username}: ${resp.status} ${body}`);
  }
  const data = await resp.json() as { access_token: string; user_id: string };
  return { accessToken: data.access_token, userId: data.user_id };
}

async function matrixCreateFilter(homeserver: string, token: string, userId: string): Promise<string> {
  const filter = {
    room: {
      timeline: { limit: 10, types: ['m.room.message'] },
      state: { types: [] },
      ephemeral: { types: [] },
      account_data: { types: [] },
    },
    presence: { types: [] },
    account_data: { types: [] },
  };
  const resp = await fetch(
    `${homeserver}/_matrix/client/v3/user/${encodeURIComponent(userId)}/filter`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(filter),
    },
  );
  if (!resp.ok) throw new Error(`Filter creation failed: ${resp.status}`);
  const data = await resp.json() as { filter_id: string };
  return data.filter_id;
}

async function matrixSync(
  homeserver: string,
  token: string,
  since: string | null,
  filterId: string | null,
  timeout: number,
): Promise<SyncResponse> {
  const params = new URLSearchParams({ timeout: String(timeout) });
  if (since) params.set('since', since);
  if (filterId) params.set('filter', filterId);
  const resp = await fetch(`${homeserver}/_matrix/client/v3/sync?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeout + 15_000),
  });
  if (!resp.ok) throw new Error(`Sync failed: ${resp.status}`);
  return resp.json() as Promise<SyncResponse>;
}

async function matrixSend(homeserver: string, token: string, roomId: string, text: string): Promise<string | undefined> {
  const txnId = `sv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const resp = await fetch(
    `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'm.text', body: text }),
    },
  );
  if (!resp.ok) {
    const body = await resp.text();
    log(`send failed to ${roomId}: ${resp.status} ${body}`);
    return undefined;
  }
  const data = await resp.json() as { event_id?: string };
  return data.event_id;
}

async function matrixSendThread(homeserver: string, token: string, roomId: string, threadRootId: string, text: string): Promise<string | undefined> {
  const txnId = `sv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const resp = await fetch(
    `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'm.text',
        body: text,
        'm.relates_to': {
          rel_type: 'm.thread',
          event_id: threadRootId,
        },
      }),
    },
  );
  if (!resp.ok) {
    const body = await resp.text();
    log(`thread send failed to ${roomId}: ${resp.status} ${body}`);
    return undefined;
  }
  const data = await resp.json() as { event_id?: string };
  return data.event_id;
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

/**
 * Resolve which local bots a command applies to.
 *
 * - Targeted (`!restart parker`): returns [parker] ONLY if parker is in
 *   this ship. Returns. Returns [] if not local (silent ignore —
 *   another ship.s relay handles it).
 *
 * - Untargeted (`!restart` in Engineering): returns local bots whose
 *   MAIN_GROUP_NAME matches the room the command arrived in.
 */
function resolveBots(target: string | undefined, roomName: string, action?: string): string[] {
  const local = getActiveBots();
  if (target) {
    if (local.includes(target)) return [target];
    // For !join, also match inactive bots assigned to this ship
    if (action === 'join' && liveFleet[target]?.ship === HOSTNAME) return [target];
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
    if (entry.status === 'active' && !running) {
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

    for (const [name, b] of Object.entries(bots)) {
      const oom = Number(b.oom_kills || 0);
      totalOom += oom;
      if (b.status === 'ACTIVE' || oom > 0) {
        const mem = b.rss_mb != null ? `RSS=${b.rss_mb}/${b.limit_mb}MB` : '';
        lines.push(`  ${name}: ${b.status} ${mem} OOM=${oom}`);
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

function gitSync(): { ok: boolean; output: string; newCommits: number } {
  const root = resolveRoot();
  const execOpts = { cwd: root, encoding: 'utf-8' as const, timeout: 30_000, stdio: 'pipe' as const };
  // Abort any stuck rebase from a previous failed sync
  if (fs.existsSync(path.join(root, '.git', 'REBASE_HEAD'))) {
    try { execSync('git rebase --abort', execOpts); } catch { /* ignore */ }
  }
  try {
    // Fetch first
    execSync('git fetch origin', execOpts);
    // Check how many new commits
    const countStr = execSync('git rev-list HEAD..origin/main --count', {
      ...execOpts, timeout: 5_000,
    }).trim();
    const newCommits = parseInt(countStr, 10) || 0;
    // Push local commits that are ahead of origin
    const aheadStr = execSync('git rev-list origin/main..HEAD --count', {
      ...execOpts, timeout: 5_000,
    }).trim();
    const aheadCount = parseInt(aheadStr, 10) || 0;
    if (aheadCount > 0) {
      try {
        execSync('git push origin main', { ...execOpts, timeout: 30_000 });
        log(`git sync: pushed ${aheadCount} local commit(s)`);
      } catch (pushErr) {
        log(`git sync: push failed: ${errStr(pushErr)}`);
      }
    }
    if (newCommits === 0) return { ok: true, output: 'up to date', newCommits: 0 };
    // Stash any uncommitted changes (bots may have WIP edits)
    let didStash = false;
    try {
      const stashOutput = execSync('git stash --include-untracked', execOpts).trim();
      didStash = !stashOutput.includes('No local changes');
    } catch (err) {
      const detail = execErrOutput(err);
      if (detail.includes('No local changes to save')) {
        didStash = false;
      } else {
        throw new Error(`git stash failed${detail ? `: ${detail}` : ''}`);
      }
    }
    const workingTreeStatus = execSync('git status --porcelain', execOpts).trim();
    if (workingTreeStatus) {
      throw new Error(`git working tree not clean after stash:\n${workingTreeStatus}`);
    }
    try {
      // Rebase
      const output = execSync('git rebase origin/main', execOpts).trim();
      return { ok: true, output, newCommits };
    } catch (rebaseErr) {
      // Origin is authoritative — abort and reset to origin/main
      log(`git sync: rebase conflict, resetting to origin/main`);
      try { execSync('git rebase --abort', execOpts); } catch { /* ignore */ }
      execSync('git reset --hard origin/main', execOpts);
      return { ok: true, output: 'reset to origin/main (rebase conflict auto-resolved)', newCommits };
    } finally {
      // Restore stashed changes
      if (didStash) {
        try { execSync('git stash pop', execOpts); } catch { /* conflict — leave in stash */ }
      }
    }
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
        const buildResult = rebuildInfiniClaw();
        log(`git sync: ${buildResult}`);
        if (buildResult.includes('FAILED')) {
          await reportFailure('code build', buildResult, conns);
        } else {
          await reportRecovery('code build', conns);
          // Restart running bots so they pick up new code (skip dismissed)
          for (const bot of getActiveBots()) {
            if (liveFleet[bot]?.status !== 'active') continue;
            try {
              bootstrapBot(resolveRoot(), bot);
              log(`git sync: restarted ${bot}`);
            } catch (err) {
              log(`git sync: failed to restart ${bot}: ${errStr(err)}`);
            }
          }
          // Restart relay itself to pick up new relay code
          try {
            log('git sync: restarting relay to pick up new code');
            execSync('npx pm2 restart infiniclaw-relay', { cwd: resolveRoot(), encoding: 'utf-8', timeout: 10_000, stdio: 'pipe' });
          } catch (err) {
            log(`git sync: relay self-restart failed: ${errStr(err)}`);
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

// ── Secrets repo sync ──────────────────────────────────────────

function secretsRepoPath(): string {
  return loadShipConfig().secretsPath;
}

/** Commit a change to the secrets repo: stash → add → commit → push → pop. */
function secretsGitCommit(files: string[], message: string): { ok: boolean; error?: string } {
  const cwd = secretsRepoPath();
  const opts = { cwd, encoding: 'utf-8' as const, timeout: 15_000, stdio: 'pipe' as const };
  try {
    // Stash any other uncommitted changes
    let didStash = false;
    try {
      const out = execSync('git stash --include-untracked', opts).trim();
      didStash = !out.includes('No local changes');
    } catch (err) {
      if (!execErrOutput(err).includes('No local changes')) {
        didStash = false;
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
  const opts = { cwd, encoding: 'utf-8' as const, timeout: 30_000, stdio: 'pipe' as const };
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
              fleetUpdate(bot, { status: 'active' });
              writeFleet(liveFleet);
              clearShipConfigCache(); // so bootstrapBot sees updated active state
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
                return target === HOSTNAME || target.toLowerCase() === 'all';
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
        const uploaded = await uploadHealthToS3(report);
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
const MIN_SESSION_AGE_MS = parseInt(process.env.MIN_SESSION_AGE_MS || '', 10) || 6 * 3_600_000; // 6h
const MAX_SESSION_AGE_MS = parseInt(process.env.MAX_SESSION_AGE_MS || '', 10) || 8 * 3_600_000; // 8h
const DREAM_DURATION_MS = parseInt(process.env.DREAM_DURATION_MS || '', 10) || 30 * 60_000; // 30m
const DREAM_IDLE_WINDOW_MS = parseInt(process.env.DREAM_IDLE_WINDOW_MS || '', 10) || 15 * 60_000; // 15m
const DREAM_LOOP_INTERVAL_MS = 5 * 60_000; // 5m

type DreamPhase = 'idle' | 'dreaming' | 'recycling';
const botDreamPhase = new Map<string, DreamPhase>();
const botDreamStartedAt = new Map<string, number>();
const botIdleSince = new Map<string, number>();
let dreamingBot: string | null = null; // only one at a time
// Bot state is tracked in liveFleet[bot].status: 'active' | 'dismissed' | 'transit'

/** Check if a bot has a running container. */
function hasRunningContainer(bot: string): boolean {
  try {
    const out = execSync(`podman ps --filter "name=nanoclaw-${bot}" --format "{{.Names}}"`, {
      encoding: 'utf-8', timeout: 5_000, stdio: 'pipe',
    }).trim();
    return out.length > 0;
  } catch { return false; }
}

/** Get container start time in ms for the bot's main container, or null if missing. */
function getContainerStartTime(bot: string): number | null {
  try {
    const out = execSync(`podman inspect nanoclaw-${bot}-main-* --format '{{.State.StartedAt}}'`, {
      encoding: 'utf-8', timeout: 5_000, stdio: 'pipe',
    }).trim();
    if (!out) return null;
    const ts = Date.parse(out.split('\n')[0].trim());
    return Number.isFinite(ts) ? ts : null;
  } catch { return null; }
}

async function dreamLoop(conns: RoomConn[]): Promise<void> {
  await sleep(2 * 60_000); // slight delay so room sync/login starts first
  while (true) {
    try {
      const now = Date.now();

      // Enforce dream duration for currently dreaming bot.
      if (dreamingBot) {
        const started = botDreamStartedAt.get(dreamingBot);
        if (started && now - started >= DREAM_DURATION_MS) {
          const bot = dreamingBot;
          botDreamPhase.set(bot, 'recycling');
          const taskPath = `/workspace/ipc/tasks/restart-${bot}-${now}.json`;
          fs.mkdirSync('/workspace/ipc/tasks', { recursive: true });
          fs.writeFileSync(taskPath, JSON.stringify({ type: 'restart_bot', bot }));
          log(`dream: ${bot} transitioned to recycling; wrote ${taskPath}`);
          botDreamStartedAt.delete(bot);
          botDreamPhase.set(bot, 'idle');
          dreamingBot = null;
        }
      }

      // Only one dreaming bot fleet-wide.
      if (dreamingBot) {
        await sleep(DREAM_LOOP_INTERVAL_MS);
        continue;
      }

      const root = resolveRoot();
      const botRooms = buildBotRoomMap();
      for (const bot of getActiveBots()) {
        if (liveFleet[bot]?.status !== 'active') continue; // inactive — skip dream cycles
        if (botDreamPhase.get(bot) === 'dreaming' || botDreamPhase.get(bot) === 'recycling') continue;

        const startTime = getContainerStartTime(bot);
        if (!startTime) {
          botIdleSince.delete(bot);
          continue;
        }

        const sessionAge = now - startTime;
        const isRunning = hasRunningContainer(bot);
        if (isRunning) botIdleSince.delete(bot);
        else if (!botIdleSince.has(bot)) botIdleSince.set(bot, now);

        const idleFor = isRunning ? 0 : now - (botIdleSince.get(bot) || now);
        const shouldDream = sessionAge > MAX_SESSION_AGE_MS
          || (sessionAge > MIN_SESSION_AGE_MS && !isRunning && idleFor >= DREAM_IDLE_WINDOW_MS);
        if (!shouldDream) continue;

        const roomName = botRooms[bot];
        if (!roomName) continue;
        const conn = conns.find((c) => c.name === roomName);
        if (!conn?.accessToken) continue;
        const env = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
        const name = env?.ASSISTANT_NAME || bot;
        await matrixSend(conn.homeserver, conn.accessToken, conn.roomId,
          `${name}, begin your dream period. Review recent conversation history, consolidate your memory files, and optimize your standing orders for a fresh session. You have ${Math.floor(DREAM_DURATION_MS / 60_000)} minutes. Reply when done.`);
        botDreamPhase.set(bot, 'dreaming');
        botDreamStartedAt.set(bot, now);
        dreamingBot = bot;
        log(`dream: ${bot} entered dreaming for ${Math.floor(DREAM_DURATION_MS / 60_000)} minutes`);
        break;
      }
    } catch (err) {
      log(`dream loop error: ${errStr(err)}`);
    }
    await sleep(DREAM_LOOP_INTERVAL_MS);
  }
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
        if (liveFleet[bot]?.status !== 'active') continue; // inactive — skip nudges
        if (hasRunningContainer(bot)) continue; // already working
        const roomName = botRooms[bot];
        if (!roomName) continue;
        const conn = conns.find((c) => c.name === roomName);
        if (!conn?.accessToken) continue;
        // Get the bot's display name for the trigger
        const env = loadProfileEnv(root, bot);
        const name = env?.ASSISTANT_NAME || bot;
        await matrixSend(conn.homeserver, conn.accessToken, conn.roomId,
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
  action: 'join' | 'dismiss' | 'restart',
  target: string | undefined,
  conn: RoomConn,
): Promise<void> {
  const root = resolveRoot();
  const bots = resolveBots(target, conn.name, action);

  // No local bots matched — silently ignore. Another ship handles it,
  // or the room simply has no bots from this ship.
  if (bots.length === 0) return;

  if (action !== 'dismiss') {
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
    try {
      if (action === 'dismiss') {
        stopBot(bot);
        killStaleContainers(bot);
        fleetUpdate(bot, { status: 'dismissed' });
        await reply(conn, `${name} dismissed`);
      } else if (action === 'join') {
        fleetUpdate(bot, { status: 'active', ship: HOSTNAME });
        writeFleet(liveFleet); // persist to disk BEFORE bootstrapBot reads it
        clearShipConfigCache(); // so bootstrapBot sees updated active state
        bootstrapBot(root, bot);
        await reply(conn, `${name} started (rank ${rank})`);
      } else {
        stopBot(bot);
        killStaleContainers(bot);
        bootstrapBot(root, bot);
        await reply(conn, `${name} restarted (rank ${rank})`);
      }
      publishFleetReport().catch(() => {}); // update S3 after state change
    } catch (err) {
      log(`!${action} ${name} failed: ${errStr(err)}`);
      await reply(conn, `failed to ${action} ${name} — ${errStr(err)}`);
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
    restart: async (cmd, conn) => {
      const parsed = parseTarget(cmd, '!restart');
      if (parsed.matched) await handleLifecycleCommand('restart', parsed.target, conn);
    },

    relay: async (cmd, conn) => {
      const text = cmd.slice('!relay'.length).trim();
      const SESSION = 'operator';
      try {
        let existed = true;
        try { execFileSync('tmux', ['has-session', '-t', SESSION], { stdio: 'pipe' }); } catch { existed = false; }
        if (!existed) {
          execFileSync('tmux', ['new-session', '-d', '-s', SESSION, '-c', path.dirname(loadShipConfig().secretsPath), 'claude'], { stdio: ['pipe', 'pipe', 'pipe'] });
          await sleep(3000);
        }
        if (text) {
          execFileSync('tmux', ['send-keys', '-t', SESSION, '-l', text], { stdio: 'pipe' });
          execFileSync('tmux', ['send-keys', '-t', SESSION, 'Enter'], { stdio: 'pipe' });
        }
        const status = existed ? 'sent to running operator' : 'started new operator session';
        await reply(conn, `${status}`);
      } catch (err) {
        log(`!relay failed: ${errStr(err)}`);
        await reply(conn, `!relay failed — ${errStr(err)}`);
      }
    },

    health: async (_cmd, conn) => {
      const report = runHealthCheck();
      if (report) await uploadHealthToS3(report);
      if (isSpeaker()) {
        await sleep(3_000);
        const reports = await fetchAllHealthReports();
        const summary = formatHealthSummary(reports);
        await reply(conn, summary);
      }
    },

    decommission: async (cmd, conn) => {
      const targetShip = cmd.slice('!decommission'.length).trim() || null;
      if (targetShip && targetShip !== HOSTNAME) return;
      try {
        const ships = loadShips();
        if (!ships[HOSTNAME]) { await reply(conn, `not in ships.json`); return; }
        for (const bot of getActiveBots()) {
          stopBot(bot);
          killStaleContainers(bot);
          fleetUpdate(bot, { status: 'dismissed' });
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
      if (targetShip && targetShip !== HOSTNAME) return;
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
          if (entry.ship === HOSTNAME && entry.status === 'active') {
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
      if (targetShip && targetShip !== HOSTNAME) return;
      const startedAt = Date.now();

      const threadRoot = await reply(conn, statusLine('⚓', 'refit', 'starting', 0));
      if (!threadRoot) return;
      const elapsed = () => Date.now() - startedAt;

      // All bots on this ship get deployed; only active get started
      const localBots = Object.entries(liveFleet)
        .filter(([, e]) => e.ship === HOSTNAME)
        .map(([name]) => name);
      const activeBots = getActiveBots();
      const inactiveBots = localBots.filter(b => !activeBots.includes(b));

      // Stages: sync secrets, sync code, build, deploy inactive, bootstrap active, done
      const totalStages = 3 + inactiveBots.length + activeBots.length + 1;
      let stage = 0;
      const s = (text: string) => threadReply(conn, threadRoot, `[${++stage}/${totalStages} ${formatDuration(elapsed())}] ${text}`);

      try {
        const root = resolveRoot();

        const secretsResult = secretsGitSync();
        const secretsVer = repoVersion(secretsRepoPath());
        if (!secretsResult.ok) {
          await s(stageWarn('secrets sync failed', secretsVer));
        } else if (secretsResult.newCommits > 0) {
          await s(stageOk(`secrets pulled ${secretsResult.newCommits} commit(s)`, secretsVer));
        } else {
          await s(stageOk('secrets up to date', secretsVer));
        }

        const icResult = gitSync();
        const codeVer = repoVersion(root);
        if (!icResult.ok) {
          await s(stageWarn('code sync failed', codeVer));
        } else if (icResult.newCommits > 0) {
          await s(stageOk(`code pulled ${icResult.newCommits} commit(s)`, codeVer));
        } else {
          await s(stageOk('code up to date', codeVer));
        }

        const buildResult = rebuildInfiniClaw();
        if (buildResult.includes('FAILED')) {
          await s(stageFail('relay + dist rebuild'));
          await reply(conn, statusLine('⛔', 'refit', 'failed', elapsed()));
          return;
        }
        await s(stageOk('relay + dist rebuilt', relayVersion(root)));

        ensurePodmanReady();

        // Deploy inactive bots (container image rebuild + instance sync, no start)
        for (const bot of inactiveBots) {
          try {
            deployBot(root, bot);
            await s(stageOk(`${bot} deployed`, botVersion(root, bot)));
          } catch (err) {
            const link = await uploadErrorLog(`deploy-${bot}`, err);
            await s(stageFail(`${bot} deploy failed`, link));
          }
        }

        // Bootstrap active bots (deploy + start)
        for (const bot of activeBots) {
          try {
            bootstrapBot(root, bot);
            await s(stageOk(`${bot} restarted`, botVersion(root, bot)));
          } catch (err) {
            const link = await uploadErrorLog(`restart-${bot}`, err);
            await s(stageFail(`${bot} restart failed`, link));
          }
        }

        persistFleet();
        await publishFleetReport().catch(() => {});
        const msg = statusLine('✅', 'refit', 'complete', elapsed());
        await s(msg);
        await reply(conn, msg);
        await sleep(1_000);
        try {
          execSync('npx pm2 restart infiniclaw-relay', { cwd: resolveRoot(), encoding: 'utf-8', timeout: 10_000, stdio: 'pipe' });
        } catch { /* pm2 restart kills us */ }
      } catch (err) {
        const msg = statusLine('⛔', 'refit', 'failed', elapsed());
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
      const [bot, targetShip] = parts;
      if (!liveFleet[bot]) { await reply(conn, `Unknown bot: ${bot}`); return; }
      try {
        const ships = loadShips();
        if (!ships[targetShip]) { await reply(conn, `Unknown ship: ${targetShip}`); return; }
        if (!ships[targetShip].active) { await reply(conn, `${targetShip} is decommissioned`); return; }
      } catch { /* ships.json missing — skip validation */ }
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
          for (const [, entry] of bots) {
            const isCO = entry.status === 'active' && !Object.values(allBots).some(
              e => e.role === entry.role && e.status === 'active' && e.rank < entry.rank && e !== entry
            );

            let badge: string;
            if (entry.localStatus === 'transit') badge = '🚀';
            else if (entry.localStatus === 'warn') badge = '⚠️';
            else if (entry.localStatus !== 'active') badge = '💤';
            else if (isCO) badge = '⭐';
            else badge = '🟢';

            lines.push(`      ${entry.name} ${badge} · ${entry.role}[${entry.rank}]${entry.gitVersion}`);
          }
        }

        await reply(conn, lines.join('\n'));
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
      const lines: string[] = [];
      for (const bot of bots) {
        const env = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
        const name = env?.ASSISTANT_NAME || bot;
        const room = (env?.MAIN_GROUP_NAME || '').toLowerCase();
        const statusPath = path.join(root, '_runtime', 'data', 'ipc', room, 'status.json');
        lines.push(`📋 ${name}`);
        try {
          const snap = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
          const g = snap.groups?.find((s: { folder: string }) => s.folder === room);
          const objective = g?.lastProgress || g?.currentObjective;
          lines.push(g?.active ? `Currently: ${objective ? objective.slice(0, 200) : 'working'}` : 'Currently: idle');
        } catch { lines.push('Currently: unknown'); }
        lines.push('');
      }
      await reply(conn, lines.join('\n').trim());
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
  const target = cmd.slice(isPromote ? '!promote '.length : '!demote '.length).trim();

  const ships = (() => { try { return loadShips(); } catch { return null; } })();
  if (ships && ships[target]) {
    if (!isSpeaker()) return;
    const result = rankSwap(Object.entries(ships), target, direction);
    if (!result) {
      await reply(conn, `${target} is already ${isPromote ? 'highest' : 'lowest'} rank ship`);
      return;
    }
    writeShips(ships);
    secretsGitCommit(['operator/ships.json'], `rerank ships: ${result.target} #${result.targetRank}, ${result.swap} #${result.swapRank}`);
    await reply(conn, `${result.target} now rank ${result.targetRank}, ${result.swap} now rank ${result.swapRank}`);
    return;
  }

  const local = getActiveBots();
  if (!local.includes(target)) return;
  if (!liveFleet[target]) { await reply(conn, `Unknown: ${target}`); return; }
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
    if (!isSpeaker()) return;
    await reply(conn, buildHelpText());
    return;
  }
  await dispatch(cmd, conn, allConns || []);
}

async function reply(conn: RoomConn, text: string): Promise<string | undefined> {
  if (!conn.accessToken) return undefined;
  return matrixSend(conn.homeserver, conn.accessToken, conn.roomId, text);
}

async function threadReply(conn: RoomConn, threadRootId: string, text: string): Promise<string | undefined> {
  if (!conn.accessToken) return undefined;
  return matrixSendThread(conn.homeserver, conn.accessToken, conn.roomId, threadRootId, text);
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

function errStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function execErrOutput(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const maybe = err as { stdout?: unknown; stderr?: unknown };
  const stdout = typeof maybe.stdout === 'string' ? maybe.stdout.trim() : '';
  const stderr = typeof maybe.stderr === 'string' ? maybe.stderr.trim() : '';
  return [stdout, stderr].filter(Boolean).join('\n').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`starting on ${HOSTNAME}`);
  refreshLocalCommitEpoch();
  log(`relay commit epoch: ${localCommitEpoch}`);
  publishCommitEpoch().catch(() => {});
  registerRelayCommands();

  const intercom = loadIntercomConfig();
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
        if (entry.ship === HOSTNAME && entry.status === 'active') {
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
  secretsSyncLoop(conns).catch((err) => log(`secrets sync loop fatal: ${errStr(err)}`));
  heartbeatLoop(conns).catch((err) => log(`heartbeat loop fatal: ${errStr(err)}`));
  dreamLoop(conns).catch((err) => log(`dream loop fatal: ${errStr(err)}`));

  await Promise.all(loops);
}

main().catch((err) => {
  log(`fatal: ${errStr(err)}`);
  process.exit(1);
});
