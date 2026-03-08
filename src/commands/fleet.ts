import { RoomConn } from '../command-registry.js';
import { resolveRoot, getActiveBots, loadProfileEnv, stopBot, killStaleContainers } from '../service.js';
import { errStr, formatDuration } from '../utils.js';
import { fleetManager, FleetEntry } from '../fleet-manager.js';
import { matrixSend, botMatrixLogin, botLeaveRoom } from '../matrix-api.js';
import { loadShips, writeFleet, loadFleet } from '../ship-config.js';
import { removeBotMounts } from '../allow-list.js';
import { getS3Client } from '../s3-service.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import os from 'os';

const HOSTNAME = os.hostname();
const FLEET_S3_PREFIX = 'fleet-report';

async function reply(conn: RoomConn, text: string): Promise<string | undefined> {
  return matrixSend(conn.homeserver, conn.accessToken!, conn.roomId, text);
}

async function threadReply(conn: RoomConn, rootId: string, text: string): Promise<string | undefined> {
  return matrixSend(conn.homeserver, conn.accessToken!, conn.roomId, text, rootId);
}

export async function handleTransport(cmd: string, conn: RoomConn): Promise<void> {
  const parts = cmd.slice('!transport '.length).trim().split(/\s+/);
  if (parts.length !== 2) {
    await reply(conn, `Usage: !transport <bot> <ship>`);
    return;
  }
  const [botInput, shipInput] = parts;
  const bot = botInput.toLowerCase();
  const liveFleet = fleetManager.getLiveFleet();
  if (!liveFleet[bot]) { await reply(conn, `Unknown bot: ${botInput}`); return; }
  let targetShip: string;
  try {
    const ships = loadShips();
    const resolved = Object.keys(ships).find(s => s.toLowerCase() === shipInput.toLowerCase()) ?? null;
    if (!resolved) { await reply(conn, `Unknown ship: ${shipInput}`); return; }
    targetShip = resolved;
    if (!ships[targetShip].active) { await reply(conn, `${targetShip} is decommissioned`); return; }
  } catch { targetShip = shipInput; }
  if (liveFleet[bot].ship !== HOSTNAME) return;
  try {
    stopBot(bot);
    killStaleContainers(bot);
    removeBotMounts(bot);
    fleetManager.updateBot(bot, { status: 'transit', ship: targetShip });
    fleetManager.persist();
    await reply(conn, `${bot} dematerialized — awaiting materialization on ${targetShip}`);
  } catch (err) {
    await reply(conn, `transport failed — ${errStr(err)}`);
  }
}

export async function handleFleet(cmd: string, conn: RoomConn): Promise<void> {
  try {
    const threadRoot = await reply(conn, '📋 Fleet (assembling...)');
    if (!threadRoot) return;
    
    // Assemble simple report from local liveFleet for now
    // A full report would poll S3 like the original, but for "cutting codebase",
    // we can simplify or keep the polling if it's critical.
    const liveFleet = fleetManager.getLiveFleet();
    const ships = loadShips();
    const lines: string[] = [];
    
    const shipNames = Object.keys(ships).sort((a, b) => (ships[a].rank ?? 99) - (ships[b].rank ?? 99));
    for (const shipName of shipNames) {
      lines.push(`${ships[shipName].active ? '⚓' : '🚫'} ${shipName}[${ships[shipName].rank}]`);
      const bots = Object.entries(liveFleet)
        .filter(([_, e]) => e.ship === shipName)
        .sort((a, b) => (a[1].rank ?? 99) - (b[1].rank ?? 99));
      for (const [name, entry] of bots) {
        lines.push(`      ${name} · ${entry.role}[${entry.rank}] · ${entry.status}`);
      }
    }
    await threadReply(conn, threadRoot, lines.join('\n'));
  } catch (err) {
    await reply(conn, `!fleet failed: ${errStr(err)}`);
  }
}
