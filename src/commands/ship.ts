import { RoomConn } from '../command-registry.js';
import { resolveRoot, getActiveBots, bootstrapBot, stopBot, killStaleContainers, ensurePodmanReady } from '../service.js';
import { errStr, formatDuration, shellQuote } from '../utils.js';
import { getGitVersionStr } from '../formatting.js';
import { fleetManager } from '../fleet-manager.js';
import { matrixSend } from '../matrix-api.js';
import { gitSync, getRepoVersion } from '../git-service.js';
import { uploadToS3, getS3Client, getPresignedUrl } from '../s3-service.js';
import { statusLine } from '../alert-manager.js';
import { loadShips, writeShips, loadFleet, clearShipConfigCache } from '../ship-config.js';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const HOSTNAME = os.hostname();
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

function relayVersion(root: string): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf-8', stdio: 'pipe' }).trim();
    if (!sha) return '';
    return getGitVersionStr(root, sha, getGitRelation(root, 'HEAD', 'origin/main'), GITHUB_REPO_URL);
  } catch { return ''; }
}

function botVersion(root: string, bot: string): string {
  try {
    const versionFile = path.join(root, '_runtime', 'instances', bot, 'GIT_VERSION');
    const sha = fs.readFileSync(versionFile, 'utf-8').trim().split(' ')[0];
    if (!sha || !/^[a-f0-9]{7,40}$/.test(sha)) return '';
    return getGitVersionStr(root, sha, getGitRelation(root, sha, 'HEAD'), GITHUB_REPO_URL);
  } catch { return ''; }
}

async function reply(conn: RoomConn, text: string): Promise<string | undefined> {
  return matrixSend(conn.homeserver, conn.accessToken!, conn.roomId, text);
}

async function threadReply(conn: RoomConn, rootId: string, text: string): Promise<string | undefined> {
  return matrixSend(conn.homeserver, conn.accessToken!, conn.roomId, text, rootId);
}

export async function handleCommission(cmd: string, conn: RoomConn): Promise<void> {
  const targetShip = cmd.slice('!commission'.length).trim() || null;
  if (targetShip && targetShip.toLowerCase() !== HOSTNAME.toLowerCase()) return;
  try {
    const ships = loadShips();
    if (!ships[HOSTNAME]) { await reply(conn, `not in ships.json`); return; }
    ships[HOSTNAME].active = true;
    writeShips(ships);
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
}

export async function handleDecommission(cmd: string, conn: RoomConn): Promise<void> {
  const targetShip = cmd.slice('!decommission'.length).trim() || null;
  if (targetShip && targetShip.toLowerCase() !== HOSTNAME.toLowerCase()) return;
  try {
    const ships = loadShips();
    if (!ships[HOSTNAME]) { await reply(conn, `not in ships.json`); return; }
    for (const bot of getActiveBots()) {
      stopBot(bot);
      killStaleContainers(bot);
      fleetManager.updateBot(bot, { status: 'sleep' });
    }
    ships[HOSTNAME].active = false;
    writeShips(ships);
    await reply(conn, `decommissioned — all bots stopped, relay still running`);
  } catch (err) {
    await reply(conn, `decommission failed — ${errStr(err)}`);
  }
}

function rebuildInfiniClaw(): string {
  const root = resolveRoot();
  try {
    const nodeBinDir = path.dirname(process.execPath);
    const execOpts = { cwd: root, encoding: 'utf-8' as const, stdio: 'pipe' as const, env: { ...process.env, PATH: `${nodeBinDir}:${process.env.PATH}` } };
    const script = path.join(root, 'scripts', 'rebuild.sh');
    if (fs.existsSync(script)) {
      execSync(`bash ${shellQuote(script)}`, { ...execOpts, timeout: 300_000 });
    } else {
      execSync('npm run build', { ...execOpts, timeout: 120_000 });
    }
    const distDir = path.join(root, 'dist');
    if (fs.existsSync(distDir)) {
      const jsFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));
      for (const bot of getActiveBots()) {
        const dstDir = path.join(root, '_runtime', 'instances', bot, 'dist');
        for (const f of jsFiles) {
          try { fs.copyFileSync(path.join(distDir, f), path.join(dstDir, f)); } catch { /* ignore */ }
        }
      }
    }
    return 'infiniclaw: rebuild succeeded';
  } catch (err) {
    return `infiniclaw: rebuild FAILED — ${errStr(err).slice(0, 200)}`;
  }
}

async function uploadErrorLog(label: string, error: unknown): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `logs/${HOSTNAME}/${label}-${ts}.log`;
  const body = error instanceof Error
    ? `${error.message}\n\n${error.stack ?? ''}\n\n${(error as { stderr?: string }).stderr ?? ''}`
    : String(error);
  if (await uploadToS3(key, body, 'text/plain')) {
    const url = await getPresignedUrl(key, 7 * 86_400);
    return ` ([log](${url}))`;
  }
  return '';
}

export async function handleProvision(cmd: string, conn: RoomConn): Promise<void> {
  const target = cmd.slice('!provision'.length).trim() || null;
  const results: string[] = [];
  try {
    if (!target || target === 'infiniclaw') {
      const r = gitSync(resolveRoot());
      results.push(r.ok ? `infiniclaw: ${r.output}` : `infiniclaw: failed — ${r.output}`);
      if (r.ok && r.newCommits > 0) results.push(rebuildInfiniClaw());
    }
    await reply(conn, `${results.join('\n')}`);
  } catch (err) {
    await reply(conn, `!provision failed — ${errStr(err)}`);
  }
}

export async function handleRefit(cmd: string, conn: RoomConn): Promise<void> {
  const targetShip = cmd.slice('!refit'.length).trim() || null;
  if (targetShip && targetShip.toLowerCase() !== HOSTNAME.toLowerCase()) return;
  const startedAt = Date.now();
  const threadRoot = await reply(conn, statusLine('⚓', 'refit', 'starting', 0, HOSTNAME));
  if (!threadRoot) return;
  const activeBots = getActiveBots();
  let stage = 0;
  let warnings = 0;
  let errors = 0;
  const s = (text: string) => threadReply(conn, threadRoot, `[${++stage}/${activeBots.length + 3} ${formatDuration(Date.now() - startedAt)}] ${text}`);

  try {
    const root = resolveRoot();
    const icResult = gitSync(root);
    if (!icResult.ok) {
      warnings++;
      const link = await uploadErrorLog('code-sync', new Error(icResult.output));
      await s(`⚠️ code sync failed${link}`);
    } else {
      await s(`✅ code ${icResult.output}`);
    }

    const buildResult = rebuildInfiniClaw();
    if (buildResult.includes('FAILED')) {
      errors++;
      const link = await uploadErrorLog('build', new Error(buildResult));
      await s(`⛔ relay + dist rebuild failed${link}`);
    } else {
      await s(`✅ relay + dist rebuilt${relayVersion(root)}`);
    }

    ensurePodmanReady();
    for (const bot of activeBots) {
      try {
        bootstrapBot(root, bot);
        await s(`✅ ${bot} restarted${botVersion(root, bot)}`);
      } catch (err) {
        errors++;
        const link = await uploadErrorLog(`restart-${bot}`, err);
        await s(`⛔ ${bot} restart failed${link}`);
      }
    }
    fleetManager.persist();
    const resultEmoji = errors > 0 ? '⛔' : warnings > 0 ? '⚠️' : '✅';
    const msg = statusLine(resultEmoji, 'refit', `complete (${warnings}W ${errors}E)`, Date.now() - startedAt, HOSTNAME);
    await reply(conn, msg);
  } catch (err) {
    await reply(conn, `refit failed — ${errStr(err)}`);
  }
}
