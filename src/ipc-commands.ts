/**
 * InfiniClaw IPC command handlers.
 * Extended commands delegated from the base ipc.ts processTaskIpc switch.
 */
import crypto from 'crypto';
import { execFileSync, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { isOllamaBaseUrl, parseEnvFile, upsertEnvLine } from 'nanoclaw/env-utils.js';

import { ASSISTANT_NAME } from 'nanoclaw/config.js';
import { ASSISTANT_ROLE, MAIN_GROUP_FOLDER } from './infini-config.js';
import { loadShipConfig } from './ship-config.js';
import { logger } from 'nanoclaw/logger.js';

import {
  shellQuote,
  formatDuration,
  errStr,
  resolveRoot,
  assertValidBotName,
  applyBrainMode,
} from './utils.js';
import { getGitVersion } from './formatting.js';
import { fleetManager } from './fleet-manager.js';
import { pm2Stop, pm2StartBot, pm2Name, refreshStartScript } from './process-manager.js';
import { ensurePodmanReady, killStaleContainers } from './podman-service.js';
import { deployBot, validateDeploy, rebuildImage } from './deploy-service.js';
import {
  holodeckCreate,
  holodeckTeardown,
  holodeckPromote,
} from './holodeck-service.js';
import {
  readVerifications,
  writeVerifications,
  syncVerificationsToAll,
  VerificationRecord,
} from './verification-service.js';
import { gitSync } from './git-service.js';

const GIT_VERSION = getGitVersion(resolveRoot());

import {
  getActiveBots,
  bootstrapBot as serviceBootstrapBot,
  stopBot as serviceStopBot,
  instanceDir,
  loadProfileEnv,
} from './service.js';
import type { RegisteredGroup } from 'nanoclaw/types.js';
import { statusMessage } from './formatting.js';

// ── Cooldown tracking ───────────────────────────────────────────────────

const RESTART_COOLDOWN_MS = 60_000;
const REBUILD_COOLDOWN_MS = 5 * 60_000;
const GIT_PUSH_COOLDOWN_MS = 60_000;
const GIT_PULL_COOLDOWN_MS = 60_000;
const MAX_IPC_BINARY_BYTES = 10 * 1024 * 1024;
const cooldowns: Record<string, number> = {};

// ── Interfaces ──────────────────────────────────────────────────────────

export interface InfiniClawIpcContext {
  isMain: boolean;
  sourceGroup: string;
  sendMessage: (jid: string, text: string, threadId?: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  setWorkThread: (chatJid: string, threadId: string | null) => void;
  clearDelegateThread: (sourceGroup: string) => void;
}

export interface InfiniClawMessageContext {
  authorized: boolean;
  sourceGroup: string;
  sendImage: (jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string) => Promise<void>;
  sendFile: (jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string) => Promise<void>;
}

interface CommandData {
  type: string;
  bot?: string;
  mode?: string;
  model?: string;
  chatJid?: string;
  threadId?: string;
  remote?: string;
  branches?: string[];
  branch?: string;
  message?: string;
  room?: string;
  limit?: number;
  id?: string;
  task_description?: string;
  criteria?: string;
  requested_by?: string;
  assigned_to?: string;
  timestamp?: string;
  groupFolder?: string;
  passed?: boolean;
  evidence?: string;
  submitted_by?: string;
  [key: string]: unknown;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function botStatusLine(bot: string, emoji: string): string {
  try {
    const env = loadProfileEnv(resolveRoot(), bot);
    const name = env.ASSISTANT_NAME || bot;
    const role = env.ASSISTANT_ROLE || 'Bot';
    const group = env.MAIN_GROUP_NAME || 'main';
    const rawModel = env.BRAIN_MODEL || 'unknown';
    const provider = rawModel.startsWith('claude') ? 'Claude'
      : rawModel.startsWith('gpt') || rawModel.startsWith('o1') || rawModel.startsWith('o3') || rawModel.startsWith('o4') ? 'OpenAI'
      : rawModel.startsWith('gemini') ? 'Google'
      : isOllamaBaseUrl(env.BRAIN_BASE_URL || '') ? 'Ollama' : 'Claude';
    const model = `${provider}/${rawModel}`;
    const hostname = os.hostname();
    return `<font color="#888888"><em>${emoji} ${name} · 🔧 ${role} · 💬 ${group} · 🧠 ${model} · 🖥️ ${hostname} · 📦 ${GIT_VERSION}</em></font>`;
  } catch {
    return statusMessage(emoji, `${bot} restarting...`);
  }
}

export function readBrainMode(bot: string): { mode: 'anthropic' | 'ollama' | 'unknown'; model: string } {
  const envFile = path.join(loadShipConfig().secretsPath, 'bots', bot, 'env');
  if (!fs.existsSync(envFile)) return { mode: 'unknown', model: '' };
  try {
    const vars = parseEnvFile(envFile);
    const model = vars.BRAIN_MODEL || '';
    if (isOllamaBaseUrl(vars.BRAIN_BASE_URL) || vars.BRAIN_AUTH_TOKEN === 'ollama') {
      return { mode: 'ollama', model };
    }
    return { mode: model ? 'anthropic' : 'unknown', model };
  } catch {
    return { mode: 'unknown', model: '' };
  }
}

function requireMain(ctx: InfiniClawIpcContext, command: string): boolean {
  if (ctx.isMain) return false;
  logger.warn({ sourceGroup: ctx.sourceGroup }, `Unauthorized ${command} attempt blocked`);
  return true;
}

function checkCooldown(key: string, cooldownMs: number): string | null {
  const now = Date.now();
  const elapsed = now - (cooldowns[key] || 0);
  if (elapsed < cooldownMs) {
    const remaining = Math.ceil((cooldownMs - elapsed) / 1000);
    return `⏳ Cooldown: ${key} was triggered ${Math.floor(elapsed / 1000)}s ago. Wait ${remaining}s.`;
  }
  cooldowns[key] = now;
  return null;
}

async function safeSend(ctx: InfiniClawIpcContext, chatJid: string | null, text: string): Promise<void> {
  if (!chatJid) return;
  try { await ctx.sendMessage(chatJid, text); } catch (err) { logger.warn({ chatJid, err }, 'safeSend failed'); }
}

function parseChatJid(data: CommandData): string | null {
  return typeof data.chatJid === 'string' && data.chatJid.trim().length > 0 ? data.chatJid : null;
}

function parseBot(data: CommandData): string {
  if (typeof data.bot === 'string' && data.bot.trim()) {
    if (getActiveBots().includes(data.bot)) return data.bot;
  }
  return ASSISTANT_NAME.toLowerCase();
}

function truncateOutput(text: string, max = 3000): string {
  return text.length > max ? text.slice(-max) : text;
}

function isSafeGitToken(value: string): boolean {
  return /^[a-zA-Z0-9._\-/]+$/.test(value) && !value.startsWith('-');
}

function decodeIpcBase64(data: string): Buffer {
  if (data.length > Math.ceil(MAX_IPC_BINARY_BYTES / 3) * 4) {
    throw new Error(`IPC attachment exceeds ${MAX_IPC_BINARY_BYTES} bytes`);
  }
  return Buffer.from(data, 'base64');
}

// ── Extended message types (image, file) ────────────────────────────────

export async function handleInfiniClawMessage(
  data: { type: string; chatJid?: string; imageData?: string; fileData?: string; filename?: string; mimetype?: string; caption?: string },
  ctx: InfiniClawMessageContext,
): Promise<boolean> {
  const isImage = data.type === 'image' && data.chatJid && data.imageData;
  const isFile = data.type === 'file' && data.chatJid && data.fileData;
  if (!isImage && !isFile) return false;

  if (!ctx.authorized) {
    logger.warn({ chatJid: data.chatJid, sourceGroup: ctx.sourceGroup }, `Unauthorized IPC ${data.type} attempt blocked`);
    return true;
  }

  let buffer: Buffer;
  try {
    buffer = decodeIpcBase64((isImage ? data.imageData : data.fileData)!);
  } catch (err) {
    logger.warn({ sourceGroup: ctx.sourceGroup, err }, `Rejected IPC ${data.type} payload`);
    return true;
  }
  const sendFn = isImage ? ctx.sendImage : ctx.sendFile;
  await sendFn(data.chatJid!, buffer, data.filename || (isImage ? 'image.png' : 'attachment.bin'), data.mimetype || (isImage ? 'image/png' : 'application/octet-stream'), data.caption);
  return true;
}

// ── Command handlers ────────────────────────────────────────────────────

async function handleSetBrainMode(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'set_brain_mode')) return;
  const validBot = typeof data.bot === 'string' && getActiveBots().includes(data.bot);
  if (!data.bot || !validBot || !data.mode) return;
  try {
    const summary = applyBrainMode(data.bot, data.mode as any, typeof data.model === 'string' ? data.model : undefined);
    const chatJid = parseChatJid(data);
    if (chatJid) await ctx.sendMessage(chatJid, `${data.bot}:\n\n${summary}`);
  } catch (err) { logger.error({ err, data }, 'Failed to apply set_brain_mode'); }
}

async function handleRestartBot(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'restart_bot')) return;
  const bot = parseBot(data);
  const chatJid = parseChatJid(data);
  const cooldownMsg = checkCooldown(`restart:${bot}`, RESTART_COOLDOWN_MS);
  if (cooldownMsg) { await safeSend(ctx, chatJid, cooldownMsg); return; }

  const { ok, errors } = validateDeploy(resolveRoot(), bot);
  if (!ok) {
    await safeSend(ctx, chatJid, `⛔ deploy validation failed — not restarting:\n\n\`\`\`\n${truncateOutput(errors)}\n\`\`\``);
    return;
  }

  if (bot === ASSISTANT_NAME.toLowerCase()) {
    await handleSelfRestart(bot, chatJid, ctx);
  } else {
    await handleCrossBotRestart(bot, chatJid, ctx);
  }
}

async function handleSelfRestart(bot: string, chatJid: string | null, ctx: InfiniClawIpcContext): Promise<void> {
  try {
    deployBot(resolveRoot(), bot);
    let mainJid: string | null = null;
    for (const [jid, group] of Object.entries(ctx.registeredGroups())) {
      if (group.folder === MAIN_GROUP_FOLDER) { mainJid = jid; break; }
    }
    await safeSend(ctx, mainJid || chatJid, botStatusLine(bot, '⭕️'));
    refreshStartScript(resolveRoot(), bot);
    setTimeout(() => process.exit(0), 2000);
  } catch (err) {
    await safeSend(ctx, chatJid, `⛔ self-deploy failed: ${errStr(err)}`);
  }
}

async function handleCrossBotRestart(bot: string, chatJid: string | null, ctx: InfiniClawIpcContext): Promise<void> {
  try {
    serviceBootstrapBot(resolveRoot(), bot);
    logger.info({ bot }, 'Cross-bot bootstrap succeeded');
  } catch (err) {
    await safeSend(ctx, chatJid, `⛔ bootstrap failed for ${bot}: ${errStr(err)}`);
  }
}

async function handleStopBot(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'stop_bot')) return;
  const bot = typeof data.bot === 'string' && getActiveBots().includes(data.bot) ? data.bot : null;
  if (!bot || bot === ASSISTANT_NAME.toLowerCase()) return;
  const chatJid = parseChatJid(data);
  try {
    serviceStopBot(bot);
    killStaleContainers(bot);
    await safeSend(ctx, chatJid, `<font color="#555555">🛑 ${bot} stopped.</font>`);
  } catch (err) { await safeSend(ctx, chatJid, `⛔ failed to stop ${bot}: ${errStr(err)}`); }
}

async function handleRebuildImage(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'rebuild_image')) return;
  const bot = parseBot(data);
  const chatJid = parseChatJid(data);
  const cooldownMsg = checkCooldown(`rebuild:${bot}`, REBUILD_COOLDOWN_MS);
  if (cooldownMsg) { await safeSend(ctx, chatJid, cooldownMsg); return; }

  await safeSend(ctx, chatJid, `🔧 rebuilding nanoclaw-${bot}:latest...`);
  try {
    rebuildImage(resolveRoot(), bot);
    await safeSend(ctx, chatJid, `✅ nanoclaw-${bot}:latest rebuilt`);
  } catch (err) { await safeSend(ctx, chatJid, `⛔ image rebuild failed for ${bot}: ${errStr(err)}`); }
}

async function handleBotStatus(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'bot_status')) return;
  const bot = parseBot(data);
  const chatJid = parseChatJid(data);
  if (!chatJid) return;
  try {
    const logDir = path.resolve(resolveRoot(), '_runtime', 'logs');
    const errorLogPath = path.join(logDir, `${bot}.error.log`);
    const lastErrors = fs.existsSync(errorLogPath) ? fs.readFileSync(errorLogPath, 'utf8').split('\n').slice(-50).join('\n').trim() : '(no error log)';
    let serviceInfo = '';
    try { serviceInfo = execFileSync('npx', ['pm2', 'show', `infiniclaw-${bot}`], { timeout: 5000, cwd: resolveRoot(), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { serviceInfo = 'not running'; }
    await ctx.sendMessage(chatJid, `**${bot} status:**\n\`\`\`\n${serviceInfo}\n\`\`\`\n\n**Last errors:**\n\`\`\`\n${truncateOutput(lastErrors)}\n\`\`\``);
  } catch (err) { logger.error({ bot, err }, 'Failed to get bot status'); }
}

function handleSetThread(data: CommandData, ctx: InfiniClawIpcContext): void {
  const targetJid = typeof data.chatJid === 'string' ? data.chatJid.trim() : '';
  if (!targetJid) return;
  const groups = ctx.registeredGroups();
  const targetGroup = groups[targetJid];
  if (!ctx.isMain && (!targetGroup || targetGroup.folder !== ctx.sourceGroup)) return;
  const threadId = typeof data.threadId === 'string' && data.threadId.trim() ? data.threadId.trim() : null;
  ctx.setWorkThread(targetJid, threadId);
  if (threadId === null) ctx.clearDelegateThread(ctx.sourceGroup);
}

async function handleRestartWksm(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'restart_wksm')) return;
  const chatJid = parseChatJid(data);
  try {
    const home = os.homedir();
    const wksc = `${home}/2025-WKS/main/venv/bin/wksc`;
    if (chatJid) await ctx.sendMessage(chatJid, '🔄 Restarting wksm...');
    execSync(`/usr/sbin/lsof -ti:8765 | xargs kill -9 2>&1 || echo "no process"`, { shell: '/bin/bash', timeout: 10000 });
    await new Promise(r => setTimeout(r, 2000));
    const child = spawn(wksc, ['mcp', 'proxy', 'start'], { detached: true, stdio: 'ignore', shell: false });
    child.unref();
    await new Promise(r => setTimeout(r, 3000));
    const health = execSync('curl -s --max-time 3 http://localhost:8765/health || echo "not ready"', { shell: '/bin/bash', timeout: 8000 }).toString().trim();
    if (chatJid) await ctx.sendMessage(chatJid, `✅ wksm started, health: ${health}`);
  } catch (err) { if (chatJid) await safeSend(ctx, chatJid, `⛔ restart_wksm failed: ${errStr(err)}`); }
}

async function handleRestartRelay(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'restart_relay')) return;
  const chatJid = parseChatJid(data);
  try {
    if (chatJid) await ctx.sendMessage(chatJid, '🔄 Restarting relay...');
    execSync('npx pm2 restart infiniclaw-relay', { cwd: resolveRoot(), encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
    if (chatJid) await safeSend(ctx, chatJid, '✅ Relay restarted');
  } catch (err) { if (chatJid) await safeSend(ctx, chatJid, `⛔ restart_relay failed: ${errStr(err)}`); }
}

async function handleGitPush(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'git_push')) return;
  const chatJid = parseChatJid(data);
  const remote = typeof data.remote === 'string' ? data.remote.trim() : 'origin';
  const branches = Array.isArray(data.branches) ? data.branches.map(String) : ['main'];
  if (!isSafeGitToken(remote) || branches.some(b => !isSafeGitToken(b))) { await safeSend(ctx, chatJid, '⛔ git_push: invalid remote or branch'); return; }
  if (checkCooldown('git_push', GIT_PUSH_COOLDOWN_MS)) { await safeSend(ctx, chatJid, '⏳ git_push cooldown'); return; }
  try {
    execFileSync('git', ['push', remote, ...branches], { cwd: resolveRoot(), encoding: 'utf-8', stdio: 'pipe', timeout: 30000 });
    await safeSend(ctx, chatJid, `✅ Pushed ${branches.join(', ')} to ${remote}`);
  } catch (err) { await safeSend(ctx, chatJid, `⛔ git_push failed: ${errStr(err)}`); }
}

async function handleGitPull(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'git_pull')) return;
  const chatJid = parseChatJid(data);
  if (checkCooldown('git_pull', GIT_PULL_COOLDOWN_MS)) { await safeSend(ctx, chatJid, '⏳ git_pull cooldown'); return; }
  const root = resolveRoot();
  try {
    const r = gitSync(root);
    if (!r.ok) { await safeSend(ctx, chatJid, `⛔ git_pull failed: ${r.output}`); return; }
    if (r.newCommits === 0) { await safeSend(ctx, chatJid, '✅ git_pull: already up to date'); return; }
    execSync('npm run build', { cwd: root, encoding: 'utf-8', timeout: 120000, stdio: 'pipe' });
    const distDir = path.join(root, 'dist');
    if (fs.existsSync(distDir)) {
      for (const bot of getActiveBots()) {
        const dst = path.join(instanceDir(root, bot), 'dist');
        for (const f of fs.readdirSync(distDir).filter(f => f.endsWith('.js'))) {
          try { fs.copyFileSync(path.join(distDir, f), path.join(dst, f)); } catch { }
        }
      }
    }
    await safeSend(ctx, chatJid, `✅ git_pull: pulled ${r.newCommits} commit(s), rebuilt, deployed`);
  } catch (err) { await safeSend(ctx, chatJid, `⛔ git_pull failed: ${errStr(err)}`); }
}

async function handleHolodeckCreate(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'holodeck_create')) return;
  const bot = parseBot(data);
  const branch = typeof data.branch === 'string' ? data.branch.trim() : '';
  const chatJid = parseChatJid(data);
  if (!branch || !isSafeGitToken(branch)) { await safeSend(ctx, chatJid, '⛔ holodeck_create: invalid branch'); return; }
  try {
    holodeckCreate(bot, branch);
    await safeSend(ctx, chatJid, `✅ Holodeck created for ${bot} (branch: ${branch})`);
  } catch (err) { await safeSend(ctx, chatJid, `⛔ holodeck_create failed: ${errStr(err)}`); }
}

async function handleHolodeckTeardown(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'holodeck_teardown')) return;
  const bot = parseBot(data);
  const chatJid = parseChatJid(data);
  try {
    holodeckTeardown(bot);
    await safeSend(ctx, chatJid, `✅ Holodeck torn down for ${bot}`);
  } catch (err) { await safeSend(ctx, chatJid, `⛔ holodeck_teardown failed: ${errStr(err)}`); }
}

async function handleHolodeckPromote(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'holodeck_promote')) return;
  const bot = parseBot(data);
  const chatJid = parseChatJid(data);
  try {
    holodeckPromote(bot);
    await safeSend(ctx, chatJid, `✅ Holodeck promoted for ${bot}`);
  } catch (err) { await safeSend(ctx, chatJid, `⛔ holodeck_promote failed: ${errStr(err)}`); }
}

async function handleHealthCheck(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'health_check')) return;
  const chatJid = parseChatJid(data);
  if (!chatJid) return;
  try {
    const root = resolveRoot();
    const output = execSync(`bash "${path.join(root, 'scripts', 'health-check.sh')}"`, { encoding: 'utf-8', timeout: 30000, cwd: root, env: { ...process.env, MACHINE_NAME: os.hostname() } }).trim();
    await ctx.sendMessage(chatJid, `**${os.hostname()} health:**\n\`\`\`\n${truncateOutput(output)}\n\`\`\``);
  } catch (err) { await safeSend(ctx, chatJid, `health_check failed: ${errStr(err)}`); }
}

async function handleFleetStatus(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'fleet_status')) return;
  const chatJid = parseChatJid(data);
  if (!chatJid) return;
  try {
    const fleet = fleetManager.getLiveFleet();
    const lines: string[] = [`**Fleet status** (${os.hostname()}):\n`];
    const byRole: Record<string, Array<[string, any]>> = {};
    for (const [name, entry] of Object.entries(fleet)) {
      if (!byRole[entry.role]) byRole[entry.role] = [];
      byRole[entry.role].push([name, entry]);
    }
    for (const [role, entries] of Object.entries(byRole)) {
      lines.push(`**${role}:**`);
      for (const [name, entry] of entries.sort((a, b) => a[1].rank - b[1].rank)) {
        const s = entry.status;
        const status = s === 'onduty' || s === 'active' ? 'ON ' : s === 'transit' ? 'TRN' : s === 'sleep' ? 'ZZZ' : s === 'lounge' ? 'LNG' : s === 'quarters' ? 'QTR' : 'OFF';
        lines.push(`  ${status} #${entry.rank} ${name} → ${entry.ship || 'unassigned'}`);
      }
    }
    await ctx.sendMessage(chatJid, lines.join('\n'));
  } catch (err) { await safeSend(ctx, chatJid, `fleet_status failed: ${errStr(err)}`); }
}

async function handleSendToRoom(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'send_to_room')) return;
  const room = typeof data.room === 'string' ? data.room.trim() : '';
  const message = typeof data.message === 'string' ? data.message : '';
  if (!room || !message) return;
  const groups = ctx.registeredGroups();
  const targetJid = Object.keys(groups).find(jid => groups[jid].name.toLowerCase() === room.toLowerCase());
  if (targetJid) await safeSend(ctx, targetJid, message);
}

async function handleRequestVerification(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'request_verification')) return;
  if (!data.id || !data.task_description || !data.criteria || !data.requested_by || !data.assigned_to) { await safeSend(ctx, parseChatJid(data), '⛔ missing required fields'); return; }
  const root = resolveRoot();
  const record: VerificationRecord = { id: String(data.id).trim(), task_description: String(data.task_description).trim(), criteria: String(data.criteria).trim(), requested_by: String(data.requested_by).trim(), assigned_to: String(data.assigned_to).trim(), status: 'pending', requested_at: (data.timestamp as string) || new Date().toISOString(), source_group: data.groupFolder as string };
  const records = readVerifications(root);
  records.push(record);
  writeVerifications(root, records);
  syncVerificationsToAll(root);
  await safeSend(ctx, parseChatJid(data), `✅ Verification requested: ${record.id}\nAssigned to: ${record.assigned_to}\nCriteria: ${record.criteria}`);
}

async function handleSubmitVerification(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'submit_verification')) return;
  if (!data.id || typeof data.passed !== 'boolean') { await safeSend(ctx, parseChatJid(data), '⛔ invalid id or passed flag'); return; }
  const root = resolveRoot();
  const records = readVerifications(root);
  const record = records.find(r => r.id === data.id);
  if (!record || record.status !== 'pending') { await safeSend(ctx, parseChatJid(data), `❌ Verification not found or already resolved.`); return; }
  record.status = data.passed ? 'verified' : 'failed';
  if (typeof data.evidence === 'string') record.evidence = data.evidence;
  record.resolved_at = new Date().toISOString();
  writeVerifications(root, records);
  syncVerificationsToAll(root);
  await safeSend(ctx, parseChatJid(data), `${record.status === 'verified' ? '✅' : '❌'} Verification ${record.id}: ${record.status.toUpperCase()}\nEvidence: ${record.evidence || ''}`);
}

const COMMAND_HANDLERS: Record<string, (data: CommandData, ctx: InfiniClawIpcContext) => void | Promise<void>> = {
  set_brain_mode: handleSetBrainMode,
  restart_bot: handleRestartBot,
  stop_bot: handleStopBot,
  rebuild_image: handleRebuildImage,
  bot_status: handleBotStatus,
  set_thread: handleSetThread,
  send_to_room: handleSendToRoom,
  restart_wksm: handleRestartWksm,
  restart_relay: handleRestartRelay,
  request_verification: handleRequestVerification,
  submit_verification: handleSubmitVerification,
  health_check: handleHealthCheck,
  fleet_status: handleFleetStatus,
  git_push: handleGitPush,
  git_pull: handleGitPull,
  holodeck_create: handleHolodeckCreate,
  holodeck_teardown: handleHolodeckTeardown,
  holodeck_promote: handleHolodeckPromote,
};

export async function handleInfiniClawCommand(data: CommandData, ctx: InfiniClawIpcContext): Promise<boolean> {
  const handler = COMMAND_HANDLERS[data.type];
  if (!handler) return false;
  await handler(data, ctx);
  return true;
}
