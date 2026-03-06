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

import { loadMachineConfig, loadFleet, writeFleet, loadMachines, writeMachines, isMachineActive } from './machine-config.js';
import { removeBotMounts } from './allow-list.js';
import {
  resolveRoot,
  getActiveBots,
  bootstrapBot,
  stopBot,
  ensurePodmanReady,
  killStaleContainers,
  loadProfileEnv,
  updatePresence,
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

interface RoomConn {
  name: string;
  roomId: string;
  homeserver: string;
  username: string;
  password: string;
  accessToken: string | null;
  syncToken: string | null;
  filterId: string | null;
  userId: string | null;
}

// ── Config ─────────────────────────────────────────────────────────

const HOSTNAME = os.hostname();
const SYNC_TIMEOUT = 30_000;
const RETRY_DELAY_BASE = 10_000;
const RETRY_DELAY_MAX = 5 * 60_000; // cap at 5 minutes
const STARTUP_SYNC_DELAY = 3_000;

// ── In-memory fleet state (authoritative at runtime, persisted on shutdown) ──

type FleetEntry = { role: string; rank: number; machine: string | null; active: boolean; title?: string };
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

function loadIntercomConfig(): IntercomConfig {
  const config = loadMachineConfig();
  const configPath = path.join(config.secretsPath, 'operator', 'intercom.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function resolveCaptainUserId(): string {
  const root = resolveRoot();
  for (const bot of getActiveBots()) {
    try {
      const env = loadProfileEnv(root, bot);
      if (env.CAPTAIN_USER_ID) return env.CAPTAIN_USER_ID;
    } catch { /* skip */ }
  }
  return '';
}

function isAuthorized(sender: string, captainUserId: string): boolean {
  return sender === captainUserId || /-intercom:/.test(sender);
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

async function matrixSend(homeserver: string, token: string, roomId: string, text: string): Promise<void> {
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
  }
}

// ── Bot resolution (multi-machine aware) ───────────────────────────

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
 *   this machine's machine.json. Returns [] if not local (silent ignore —
 *   another machine's supervisor handles it).
 *
 * - Untargeted (`!restart` in Engineering): returns local bots whose
 *   MAIN_GROUP_NAME matches the room the command arrived in.
 */
function resolveBots(target: string | undefined, roomName: string): string[] {
  const local = getActiveBots();
  if (target) {
    return local.includes(target) ? [target] : [];
  }
  // No target — scope to bots in this room on this machine
  const botRooms = buildBotRoomMap();
  return local.filter((bot) => botRooms[bot] === roomName);
}

// ── Health check + S3 ─────────────────────────────────────────

const HEALTH_INTERVAL = 30 * 60_000; // 30 minutes
const HEALTH_S3_PREFIX = 'health';

function getS3Client(): { client: S3Client; bucket: string } | null {
  try {
    const config = loadMachineConfig();
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

function runHealthCheck(): string | null {
  const root = resolveRoot();
  const script = path.join(root, 'scripts', 'health-check.sh');
  if (!fs.existsSync(script)) return null;
  try {
    return execSync(`MACHINE_NAME="${HOSTNAME}" bash "${script}" --json`, {
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

async function fetchAllHealthReports(): Promise<Array<{ machine: string; data: Record<string, unknown> }>> {
  const s3 = getS3Client();
  if (!s3) return [];
  const results: Array<{ machine: string; data: Record<string, unknown> }> = [];
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
        const machine = obj.Key.replace(`${HEALTH_S3_PREFIX}/`, '').replace('.json', '');
        results.push({ machine, data });
      } catch { /* skip corrupt reports */ }
    }
  } catch (err) {
    log(`S3 health fetch failed: ${errStr(err)}`);
  }
  return results;
}

function formatHealthSummary(reports: Array<{ machine: string; data: Record<string, unknown> }>): string {
  if (reports.length === 0) return '⚠️ No health reports available.';
  const lines: string[] = [`🏥 Fleet Health — ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC\n`];
  let totalOom = 0;
  let totalSessions = 0;

  for (const { machine, data } of reports) {
    const bots = (data.bots || {}) as Record<string, Record<string, unknown>>;
    const active = Object.entries(bots).filter(([, b]) => b.status === 'ACTIVE').map(([n]) => n);
    const ts = String(data.ts || '?').slice(0, 19);
    lines.push(`**${machine}** (${ts})`);
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

  lines.push(`**Totals:** ${reports.length} machines, ${totalOom} OOM kills, ${totalSessions}MB sessions`);
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

const GIT_SYNC_INTERVAL = 10 * 60_000; // 10 minutes

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
        // Notify all rooms so the engineer on this machine sees it
        const msg = `⚠️ ${HOSTNAME}: git sync failed — engineer please fix immediately.\n\`\`\`\n${result.output.slice(0, 500)}\n\`\`\``;
        for (const conn of conns) {
          if (conn.accessToken) {
            await reply(conn, msg).catch(() => {});
          }
        }
      } else if (result.newCommits > 0) {
        log(`git sync: pulled ${result.newCommits} new commit(s)`);
        // Rebuild after pulling new code
        const root = resolveRoot();
        try {
          const nodeBinDir = path.dirname(process.execPath);
          execSync('npm run build', {
            cwd: root, encoding: 'utf-8', timeout: 120_000, stdio: 'pipe',
            env: { ...process.env, PATH: `${nodeBinDir}:${process.env.PATH}` },
          });
          log('git sync: rebuild succeeded');
          // Hooks may have been updated by the pull
          try { installGitHooks(); } catch { /* best effort */ }
          // Deploy all dist/*.js to active bot instances and restart relay
          const distDir = path.join(root, 'dist');
          if (fs.existsSync(distDir)) {
            const jsFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));
            for (const bot of getActiveBots()) {
              const dstDir = path.join(root, '_runtime', 'instances', bot, 'dist');
              for (const f of jsFiles) {
                try { fs.copyFileSync(path.join(distDir, f), path.join(dstDir, f)); } catch { /* instance may not exist yet */ }
              }
            }
            log(`git sync: deployed ${jsFiles.length} dist files to instances`);
            // Restart all bots so they pick up new code
            for (const bot of getActiveBots()) {
              try {
                bootstrapBot(root, bot);
                log(`git sync: restarted ${bot}`);
              } catch (err) {
                log(`git sync: failed to restart ${bot}: ${errStr(err)}`);
              }
            }
          }
        } catch (err) {
          log(`git sync: rebuild FAILED: ${errStr(err)}`);
          const msg = `⚠️ ${HOSTNAME}: git pull succeeded (${result.newCommits} commits) but build failed — engineer please fix.\n\`\`\`\n${errStr(err).slice(0, 500)}\n\`\`\``;
          for (const conn of conns) {
            if (conn.accessToken) {
              await reply(conn, msg).catch(() => {});
            }
          }
        }
      } else {
        log('git sync: up to date');
      }
    } catch (err) {
      log(`git sync loop error: ${errStr(err)}`);
    }
    await sleep(GIT_SYNC_INTERVAL);
  }
}

// ── Secrets repo sync ──────────────────────────────────────────

const SECRETS_SYNC_INTERVAL = 30_000; // 30 seconds

function secretsRepoPath(): string {
  return loadMachineConfig().secretsPath;
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
      for (const f of files) execSync(`git add ${f}`, opts);
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, opts);
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
    if (newCommits === 0) return { ok: true, output: 'up to date', newCommits: 0 };
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
        for (const conn of conns) {
          if (conn.accessToken) {
            await reply(conn, `⚠️ ${HOSTNAME}: secrets repo sync failed — operator please fix.\n\`\`\`\n${result.output.slice(0, 500)}\n\`\`\``).catch(() => {});
          }
        }
      } else if (result.newCommits > 0) {
        log(`secrets sync: pulled ${result.newCommits} new commit(s)`);
        // Reload fleet.json from disk (may have transport assignments from other machines)
        try {
          const diskFleet = loadFleet();
          // Merge disk state into liveFleet — transport assignments come via git
          for (const [bot, entry] of Object.entries(diskFleet)) {
            if (!liveFleet[bot]) { liveFleet[bot] = entry; continue; }
            // Transport pickup: bot assigned to us but inactive (phase 1 by another machine)
            if (entry.machine === HOSTNAME && !entry.active && liveFleet[bot].machine !== HOSTNAME) {
              liveFleet[bot].machine = HOSTNAME;
              liveFleet[bot].active = false; // will be activated below
            }
          }
        } catch { /* no fleet on disk */ }

        // Check for transport pickups — bots assigned here but not active
        if (!isMachineActive()) { /* deactivated — skip transport pickup */ }
        else try {
          for (const [bot, entry] of Object.entries(liveFleet)) {
            if (entry.machine === HOSTNAME && !entry.active) {
              log(`secrets sync: transport pickup — activating ${bot}`);
              fleetUpdate(bot, { active: true });
              // Transport phase 2: write + push immediately so source machine sees completion
              writeFleet(liveFleet);
              secretsGitCommit(['bots/fleet.json'], `transport phase 2: ${bot} activated on ${HOSTNAME}`);
              fleetDirty = false;
              const root = resolveRoot();
              try {
                ensurePodmanReady();
                bootstrapBot(root, bot);
                updatePresence(root);
                for (const c of conns) {
                  if (c.accessToken) {
                    await reply(c, `${HOSTNAME}: ${bot} transported and started`).catch(() => {});
                  }
                }
              } catch (err) {
                log(`transport pickup failed for ${bot}: ${errStr(err)}`);
              }
            }
          }
        } catch (err) {
          log(`transport pickup check failed: ${errStr(err)}`);
        }
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
// Dismissed bots persist across relay restarts via a local file.
const DISMISSED_BOTS_FILE = path.join(os.homedir(), '.config', 'infiniclaw', 'dismissed-bots.json');

function loadDismissedBots(): Set<string> {
  try {
    if (fs.existsSync(DISMISSED_BOTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(DISMISSED_BOTS_FILE, 'utf-8'));
      if (Array.isArray(data)) return new Set(data.filter((x): x is string => typeof x === 'string'));
    }
  } catch { /* ignore */ }
  return new Set<string>();
}

function saveDismissedBots(set: Set<string>): void {
  try {
    fs.mkdirSync(path.dirname(DISMISSED_BOTS_FILE), { recursive: true });
    fs.writeFileSync(DISMISSED_BOTS_FILE, JSON.stringify([...set]));
  } catch { /* ignore */ }
}

const dismissedBots = loadDismissedBots(); // persisted across relay restarts

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
        if (dismissedBots.has(bot)) continue; // explicitly dismissed — skip dream cycles
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
        if (dismissedBots.has(bot)) continue; // explicitly dismissed — skip nudges
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
  const bots = resolveBots(target, conn.name);

  // No local bots matched — silently ignore. Another machine handles it,
  // or the room simply has no bots from this machine.
  if (bots.length === 0) return;

  if (action !== 'dismiss') {
    if (!isMachineActive()) {
      await reply(conn, `${HOSTNAME}: machine is deactivated — use !activate first`);
      return;
    }
    try { ensurePodmanReady(); } catch (err) {
      await reply(conn, `${HOSTNAME}: podman not ready — ${errStr(err)}`);
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
        dismissedBots.add(bot);
        saveDismissedBots(dismissedBots);
        fleetUpdate(bot, { active: false });
        await reply(conn, `${HOSTNAME}: ${name} stopped`);
      } else if (action === 'join') {
        dismissedBots.delete(bot);
        saveDismissedBots(dismissedBots);
        fleetUpdate(bot, { active: true, machine: HOSTNAME });
        bootstrapBot(root, bot);
        await reply(conn, `${HOSTNAME}: ${name} started (rank ${rank})`);
      } else {
        dismissedBots.delete(bot);
        saveDismissedBots(dismissedBots);
        stopBot(bot);
        killStaleContainers(bot);
        bootstrapBot(root, bot);
        await reply(conn, `${HOSTNAME}: ${name} restarted (rank ${rank})`);
      }
    } catch (err) {
      log(`!${action} ${name} failed: ${errStr(err)}`);
      await reply(conn, `${HOSTNAME}: failed to ${action} ${name} — ${errStr(err)}`);
    }
  }

  try { updatePresence(root); } catch { /* best effort */ }
}

async function handleCommand(cmd: string, conn: RoomConn, allConns?: RoomConn[]): Promise<void> {
  for (const action of ['join', 'dismiss', 'restart'] as const) {
    const parsed = parseTarget(cmd, `!${action}`);
    if (parsed.matched) {
      await handleLifecycleCommand(action, parsed.target, conn);
      return;
    }
  }

  // !operator — send text to operator tmux session
  if (cmd.startsWith('!operator')) {
    const text = cmd.slice('!operator'.length).trim();
    const SESSION = 'operator';
    try {
      let existed = true;
      try { execFileSync('tmux', ['has-session', '-t', SESSION], { stdio: 'pipe' }); } catch { existed = false; }
      if (!existed) {
        execFileSync('tmux', ['new-session', '-d', '-s', SESSION, '-c', path.dirname(loadMachineConfig().secretsPath), 'claude'], { stdio: ['pipe', 'pipe', 'pipe'] });
        await sleep(3000);
      }
      if (text) {
        execFileSync('tmux', ['send-keys', '-t', SESSION, '-l', text], { stdio: 'pipe' });
        execFileSync('tmux', ['send-keys', '-t', SESSION, 'Enter'], { stdio: 'pipe' });
      }
      const status = existed ? 'sent to running operator' : 'started new operator session';
      await reply(conn, `${HOSTNAME}: ${status}`);
    } catch (err) {
      log(`!operator failed: ${errStr(err)}`);
      await reply(conn, `${HOSTNAME}: !operator failed — ${errStr(err)}`);
    }
    return;
  }

  // !health — run health check, upload to S3, show fleet summary
  if (cmd === '!health') {
    // Run local health check and upload
    const report = runHealthCheck();
    if (report) {
      await uploadHealthToS3(report);
    }
    // Fetch all reports from S3 and show summary
    const reports = await fetchAllHealthReports();
    const summary = formatHealthSummary(reports);
    await reply(conn, summary);
    return;
  }

  // !deactivate — stop all bots on this machine, keep relay running
  if (cmd === '!deactivate') {
    try {
      const machines = loadMachines();
      if (!machines[HOSTNAME]) { await reply(conn, `${HOSTNAME}: not in machines.json`); return; }
      // Stop all running bots (fleet.json unchanged)
      for (const bot of getActiveBots()) {
        stopBot(bot);
        killStaleContainers(bot);
        dismissedBots.add(bot);
      }
      saveDismissedBots(dismissedBots);
      machines[HOSTNAME].active = false;
      writeMachines(machines);
      secretsGitCommit(['operator/machines.json'], `deactivate ${HOSTNAME}: bots stopped, relay only`);
      await reply(conn, `${HOSTNAME}: deactivated — all bots stopped, relay still running`);
    } catch (err) {
      await reply(conn, `${HOSTNAME}: deactivate failed — ${errStr(err)}`);
    }
    return;
  }

  // !activate — mark machine active, start bots assigned here
  if (cmd === '!activate') {
    try {
      const machines = loadMachines();
      if (!machines[HOSTNAME]) { await reply(conn, `${HOSTNAME}: not in machines.json`); return; }
      machines[HOSTNAME].active = true;
      writeMachines(machines);
      secretsGitCommit(['operator/machines.json'], `activate ${HOSTNAME}`);
      // Start bots that are active and assigned to this machine
      const fleet = loadFleet();
      const root = resolveRoot();
      ensurePodmanReady();
      const started: string[] = [];
      for (const [name, entry] of Object.entries(fleet)) {
        if (entry.machine === HOSTNAME && entry.active) {
          dismissedBots.delete(name);
          saveDismissedBots(dismissedBots);
          bootstrapBot(root, name);
          started.push(name);
        }
      }
      updatePresence(root);
      await reply(conn, `${HOSTNAME}: activated — started ${started.join(', ') || 'no bots assigned'}`);
    } catch (err) {
      await reply(conn, `${HOSTNAME}: activate failed — ${errStr(err)}`);
    }
    return;
  }

  // !transport <bot> <machine> — initiate bot transport to another machine
  if (cmd.startsWith('!transport ')) {
    const parts = cmd.slice('!transport '.length).trim().split(/\s+/);
    if (parts.length !== 2) {
      await reply(conn, `Usage: !transport <bot> <machine>`);
      return;
    }
    const [bot, targetMachine] = parts;
    if (!liveFleet[bot]) { await reply(conn, `Unknown bot: ${bot}`); return; }
    // Validate target machine
    try {
      const machines = loadMachines();
      if (!machines[targetMachine]) { await reply(conn, `Unknown machine: ${targetMachine}`); return; }
      if (!machines[targetMachine].active) { await reply(conn, `${targetMachine} is deactivated`); return; }
    } catch { /* machines.json missing — skip validation */ }
    if (liveFleet[bot].machine !== HOSTNAME) {
      // Not our bot — ignore, the other machine handles it
      return;
    }
    // Phase 1: stop bot, mark inactive, set machine to target
    // Transport is the exception — must write + push immediately so target machine picks up
    try {
      stopBot(bot);
      killStaleContainers(bot);
      dismissedBots.add(bot);
      saveDismissedBots(dismissedBots);
      removeBotMounts(bot);
      fleetUpdate(bot, { active: false, machine: targetMachine });
      writeFleet(liveFleet);
      const result = secretsGitCommit(['bots/fleet.json'], `transport: ${bot} → ${targetMachine}`);
      fleetDirty = false;
      if (!result.ok) throw new Error(result.error);
      await reply(conn, `${HOSTNAME}: ${bot} stopped and assigned to ${targetMachine}. Waiting for ${targetMachine} to pick up.`);
    } catch (err) {
      await reply(conn, `${HOSTNAME}: transport failed — ${errStr(err)}`);
    }
    return;
  }

  // !promote <bot> — swap rank with the bot above (lower rank number = higher priority)
  // !demote <bot> — swap rank with the bot below
  if (cmd.startsWith('!promote ') || cmd.startsWith('!demote ')) {
    const isPromote = cmd.startsWith('!promote');
    const bot = cmd.slice(isPromote ? '!promote '.length : '!demote '.length).trim();
    // Only the machine that owns the target bot handles the rank swap.
    // Other machines get rerank via Matrix lifecycle messages.
    const local = getActiveBots();
    if (!local.includes(bot)) return;
    if (!liveFleet[bot]) { await reply(conn, `Unknown bot: ${bot}`); return; }
    const role = liveFleet[bot].role;
    const sameRole = Object.entries(liveFleet)
      .filter(([_, b]) => b.role === role)
      .sort((a, b) => a[1].rank - b[1].rank);
    const idx = sameRole.findIndex(([name]) => name === bot);
    const swapIdx = isPromote ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sameRole.length) {
      await reply(conn, `${bot} is already ${isPromote ? 'highest' : 'lowest'} rank in ${role}`);
      return;
    }
    const [swapName] = sameRole[swapIdx];
    const oldRank = liveFleet[bot].rank;
    fleetUpdate(bot, { rank: liveFleet[swapName].rank });
    fleetUpdate(swapName, { rank: oldRank });
    await reply(conn, `${bot} now rank ${liveFleet[bot].rank}, ${swapName} now rank ${liveFleet[swapName].rank} (in ${role})`);

    // Send rerank lifecycle messages so bots update CO instantly
    const root = resolveRoot();
    const botEnv = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
    const swapEnv = (() => { try { return loadProfileEnv(root, swapName); } catch { return null; } })();
    const botDisplayName = botEnv?.ASSISTANT_NAME || bot;
    const swapDisplayName = swapEnv?.ASSISTANT_NAME || swapName;
    const botRoom = (botEnv?.MAIN_GROUP_NAME || '').toLowerCase();

    const targetConn = (allConns || []).find(c => c.name === botRoom) || conn;
    if (targetConn.accessToken) {
      await reply(targetConn, `${HOSTNAME}: ${botDisplayName} reranked (rank ${liveFleet[bot].rank})`);
      await reply(targetConn, `${HOSTNAME}: ${swapDisplayName} reranked (rank ${liveFleet[swapName].rank})`);
    }
    return;
  }

  // !fleet [room] — show fleet status with real running state
  if (cmd === '!fleet' || cmd === '!fleet room') {
    const roomOnly = cmd === '!fleet room';
    try {
      const fleet = liveFleet;
      const machines = (() => { try { return loadMachines(); } catch { return {}; } })();
      // Check real pm2 state on this machine
      let pm2Procs: Array<{ name: string; pm2_env?: { status?: string } }> = [];
      try {
        const out = execSync('npx pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
        pm2Procs = JSON.parse(out);
      } catch { /* empty */ }
      // Check real container state on this machine
      let runningContainers = new Set<string>();
      try {
        const out = execSync('podman ps --format "{{.Names}}" 2>/dev/null', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
        for (const line of out.trim().split('\n')) {
          const match = line.match(/^nanoclaw-([^-]+)-/);
          if (match) runningContainers.add(match[1]);
        }
      } catch { /* empty */ }

      const botRooms = buildBotRoomMap();

      // Filter bots if room-only
      const botEntries = Object.entries(fleet).filter(([name]) => {
        if (!roomOnly) return true;
        return botRooms[name] === conn.name;
      });

      if (roomOnly && botEntries.length === 0) return;

      // Real status for bots on this machine + mismatch detection
      const warnings: string[] = [];
      function botStatus(name: string, entry: { machine: string | null; active: boolean }): string {
        if (entry.machine !== HOSTNAME) {
          return entry.active ? '??' : 'OFF';
        }
        const pm2 = pm2Procs.find((p) => p.name === `infiniclaw-${name}`);
        const pm2Online = pm2?.pm2_env?.status === 'online';
        const hasContainer = runningContainers.has(name);
        const running = pm2Online || hasContainer;
        if (entry.active && !running) {
          warnings.push(`⚠️ ${name}: fleet says active but not running — restarting`);
          try { bootstrapBot(resolveRoot(), name); } catch { /* best effort */ }
        } else if (!entry.active && running) {
          warnings.push(`⚠️ ${name}: fleet says inactive but running — stopping`);
          try { stopBot(name); killStaleContainers(name); } catch { /* best effort */ }
        }
        if (pm2Online && hasContainer) return 'ON ';
        if (pm2Online) return 'PM2';
        if (hasContainer) return 'CTR';
        return 'OFF';
      }

      const lines: string[] = [];
      if (!roomOnly) {
        lines.push('**Machines**');
        for (const [name, m] of Object.entries(machines)) {
          lines.push(`  ${m.active ? 'ON ' : 'OFF'} ${name} (${m.os}, ${m.user || '?'})`);
        }
        lines.push('');
      }

      // Group by role
      const byRole: Record<string, typeof botEntries> = {};
      for (const entry of botEntries) {
        const role = entry[1].role;
        if (!byRole[role]) byRole[role] = [];
        byRole[role].push(entry);
      }
      lines.push(roomOnly ? `**${conn.name}**` : '**Bots**');
      for (const [role, bots] of Object.entries(byRole)) {
        lines.push(`  ${role}:`);
        for (const [name, entry] of bots.sort((a, b) => a[1].rank - b[1].rank)) {
          const status = botStatus(name, entry);
          lines.push(`    ${status} #${entry.rank} ${name} → ${entry.machine || 'unassigned'}`);
        }
      }
      if (warnings.length) lines.push('', ...warnings);
      await reply(conn, lines.join('\n'));
    } catch (err) {
      await reply(conn, `!fleet failed: ${errStr(err)}`);
    }
    return;
  }
}

async function reply(conn: RoomConn, text: string): Promise<void> {
  if (!conn.accessToken) return;
  await matrixSend(conn.homeserver, conn.accessToken, conn.roomId, text);
}

// ── Sync loop per room ─────────────────────────────────────────────

async function connectRoom(conn: RoomConn): Promise<void> {
  const { accessToken, userId } = await matrixLogin(conn.homeserver, conn.username, conn.password);
  conn.accessToken = accessToken;
  conn.userId = userId;
  conn.filterId = await matrixCreateFilter(conn.homeserver, accessToken, userId);
  log(`connected to ${conn.name} as ${userId}`);
}

async function dialtone(conn: RoomConn, captainUserId: string, conns: RoomConn[]): Promise<void> {
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
            // Skip non-command messages from self (intercom-send shares the same account).
            // ! commands from self ARE processed — echo loops are impossible since the
            // supervisor never sends !-prefixed messages.
            const body = event.content.body?.trim();
            if (!body || !body.startsWith('!')) continue;
            // At this point body starts with !, so even own messages are processed.

            if (!isAuthorized(event.sender, captainUserId)) {
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

  const intercom = loadIntercomConfig();
  const captainUserId = resolveCaptainUserId();
  if (!captainUserId) {
    log('WARNING: no CAPTAIN_USER_ID found in any bot env — only intercom senders will be authorized');
  } else {
    log(`captain: ${captainUserId}`);
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
    sleep(i * STARTUP_SYNC_DELAY).then(() => dialtone(conn, captainUserId, conns)),
  );

  // Wait 30s for Matrix sync to catch up before bootstrapping bots
  log('warming up — syncing Matrix for 30s before bootstrap...');
  await sleep(30_000);

  // Bootstrap all bots assigned to this machine
  if (isMachineActive()) {
    try {
      ensurePodmanReady();
      const root = resolveRoot();
      removeStaleProcesses();
      killStaleContainers();
      for (const [bot, entry] of Object.entries(liveFleet)) {
        if (entry.machine === HOSTNAME && entry.active) {
          try {
            bootstrapBot(root, bot);
            log(`bootstrap: ${bot} started`);
          } catch (err) {
            log(`bootstrap: ${bot} failed — ${errStr(err)}`);
          }
        }
      }
      updatePresence(root);
    } catch (err) {
      log(`bootstrap failed: ${errStr(err)}`);
    }
  } else {
    log('machine is deactivated — skipping bot startup');
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
