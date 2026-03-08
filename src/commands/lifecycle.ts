import { execSync, execFileSync } from 'child_process';
import { RoomConn } from '../command-registry.js';
import { resolveRoot, getActiveBots, bootstrapBot, stopBot, killStaleContainers, loadProfileEnv, ensurePodmanReady } from '../service.js';
import { formatDuration, errStr } from '../utils.js';
import { getGitVersionStr } from '../formatting.js';
import { fleetManager } from '../fleet-manager.js';
import { matrixSend, botMatrixLogin, botLeaveRoom, botJoinRoom } from '../matrix-api.js';
import os from 'os';
import path from 'path';
import { loadShipConfig, loadShips, clearShipConfigCache, writeFleet } from '../ship-config.js';
import { upsertEnvLine } from 'nanoclaw/env-utils.js';

const HOSTNAME = os.hostname();

async function reply(conn: RoomConn, text: string): Promise<string | undefined> {
  return matrixSend(conn.homeserver, conn.accessToken!, conn.roomId, text);
}

async function threadReply(conn: RoomConn, rootId: string, text: string): Promise<string | undefined> {
  return matrixSend(conn.homeserver, conn.accessToken!, conn.roomId, text, rootId);
}

function buildBotRoomMap(): Record<string, string> {
  const root = resolveRoot();
  const map: Record<string, string> = {};
  for (const bot of getActiveBots()) {
    try {
      const env = loadProfileEnv(root, bot);
      if (env.MAIN_GROUP_NAME) map[bot] = env.MAIN_GROUP_NAME.toLowerCase();
    } catch { /* skip */ }
  }
  return map;
}

function resolveBots(target: string | undefined, roomName: string, action?: string): string[] {
  const local = getActiveBots();
  if (target) {
    if (local.includes(target)) return [target];
    const liveFleet = fleetManager.getLiveFleet();
    if ((action === 'join' || action === 'sleep' || action === 'wake') && liveFleet[target]?.ship === HOSTNAME) return [target];
    return [];
  }
  const botRooms = buildBotRoomMap();
  return local.filter((bot) => botRooms[bot] === roomName);
}

const GITHUB_REPO_URL = 'https://github.com/wawiesel/InfiniClaw';

function getGitRelation(root: string, local: string, upstream: string): string {
  const execOpts = { encoding: 'utf-8' as const, timeout: 5_000, stdio: 'pipe' as const, cwd: root };
  try {
    const ahead = parseInt(execSync(`git rev-list ${upstream}..${local} --count`, execOpts).trim(), 10) || 0;
    const behind = parseInt(execSync(`git rev-list ${local}..${upstream} --count`, execOpts).trim(), 10) || 0;
    if (ahead > 0 && behind > 0) return `↑${ahead}↓${behind}`;
    if (ahead > 0) return `↑${ahead}`;
    if (behind > 0) return `↓${behind}`;
    return '↑0';
  } catch { return 'unknown'; }
}

function botVersion(root: string, bot: string): string {
  try {
    const versionFile = path.join(root, '_runtime', 'instances', bot, 'GIT_VERSION');
    const sha = fs.readFileSync(versionFile, 'utf-8').trim().split(' ')[0];
    if (!sha || !/^[a-f0-9]{7,40}$/.test(sha)) return '';
    return getGitVersionStr(root, sha, getGitRelation(root, sha, 'HEAD'), GITHUB_REPO_URL);
  } catch { return ''; }
}

export async function handleLifecycleCommand(
  action: 'join' | 'dismiss' | 'restart' | 'sleep' | 'wake',
  target: string | undefined,
  conn: RoomConn,
): Promise<void> {
  const root = resolveRoot();
  const bots = resolveBots(target, conn.name, action);
  if (bots.length === 0) return;

  if (action !== 'dismiss' && action !== 'sleep') {
    try { ensurePodmanReady(); } catch (err) {
      await reply(conn, `podman not ready — ${errStr(err)}`);
      return;
    }
  }

  for (const bot of bots) {
    const env = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
    const name = env?.ASSISTANT_NAME || bot;
    const liveFleet = fleetManager.getLiveFleet();
    const rank = liveFleet[bot]?.rank ?? 99;
    
    const ships = (() => { try { return loadShips(); } catch { return {}; } })();
    const loungeId = ships[HOSTNAME]?.loungeId as string | undefined;
    const dutyRoomId = conn.roomId;

    if (action === 'dismiss') {
      try {
        stopBot(bot);
        killStaleContainers(bot);
        const config = loadShipConfig();
        const envFile = path.join(config.secretsPath, 'bots', bot, 'env');
        if (env?.BRAIN_MODEL && env.BRAIN_MODEL !== 'claude-sonnet-4-6') {
          fleetManager.updateBot(bot, { activeBrainModel: env.BRAIN_MODEL });
        }
        try {
          upsertEnvLine(envFile, 'BRAIN_MODEL', 'claude-sonnet-4-6');
          upsertEnvLine(envFile, 'CONTAINER_ENV_LOBES_DISABLED', '1');
        } catch { /* ignore */ }
        try {
          const { token: botToken, homeserver, userId: botUserId } = await botMatrixLogin(root, bot);
          await botLeaveRoom(botToken, homeserver, dutyRoomId);
          if (loungeId) await botJoinRoom(botToken, homeserver, loungeId, conn.accessToken, botUserId);
        } catch { /* ignore */ }
        fleetManager.updateBot(bot, { status: 'lounge' });
        await reply(conn, `🔴 ${name} dismissed → lounge (sonnet, no lobes)`);
      } catch (err) {
        await reply(conn, `⛔ !dismiss ${name} — ${errStr(err)}`);
      }
    } else if (action === 'sleep') {
      try {
        stopBot(bot);
        killStaleContainers(bot);
        try {
          const { token: botToken, homeserver } = await botMatrixLogin(root, bot);
          await botLeaveRoom(botToken, homeserver, dutyRoomId);
          if (loungeId) await botLeaveRoom(botToken, homeserver, loungeId);
        } catch { /* ignore */ }
        fleetManager.updateBot(bot, { status: 'sleep' });
        await reply(conn, `😴 ${name} sleeping (quarters, container stopped)`);
      } catch (err) {
        await reply(conn, `⛔ !sleep ${name} — ${errStr(err)}`);
      }
    } else if (action === 'wake') {
      const startedAt = Date.now();
      const role = env?.ASSISTANT_ROLE || liveFleet[bot]?.role || '?';
      const threadRoot = await reply(conn, `☀️ ${name} waking`);
      if (!threadRoot) continue;
      const step = (text: string) => threadReply(conn, threadRoot, `[${formatDuration(Date.now() - startedAt)}] ${text}`);
      try {
        await step('building...');
        fleetManager.updateBot(bot, { status: 'quarters' });
        fleetManager.persist();
        clearShipConfigCache();
        bootstrapBot(root, bot);
        const model = env?.BRAIN_MODEL || '?';
        const ver = botVersion(root, bot);
        await step(`✅ awake · ${role}[${rank}] · ${model} · ${HOSTNAME}${ver}`);
        await reply(conn, `☀️ ${name} awake (quarters)`);
      } catch (err) {
        const fail = `⛔ !wake ${name} — ${errStr(err)}`;
        await step(fail);
        await reply(conn, fail);
      }
    } else {
      const startedAt = Date.now();
      const emoji = action === 'join' ? '🟢' : '🔄';
      const role = env?.ASSISTANT_ROLE || liveFleet[bot]?.role || '?';
      const threadRoot = await reply(conn, `${emoji} ${name} ${action === 'join' ? 'joining' : 'restarting'}`);
      if (!threadRoot) continue;
      const step = (text: string) => threadReply(conn, threadRoot, `[${formatDuration(Date.now() - startedAt)}] ${text}`);
      try {
        if (action === 'restart') {
          await step('stopping...');
          stopBot(bot);
          killStaleContainers(bot);
        }
        if (action === 'join') {
          const config = loadShipConfig();
          const envFile = path.join(config.secretsPath, 'bots', bot, 'env');
          const savedModel = liveFleet[bot]?.activeBrainModel;
          if (savedModel) {
            try {
              upsertEnvLine(envFile, 'BRAIN_MODEL', savedModel);
              upsertEnvLine(envFile, 'CONTAINER_ENV_LOBES_DISABLED', '');
            } catch { /* ignore */ }
          }
          fleetManager.updateBot(bot, { status: 'onduty', ship: HOSTNAME });
          fleetManager.persist();
          clearShipConfigCache();
        }
        try {
          const { token: botToken, homeserver, userId: botUserId } = await botMatrixLogin(root, bot);
          if (loungeId) await botLeaveRoom(botToken, homeserver, loungeId);
          await botJoinRoom(botToken, homeserver, dutyRoomId, conn.accessToken, botUserId);
          await step('room joined');
        } catch { /* ignore */ }
        await step('building...');
        bootstrapBot(root, bot);
        const model = env?.BRAIN_MODEL || '?';
        const ver = botVersion(root, bot);
        await step(`✅ online · ${role}[${rank}] · ${model} · ${HOSTNAME}${ver}`);
        await reply(conn, `✅ ${name} online`);
        await threadReply(conn, threadRoot, `${name}, reporting for duty!`);
      } catch (err) {
        const fail = `⛔ !${action} ${name} — ${errStr(err)}`;
        await step(fail);
        await reply(conn, fail);
      }
    }
  }
}
