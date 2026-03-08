/**
 * Supervisor relay — lightweight Matrix watcher for fleet lifecycle.
 *
 * Connects to each room via its intercom account (from intercom.json),
 * watches for operator commands (!join, !dismiss, !restart), and manages
 * bots via pm2 — no CLI needed.
 *
 * Run: node dist/relay.js
 */
import { execFileSync, execSync, spawnSync } from 'child_process';
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

import { marked } from 'marked';
import { upsertEnvLine } from 'nanoclaw/env-utils.js';
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

import {
  shellQuote,
  formatDuration,
  formatTimestamp,
  errStr,
  resolveRoot,
  assertValidBotName,
} from './utils.js';
import { getGitVersion, getGitVersionStr } from './formatting.js';
import { fleetManager } from './fleet-manager.js';
import { pm2Stop, pm2StartBot, removeStaleProcesses, pm2Name } from './process-manager.js';
import { getS3Client, uploadToS3, getPresignedUrl } from './s3-service.js';
import { getGitRelation, getCommitAge, getRepoVersion, gitSync } from './git-service.js';
import { reportFailure, reportRecovery, statusLine } from './alert-manager.js';
import { matrixLogin, matrixSync, matrixSend, botJoinRoom, botLeaveRoom, SyncResponse } from './matrix-api.js';

const HOSTNAME = os.hostname();
const SYNC_TIMEOUT = 30_000;
const RETRY_DELAY_BASE = 10_000;
const RETRY_DELAY_MAX = 5 * 60_000; // cap at 5 minutes
const STARTUP_SYNC_DELAY = 3_000;

// Configurable intervals (env vars in milliseconds, or use defaults)
const GITHUB_REPO_URL = 'https://github.com/wawiesel/InfiniClaw';
const GIT_SYNC_INTERVAL = parseInt(process.env.GIT_SYNC_INTERVAL || '', 10) || 3 * 60_000;     // default 3 min
const SECRETS_SYNC_INTERVAL = parseInt(process.env.SECRETS_SYNC_INTERVAL || '', 10) || 30_000;  // default 30s
const HEALTH_INTERVAL = parseInt(process.env.HEALTH_INTERVAL || '', 10) || 30 * 60_000;         // default 30 min

// ── In-memory fleet state (authoritative at runtime, persisted on shutdown) ──

function fleetUpdate(bot: string, updates: Partial<FleetEntry>): void {
  fleetManager.updateBot(bot, updates);
}

function persistFleet(): void {
  fleetManager.persist();
}

// ── Rank swap (shared by bots and ships) ──────────────────────

/** Swap rank of target with its neighbor. Mutates entries in place. Returns null if at boundary. */
function rankSwap<T extends { rank: number }>(
  entries: [string, T][],
  target: string,
  direction: 'up' | 'down',
): { target: string; swap: string; targetRank: number; swapRank: number } | null {
  return fleetManager.rankSwap(entries, target, direction);
}

// ── Matrix API helpers ─────────────────────────────────────────────

async function reply(conn: RoomConn, text: string): Promise<string | undefined> {
  return matrixSend(conn.homeserver, conn.accessToken!, conn.roomId, text);
}

async function threadReply(conn: RoomConn, threadRootId: string, text: string): Promise<string | undefined> {
  return matrixSend(conn.homeserver, conn.accessToken!, conn.roomId, text, threadRootId);
}

// ── Bot Matrix room management ──────────────────────────────────

/** Login as a bot using its env file credentials. */
async function botMatrixLogin(root: string, bot: string): Promise<{ token: string; homeserver: string; userId: string }> {
  const env = loadProfileEnv(root, bot);
  const homeserver = env.MATRIX_HOMESERVER;
  const username = env.MATRIX_USERNAME;
  const password = env.MATRIX_PASSWORD;
  if (!homeserver || !username || !password) throw new Error(`${bot}: missing Matrix credentials in env`);
  const { accessToken, userId } = await matrixLogin(homeserver, username, password, `relay-${bot}-${HOSTNAME}`);
  return { token: accessToken, homeserver, userId };
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

function runHealthCheckLocal(): string | null {
  return runHealthCheck(HOSTNAME);
}

function formatHealthSummaryLocal(reports: Array<{ ship: string; data: Record<string, unknown> }>): string {
  return formatHealthSummary(reports);
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
    // Check if package-lock.json will change (need npm install after pull)
    let lockfileChanged = false;
    try {
      const diff = execSync('git diff HEAD..origin/main --name-only', { ...execOpts, timeout: 5_000 }).trim();
      lockfileChanged = diff.split('\n').some(f => f === 'package-lock.json');
    } catch { /* best effort */ }
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
    let output: string;
    try {
      // Rebase
      output = execSync('git rebase origin/main', execOpts).trim();
    } catch (rebaseErr) {
      // Origin is authoritative — abort and reset to origin/main
      log(`git sync: rebase conflict, resetting to origin/main`);
      try { execSync('git rebase --abort', execOpts); } catch { /* ignore */ }
      execSync('git reset --hard origin/main', execOpts);
      lockfileChanged = true; // force install after hard reset
      output = 'reset to origin/main (rebase conflict auto-resolved)';
    } finally {
      // Restore stashed changes
      if (didStash) {
        try { execSync('git stash pop', execOpts); } catch { /* conflict — leave in stash */ }
      }
    }
    // Install deps before build if lockfile changed — prevents chicken-and-egg
    // where new code imports a dep that hasn't been installed yet
    if (lockfileChanged) {
      try {
        log('git sync: package-lock.json changed, running npm install');
        execSync('npm install', { ...execOpts, timeout: 300_000 });
      } catch (err) {
        log(`git sync: npm install failed: ${errStr(err)}`);
      }
    }
    return { ok: true, output, newCommits };
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
            if (liveFleet[bot]?.status !== 'onduty') continue;
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

import { handleCommission, handleDecommission, handleProvision, handleRefit } from './commands/ship.js';
import { handleTransport, handleFleet } from './commands/fleet.js';
import { handleRelay, handleHealth, handleTodo, handleAllow } from './commands/misc.js';
import { handleLifecycleCommand } from './commands/lifecycle.js';


// ── Register command handlers with the registry ──────────────────

import { handleCommission, handleDecommission, handleProvision, handleRefit } from './commands/ship.js';
import { handleTransport, handleFleet } from './commands/fleet.js';
import { handleRelay, handleHealth, handleTodo, handleAllow } from './commands/misc.js';

function registerRelayCommands(): void {
  registerHandlers({
    join: async (cmd, conn) => {
      const target = cmd.slice('!join'.length).trim().toLowerCase() || undefined;
      await handleLifecycleCommand('join', target, conn);
    },
    dismiss: async (cmd, conn) => {
      const target = cmd.slice('!dismiss'.length).trim().toLowerCase() || undefined;
      await handleLifecycleCommand('dismiss', target, conn);
    },
    restart: async (cmd, conn) => {
      const target = cmd.slice('!restart'.length).trim().toLowerCase() || undefined;
      await handleLifecycleCommand('restart', target, conn);
    },
    sleep: async (cmd, conn) => {
      const target = cmd.slice('!sleep'.length).trim().toLowerCase() || undefined;
      await handleLifecycleCommand('sleep', target, conn);
    },
    wake: async (cmd, conn) => {
      const target = cmd.slice('!wake'.length).trim().toLowerCase() || undefined;
      await handleLifecycleCommand('wake', target, conn);
    },
    relay: handleRelay,
    health: handleHealth,
    decommission: handleDecommission,
    commission: handleCommission,
    provision: handleProvision,
    refit: handleRefit,
    transport: handleTransport,
    fleet: handleFleet,
    todo: handleTodo,
    allow: handleAllow,
    deny: async (cmd, conn) => {
      const match = cmd.match(/^!deny\s+(\S+)\s+(\S+)$/);
      if (!match) { await reply(conn, 'Usage: !deny <bot> <path>'); return; }
      const [, botName, hostPath] = match;
      try {
        const removed = revokeMount(botName.toLowerCase(), hostPath);
        await reply(conn, `${removed ? `✅ Mount revoked: ${hostPath}` : `ℹ️ No mount found for: ${hostPath}`}`);
      } catch (err) {
        await reply(conn, `⛔ !deny failed: ${errStr(err)}`);
      }
    },
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
  secretsSyncLoop(conns).catch((err) => log(`secrets sync loop fatal: ${errStr(err)}`));
  heartbeatLoop(conns).catch((err) => log(`heartbeat loop fatal: ${errStr(err)}`));

  await Promise.all(loops);
}

main().catch((err) => {
  log(`fatal: ${errStr(err)}`);
  process.exit(1);
});
