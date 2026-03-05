/**
 * Lightweight Matrix supervisor for bot lifecycle management.
 *
 * Connects to each room via its intercom account (from intercom.json),
 * watches for operator commands (!join, !dismiss, !restart), and manages
 * bots via pm2 — no CLI needed.
 *
 * Run: node dist/supervisor.js
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadMachineConfig } from './machine-config.js';
import {
  resolveRoot,
  getActiveBots,
  bootstrapBot,
  stopBot,
  ensurePodmanReady,
  killStaleContainers,
  loadProfileEnv,
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
      device_id: `supervisor-${HOSTNAME}`,
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
    try { ensurePodmanReady(); } catch (err) {
      await reply(conn, `${HOSTNAME}: podman not ready — ${errStr(err)}`);
      return;
    }
  }

  for (const bot of bots) {
    const env = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
    const name = env?.ASSISTANT_NAME || bot;
    log(`!${action} ${name}`);
    try {
      if (action === 'dismiss') {
        stopBot(bot);
        killStaleContainers(bot);
        await reply(conn, `${HOSTNAME}: ${name} stopped`);
      } else if (action === 'join') {
        bootstrapBot(root, bot);
        await reply(conn, `${HOSTNAME}: ${name} started`);
      } else {
        stopBot(bot);
        killStaleContainers(bot);
        bootstrapBot(root, bot);
        await reply(conn, `${HOSTNAME}: ${name} restarted`);
      }
    } catch (err) {
      log(`!${action} ${name} failed: ${errStr(err)}`);
      await reply(conn, `${HOSTNAME}: failed to ${action} ${name} — ${errStr(err)}`);
    }
  }
}

async function handleCommand(cmd: string, conn: RoomConn): Promise<void> {
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
        execFileSync('tmux', ['new-session', '-d', '-s', SESSION, '-c', loadMachineConfig().secretsPath, 'claude'], { stdio: ['pipe', 'pipe', 'pipe'] });
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

  // !roster — each machine reports its bots in this room
  if (cmd === '!roster') {
    const botRooms = buildBotRoomMap();
    const roomBots = getActiveBots().filter((b) => botRooms[b] === conn.name);
    if (roomBots.length === 0) return; // no local bots in this room
    // Check pm2 status for each bot
    let pm2Procs: Array<{ name: string; pm2_env?: { status?: string } }> = [];
    try {
      const { execSync } = await import('child_process');
      const out = execSync('npx pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
      pm2Procs = JSON.parse(out);
    } catch { /* empty */ }
    const lines = roomBots.map((bot) => {
      const proc = pm2Procs.find((p) => p.name === `infiniclaw-${bot}`);
      const running = proc?.pm2_env?.status === 'online';
      return `${running ? 'ON' : 'OFF'}  ${bot}`;
    });
    await reply(conn, `${HOSTNAME}:\n${lines.join('\n')}`);
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

async function dialtone(conn: RoomConn, captainUserId: string): Promise<void> {
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
            if (event.sender === conn.userId) continue;
            const body = event.content.body?.trim();
            if (!body || !body.startsWith('!')) continue;

            if (!isAuthorized(event.sender, captainUserId)) {
              log(`${conn.name}: unauthorized command from ${event.sender}: ${body.slice(0, 50)}`);
              continue;
            }

            log(`${conn.name}: command from ${event.sender}: ${body}`);
            try {
              await handleCommand(body, conn);
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
  console.error(`[${ts}] supervisor: ${msg}`);
}

function errStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

  // Stagger startup to avoid thundering herd
  const loops = conns.map((conn, i) =>
    sleep(i * STARTUP_SYNC_DELAY).then(() => dialtone(conn, captainUserId)),
  );

  await Promise.all(loops);
}

main().catch((err) => {
  log(`fatal: ${errStr(err)}`);
  process.exit(1);
});
