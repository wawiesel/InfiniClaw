import { RoomConn } from '../command-registry.js';
import { resolveRoot, getActiveBots, loadProfileEnv } from '../service.js';
import { errStr } from '../utils.js';
import { matrixSend } from '../matrix-api.js';
import { runHealthCheck, formatHealthSummary } from '../health-service.js';
import { uploadToS3 } from '../s3-service.js';
import { grantMount, revokeMount } from '../allow-list.js';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { loadShipConfig } from '../ship-config.js';

const HOSTNAME = os.hostname();

async function reply(conn: RoomConn, text: string): Promise<string | undefined> {
  return matrixSend(conn.homeserver, conn.accessToken!, conn.roomId, text);
}

export async function handleRelay(cmd: string, conn: RoomConn): Promise<void> {
  const text = cmd.slice('!relay'.length).trim();
  const SESSION = 'operator';
  try {
    let existed = true;
    try { execFileSync('tmux', ['has-session', '-t', SESSION], { stdio: 'pipe' }); } catch { existed = false; }
    if (!existed) {
      execFileSync('tmux', ['new-session', '-d', '-s', SESSION, '-c', path.dirname(loadShipConfig().secretsPath), 'claude'], { stdio: ['pipe', 'pipe', 'pipe'] });
      await new Promise(r => setTimeout(r, 3000));
    }
    if (text) {
      execFileSync('tmux', ['send-keys', '-t', SESSION, '-l', text], { stdio: 'pipe' });
      execFileSync('tmux', ['send-keys', '-t', SESSION, 'Enter'], { stdio: 'pipe' });
    }
    await reply(conn, existed ? 'sent to running operator' : 'started new operator session');
  } catch (err) {
    await reply(conn, `!relay failed — ${errStr(err)}`);
  }
}

export async function handleHealth(cmd: string, conn: RoomConn): Promise<void> {
  const report = runHealthCheck(HOSTNAME);
  if (report) await uploadToS3(`health/${HOSTNAME}.json`, report, 'application/json');
  // Simple summary for now
  if (report) {
    const data = JSON.parse(report);
    await reply(conn, `🏥 ${HOSTNAME} health: ${data.status || 'OK'}`);
  }
}

export async function handleTodo(cmd: string, conn: RoomConn): Promise<void> {
  const target = cmd.slice('!todo'.length).trim().toLowerCase() || null;
  const root = resolveRoot();
  const local = getActiveBots();
  const bots = target ? local.filter(b => b === target) : local;
  if (bots.length === 0) return;
  const lines: string[] = [];
  for (const bot of bots) {
    const env = (() => { try { return loadProfileEnv(root, bot); } catch { return null; } })();
    const name = env?.ASSISTANT_NAME || bot;
    const room = (env?.MAIN_GROUP_NAME || '').toLowerCase();
    const statusPath = path.join(root, '_runtime', 'data', 'ipc', room, 'status.json');
    lines.push(`📋 ${name}`);
    try {
      const snap = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      const g = snap.groups?.find((s: any) => s.folder === room);
      lines.push(g?.active ? `Currently: ${g.lastProgress || g.currentObjective || 'working'}` : 'Currently: idle');
    } catch { lines.push('Currently: unknown'); }
  }
  await reply(conn, lines.join('\n').trim());
}

export async function handleAllow(cmd: string, conn: RoomConn): Promise<void> {
  const match = cmd.match(/^!allow\s+(\S+)\s+(\S+)(?:\s+(\d+))?$/);
  if (!match) { await reply(conn, 'Usage: !allow <bot> <path> [minutes]'); return; }
  const [, botName, hostPath, mins] = match;
  const local = getActiveBots();
  if (!local.includes(botName.toLowerCase())) return;
  try {
    const duration = parseInt(mins ?? '30', 10);
    grantMount(botName.toLowerCase(), hostPath, duration);
    await reply(conn, `✅ Mount granted to ${botName}: ${hostPath} (${duration}m)`);
  } catch (err) {
    await reply(conn, `⛔ !allow failed: ${errStr(err)}`);
  }
}
