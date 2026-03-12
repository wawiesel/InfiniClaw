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
import { isOllamaBaseUrl, parseEnvFile, upsertEnvLine } from './env-utils.js';

import { ASSISTANT_NAME } from 'nanoclaw/config.js';
import { ASSISTANT_ROLE, MAIN_GROUP_FOLDER } from './infini-config.js';
import { loadShipConfig, loadFleet, writeFleet, shipTag } from './ship-config.js';
import { logger } from 'nanoclaw/logger.js';
import { errStr } from './utils.js';
import { gitSyncRepo } from './git-utils.js';
import { GIT_VERSION } from './version.js';
import {
  getActiveBots,
  bootstrapBot as serviceBootstrapBot,
  deployBot as serviceDeployBot,
  stopBot as serviceStopBot,
  refreshBot as serviceRefreshBot,
  rebuildImage as serviceRebuildImage,
  refreshStartScript as serviceRefreshStartScript,
  resolveRoot,
  instanceDir,
  loadProfileEnv,
  validateDeploy as serviceValidateDeploy,
  holodeckCreate as serviceHolodeckCreate,
  holodeckTeardown as serviceHolodeckTeardown,
  holodeckPromote as serviceHolodeckPromote,
} from './service.js';
import type { RegisteredGroup } from 'nanoclaw/types.js';
import { capitalizeName, statusMessage } from './formatting.js';

// ── Cooldown tracking ───────────────────────────────────────────────────

const RESTART_COOLDOWN_MS = 60_000; // 60 seconds
const REBUILD_COOLDOWN_MS = 5 * 60_000; // 5 minutes — image builds are expensive
const GIT_PUSH_COOLDOWN_MS = 60_000; // 60 seconds
const GIT_PULL_COOLDOWN_MS = 60_000; // 60 seconds
const MAX_IPC_BINARY_BYTES = 10 * 1024 * 1024; // 10MB
const cooldowns: Record<string, number> = {};

// ── Interfaces ──────────────────────────────────────────────────────────

export interface InfiniClawIpcContext {
  isMain: boolean;
  sourceGroup: string;
  sendMessage: (jid: string, text: string, threadId?: string) => Promise<void>;
  sendReaction: (jid: string, eventId: string, emoji: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  setWorkThread: (chatJid: string, threadId: string | null) => void;
  /** Clear the auto-thread entry for this source group (called when set_thread clears the thread) */
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

function trySync<T>(fn: () => T, fallback: (err: unknown) => T): T {
  try { return fn(); } catch (err) { return fallback(err); }
}

function getMainRoomJid(ctx: InfiniClawIpcContext): string | null {
  for (const [jid, group] of Object.entries(ctx.registeredGroups())) {
    if (group.folder === MAIN_GROUP_FOLDER) return jid;
  }
  return null;
}

function botStatusLine(bot: string, emoji: string): string {
  try {
    const env = loadProfileEnv(resolveRoot(), bot);
    const name = env.ASSISTANT_NAME || capitalizeName(bot);
    const role = env.ASSISTANT_ROLE || 'Bot';
    const group = env.MAIN_GROUP_NAME || 'main';
    const rawModel = env.BRAIN_MODEL || 'unknown';
    const provider = rawModel.startsWith('claude') ? 'Claude'
      : rawModel.startsWith('gpt') || rawModel.startsWith('o1') || rawModel.startsWith('o3') || rawModel.startsWith('o4') ? 'OpenAI'
      : rawModel.startsWith('gemini') ? 'Google'
      : isOllamaBaseUrl(env.BRAIN_BASE_URL || '') ? 'Ollama' : 'Claude';
    const model = `${provider}/${rawModel}`;
    return `<font color="#888888"><em>${emoji} ${name} · 🔧 ${role} · 💬 ${group} · 🧠 ${model} · 🖥️ ${shipTag()} · 📦 ${GIT_VERSION}</em></font>`;
  } catch {
    return statusMessage(emoji, `${bot} restarting...`);
  }
}

function validateDeploy(bot: string): { ok: boolean; errors: string } {
  return trySync(
    () => serviceValidateDeploy(resolveRoot(), bot),
    (err) => ({ ok: false, errors: errStr(err) }),
  );
}

function deployInstance(bot: string): { ok: boolean; output: string } {
  return trySync((): { ok: boolean; output: string } => {
    const root = resolveRoot();
    serviceDeployBot(root, bot);
    serviceRebuildImage(root, bot);
    return { ok: true, output: '' };
  }, (err) => ({ ok: false, output: errStr(err) }));
}

function rebuildImage(bot: string): { ok: boolean; output: string } {
  return trySync(
    (): { ok: boolean; output: string } => { serviceRebuildImage(resolveRoot(), bot); return { ok: true, output: '' }; },
    (err) => ({ ok: false, output: errStr(err) }),
  );
}

function applyBrainMode(
  bot: string,
  mode: 'anthropic' | 'ollama',
  model?: string,
): string {
  const config = loadShipConfig();
  const envFile = path.join(config.secretsPath, 'bots', bot, 'env');
  if (!fs.existsSync(envFile)) {
    throw new Error(`Missing profile env: ${envFile}`);
  }

  let effectiveModel: string;
  if (mode === 'anthropic') {
    effectiveModel = model || 'claude-sonnet-4-6';
    upsertEnvLine(envFile, 'BRAIN_MODEL', effectiveModel);
    upsertEnvLine(envFile, 'BRAIN_BASE_URL', '');
    upsertEnvLine(envFile, 'BRAIN_AUTH_TOKEN', '');
    upsertEnvLine(envFile, 'BRAIN_API_KEY', '');
  } else {
    effectiveModel = model || 'devstral-small-2-fast:latest';
    upsertEnvLine(envFile, 'BRAIN_MODEL', effectiveModel);
    upsertEnvLine(
      envFile,
      'BRAIN_BASE_URL',
      'http://host.containers.internal:11434',
    );
    upsertEnvLine(envFile, 'BRAIN_AUTH_TOKEN', 'ollama');
    upsertEnvLine(envFile, 'BRAIN_API_KEY', '');
    upsertEnvLine(envFile, 'BRAIN_OAUTH_TOKEN', '');
  }
  // Persist model switch to fleet.json so activeBrainModel stays in sync
  try {
    const fleet = loadFleet();
    if (fleet[bot]) { fleet[bot].activeBrainModel = effectiveModel; writeFleet(fleet); }
  } catch (err) {
    logger.warn({ err, bot }, 'applyBrainMode: could not update activeBrainModel in fleet.json');
  }
  return `Updated ${bot} to ${mode}/${effectiveModel}. Restart required.`;
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

/** Auth guard — returns true if blocked (unauthorized). */
function requireMain(ctx: InfiniClawIpcContext, command: string): boolean {
  if (ctx.isMain) return false;
  logger.warn({ sourceGroup: ctx.sourceGroup }, `Unauthorized ${command} attempt blocked`);
  return true;
}

/** Cooldown gate — returns a rejection message if still cooling down, or null if OK. */
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

/** Send a message, swallowing errors (best-effort notification). */
async function safeSend(ctx: InfiniClawIpcContext, chatJid: string | null, text: string): Promise<void> {
  if (!chatJid) return;
  try { await ctx.sendMessage(chatJid, text); } catch (err) { logger.warn({ chatJid, err }, 'safeSend failed'); }
}

/** Parse chatJid from data, returning null if empty. */
function parseChatJid(data: CommandData): string | null {
  return typeof data.chatJid === 'string' && data.chatJid.trim().length > 0
    ? data.chatJid
    : null;
}

/** Parse bot name from IPC data, defaulting to calling bot's own name. */
function parseBot(data: CommandData): string {
  if (typeof data.bot === 'string' && data.bot.trim()) {
    if (getActiveBots().includes(data.bot)) return data.bot;
    logger.warn({ requested: data.bot, active: getActiveBots() }, 'parseBot: requested bot not in active list, falling back to self');
  }
  return ASSISTANT_NAME.toLowerCase();
}

/** Truncate long output for chat display. */
function truncateOutput(text: string, max = 3000): string {
  return text.length > max ? text.slice(-max) : text;
}

/** Simple branch/remote token validation for argv-safe git operations. */
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

/**
 * Handle InfiniClaw-specific IPC message types (image, file).
 * Returns true if the message type was handled, false otherwise.
 */
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
  const defaultName = isImage ? 'image.png' : 'attachment.bin';
  const defaultMime = isImage ? 'image/png' : 'application/octet-stream';
  await sendFn(data.chatJid!, buffer, data.filename || defaultName, data.mimetype || defaultMime, data.caption);
  logger.info({ chatJid: data.chatJid, sourceGroup: ctx.sourceGroup, filename: data.filename }, `IPC ${data.type} sent`);
  return true;
}

// ── Command handlers ────────────────────────────────────────────────────

async function handleSetBrainMode(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'set_brain_mode')) return;
  const validBot = typeof data.bot === 'string' && getActiveBots().includes(data.bot);
  const validMode = data.mode === 'anthropic' || data.mode === 'ollama';
  if (!data.bot || !validBot || !data.mode || !validMode) {
    logger.warn({ data }, 'Invalid set_brain_mode request');
    return;
  }
  try {
    applyBrainMode(
      data.bot,
      data.mode as 'anthropic' | 'ollama',
      typeof data.model === 'string' ? data.model : undefined,
    );
    logger.info({ bot: data.bot, mode: data.mode }, 'Brain mode updated via IPC — triggering restart');
    // Auto-restart so the new model takes effect immediately
    await handleRefreshBot(data, ctx);
  } catch (err) {
    logger.error({ err, data }, 'Failed to apply set_brain_mode');
  }
}

async function handleRefreshBot(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'refresh_bot')) return;
  const bot = parseBot(data);
  const chatJid = parseChatJid(data);

  const cooldownMsg = checkCooldown(`refresh:${bot}`, RESTART_COOLDOWN_MS);
  if (cooldownMsg) {
    logger.warn({ bot }, 'Refresh rejected — cooldown active');
    await safeSend(ctx, chatJid, cooldownMsg);
    return;
  }

  logger.info({ bot }, 'Refresh requested via IPC — validating deploy');

  const { ok, errors } = validateDeploy(bot);
  if (!ok) {
    logger.error({ bot, errors }, 'Deploy validation failed — aborting refresh');
    await safeSend(ctx, chatJid, `⛔ deploy validation failed — not refreshing:\n\n\`\`\`\n${truncateOutput(errors)}\n\`\`\``);
    return;
  }

  const selfBot = ASSISTANT_NAME.toLowerCase();
  if (bot === selfBot) {
    await handleSelfRefresh(bot, chatJid, ctx);
  } else {
    await handleCrossBotRefresh(bot, chatJid, ctx);
  }
}

async function handleSelfRefresh(bot: string, chatJid: string | null, ctx: InfiniClawIpcContext): Promise<void> {
  logger.info({ bot }, 'Deploy validation passed — deploying to self then refreshing');
  const deploy = deployInstance(bot);
  if (!deploy.ok) {
    logger.error({ bot, output: deploy.output }, 'Self-deploy failed — aborting refresh');
    await safeSend(ctx, chatJid, `⛔ self-deploy failed — not refreshing:\n\n\`\`\`\n${truncateOutput(deploy.output)}\n\`\`\``);
    return;
  }
  const mainJid = getMainRoomJid(ctx) || chatJid;
  await safeSend(ctx, mainJid, botStatusLine(bot, '⭕️'));
  try {
    serviceRefreshStartScript(resolveRoot(), bot);
  } catch (err) {
    logger.warn({ bot, err }, 'Start script refresh failed — refreshing anyway');
  }
  // Allow time for pending sends to flush before exiting
  logger.info({ bot }, 'Self-refresh: waiting for pending operations before exit');
  setTimeout(() => {
    logger.info({ bot }, 'Self-refresh: exiting now');
    process.exit(0);
  }, 2000);
}

async function handleCrossBotRefresh(bot: string, chatJid: string | null, ctx: InfiniClawIpcContext): Promise<void> {
  logger.info({ bot }, 'Deploy validation passed — refreshing');
  // Send refresh notice to target bot's main room
  try {
    const root = resolveRoot();
    const targetIpcMain = path.join(instanceDir(root, bot), 'data', 'ipc', 'main');
    const groupsFile = path.join(targetIpcMain, 'available_groups.json');
    if (fs.existsSync(groupsFile)) {
      const groups = JSON.parse(fs.readFileSync(groupsFile, 'utf-8')) as {
        groups: Array<{ jid: string; isRegistered: boolean }>;
      };
      const mainGroup = groups.groups.find((g) => g.isRegistered);
      if (mainGroup) {
        const messagesDir = path.join(targetIpcMain, 'messages');
        fs.mkdirSync(messagesDir, { recursive: true });
        const msg = {
          type: 'message',
          chatJid: mainGroup.jid,
          text: botStatusLine(bot, '⭕️'),
          sender: bot,
          timestamp: new Date().toISOString(),
        };
        fs.writeFileSync(
          path.join(messagesDir, `refresh-notice-${Date.now()}.json`),
          JSON.stringify(msg),
        );
      }
    }
  } catch (err) {
    logger.warn({ bot, err }, 'Failed to write refresh notice to target bot IPC');
  }
  try {
    serviceRefreshBot(resolveRoot(), bot);
    logger.info({ bot }, 'Cross-bot refresh succeeded');
  } catch (err) {
    logger.error({ bot, err }, 'Cross-bot refresh failed');
    await safeSend(ctx, chatJid, `⛔ refresh failed for ${bot}: ${errStr(err)}`);
  }
}

async function handleStopBot(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'stop_bot')) return;
  const bot = typeof data.bot === 'string' && getActiveBots().includes(data.bot)
    ? data.bot
    : null;
  if (!bot) {
    logger.warn({ data }, 'Invalid stop_bot request — missing or invalid bot name');
    return;
  }
  if (bot === ASSISTANT_NAME.toLowerCase()) {
    logger.warn({ bot }, 'Cannot stop self via stop_bot — use restart_self instead');
    return;
  }
  const chatJid = parseChatJid(data);
  logger.info({ bot }, 'Stop requested via IPC');
  try {
    serviceStopBot(bot);
    logger.info({ bot }, 'Bot stopped');
    await safeSend(ctx, chatJid, `<font color="#555555">🛑 ${bot} stopped.</font>`);
  } catch (err) {
    logger.error({ bot, err }, 'Failed to stop bot');
    await safeSend(ctx, chatJid, `⛔ failed to stop ${bot}: ${errStr(err)}`);
  }
}

async function handleRebuildImage(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'rebuild_image')) return;
  const bot = parseBot(data);
  const chatJid = parseChatJid(data);

  const cooldownMsg = checkCooldown(`rebuild:${bot}`, REBUILD_COOLDOWN_MS);
  if (cooldownMsg) {
    logger.warn({ bot }, 'rebuild_image rejected — cooldown active');
    await safeSend(ctx, chatJid, cooldownMsg);
    return;
  }

  logger.info({ bot }, 'Container image rebuild requested via IPC');
  await safeSend(ctx, chatJid, `🔧 rebuilding nanoclaw-${bot}:latest...`);
  const result = rebuildImage(bot);
  if (!result.ok) {
    logger.error({ bot, output: result.output }, 'Image rebuild failed');
    await safeSend(ctx, chatJid, `⛔ image rebuild failed for ${bot}:\n\n\`\`\`\n${truncateOutput(result.output)}\n\`\`\``);
  } else {
    logger.info({ bot }, 'Image rebuild succeeded');
    await safeSend(ctx, chatJid, `✅ nanoclaw-${bot}:latest rebuilt`);
  }
}

async function handleBotStatus(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'bot_status')) return;
  const bot = parseBot(data);
  const chatJid = parseChatJid(data);
  if (!chatJid) return;

  try {
    const logDir = path.resolve(process.env.INFINICLAW_ROOT || process.cwd(), '_runtime', 'logs');
    const errorLogPath = path.join(logDir, `${bot}.error.log`);
    const lastErrors = fs.existsSync(errorLogPath)
      ? fs.readFileSync(errorLogPath, 'utf8').split('\n').slice(-50).join('\n').trim()
      : '(no error log)';

    let serviceInfo = '';
    try {
      serviceInfo = execFileSync('npx', ['pm2', 'show', `infiniclaw-${bot}`], {
        timeout: 5_000,
        cwd: resolveRoot(),
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (e) {
      serviceInfo = e instanceof Error ? e.message : 'not running';
    }

    const parts = [`**${bot} status:**\n\`\`\`\n${serviceInfo}\n\`\`\``];
    if (lastErrors && lastErrors !== '(no error log)') {
      parts.push(`**Last errors:**\n\`\`\`\n${truncateOutput(lastErrors)}\n\`\`\``);
    }
    await ctx.sendMessage(chatJid, parts.join('\n\n'));
  } catch (err) {
    logger.error({ bot, err }, 'Failed to get bot status');
  }
}

function handleSetThread(data: CommandData, ctx: InfiniClawIpcContext): void {
  const targetJid = typeof data.chatJid === 'string' ? data.chatJid.trim() : '';
  if (!targetJid) {
    logger.warn({ sourceGroup: ctx.sourceGroup }, 'set_thread missing chatJid');
    return;
  }
  const registeredGroups = ctx.registeredGroups();
  const targetGroup = registeredGroups[targetJid];
  const authorized = ctx.isMain || (targetGroup && targetGroup.folder === ctx.sourceGroup);
  if (!authorized) {
    logger.warn({ sourceGroup: ctx.sourceGroup, targetJid }, 'Unauthorized set_thread attempt blocked');
    return;
  }
  const threadId = typeof data.threadId === 'string' && data.threadId.trim() ? data.threadId.trim() : null;
  ctx.setWorkThread(targetJid, threadId);
  // When thread is cleared, also prune the delegate auto-thread for this source group
  // to prevent the delegateThreadIds map from accumulating stale entries indefinitely.
  if (threadId === null) {
    ctx.clearDelegateThread(ctx.sourceGroup);
  }
  logger.info({ chatJid: targetJid, threadId, sourceGroup: ctx.sourceGroup }, 'Work thread updated via IPC');
}

async function handleSendReaction(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  const chatJid = parseChatJid(data);
  const eventId = typeof data.eventId === 'string' ? data.eventId.trim() : '';
  const emoji = typeof data.emoji === 'string' ? data.emoji.trim() : '';
  if (!chatJid || !eventId || !emoji) {
    logger.warn({ sourceGroup: ctx.sourceGroup }, 'send_reaction missing chatJid, eventId, or emoji');
    return;
  }
  await ctx.sendReaction(chatJid, eventId, emoji);
  logger.info({ chatJid, eventId, emoji, sourceGroup: ctx.sourceGroup }, 'Reaction sent via IPC');
}

async function handleRestartWksm(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'restart_wksm')) return;
  const chatJid = parseChatJid(data);
  logger.info('restart_wksm requested via IPC');
  try {
    const home = process.env.HOME || os.homedir();
    const wksc = `${home}/2025-WKS/main/venv/bin/wksc`;

    if (chatJid) await ctx.sendMessage(chatJid, '🔄 Restarting wksm...');

    const killOut = execSync(`/usr/sbin/lsof -ti:8765 | xargs kill -9 2>&1 || echo "no process on 8765"`, {
      shell: '/bin/bash',
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    if (chatJid) await ctx.sendMessage(chatJid, `kill: ${killOut}`);

    await new Promise(r => setTimeout(r, 2000));

    // wksc mcp proxy start is a blocking server process — must use spawn with detached
    const child = spawn(wksc, ['mcp', 'proxy', 'start'], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.unref();
    logger.info({ pid: child.pid }, 'wksm proxy spawned');

    // Wait for it to come up then verify
    await new Promise(r => setTimeout(r, 3000));

    const health = execSync('curl -s --max-time 3 http://localhost:8765/health 2>&1 || echo "not ready"', {
      shell: '/bin/bash',
      encoding: 'utf-8',
      timeout: 8000,
    }).trim();
    if (chatJid) await ctx.sendMessage(chatJid, `✅ wksm started (pid ${child.pid}), health: ${health}`);
  } catch (err) {
    logger.error({ err }, 'restart_wksm failed');
    if (chatJid) await ctx.sendMessage(chatJid, `⛔ restart_wksm failed: ${errStr(err)}`);
  }
}


async function handleRestartRelay(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'restart_relay')) return;
  const chatJid = parseChatJid(data);
  logger.info('restart_relay requested via IPC');
  try {
    const root = resolveRoot();
    if (chatJid) await ctx.sendMessage(chatJid, '🔄 Restarting relay...');
    execSync('npx pm2 restart infiniclaw-relay', { cwd: root, encoding: 'utf-8', timeout: 10_000, stdio: 'pipe' });
    logger.info('restart_relay succeeded');
    if (chatJid) await ctx.sendMessage(chatJid, '✅ Relay restarted');
  } catch (err) {
    logger.error({ err }, 'restart_relay failed');
    if (chatJid) await ctx.sendMessage(chatJid, `⛔ restart_relay failed: ${errStr(err)}`);
  }
}

async function handleGitPush(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'git_push')) return;
  const chatJid = parseChatJid(data);
  const remote = typeof data.remote === 'string' ? data.remote.trim() : 'origin';
  const branches = Array.isArray(data.branches) ? data.branches.map(String) : ['main'];
  if (!isSafeGitToken(remote) || branches.some((b) => !isSafeGitToken(b))) {
    await safeSend(ctx, chatJid, '⛔ git_push: invalid remote or branch name');
    return;
  }

  const cooldownMsg = checkCooldown('git_push', GIT_PUSH_COOLDOWN_MS);
  if (cooldownMsg) {
    logger.warn({ remote, branches }, 'git_push rejected — cooldown active');
    await safeSend(ctx, chatJid, cooldownMsg);
    return;
  }
  // git push requires host credentials — write to relay-tasks/ for the relay to execute on host.
  const tasksDir = path.join(resolveRoot(), '_runtime', 'relay-tasks');
  try {
    fs.mkdirSync(tasksDir, { recursive: true });
    const taskFile = path.join(tasksDir, `git-push-${Date.now()}.json`);
    fs.writeFileSync(taskFile, JSON.stringify({ type: 'git_push', remote, branches }));
    logger.info({ remote, branches, taskFile }, 'git_push queued for host relay');
    await safeSend(ctx, chatJid, `📤 git push ${branches.join(', ')} → ${remote} queued (relay executes on host)`);
  } catch (err) {
    logger.error({ err, remote, branches }, 'git_push: failed to queue relay task');
    await safeSend(ctx, chatJid, `⛔ git_push: failed to queue: ${errStr(err)}`);
  }
}

async function handleGitPull(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'git_pull')) return;
  const chatJid = parseChatJid(data);

  const cooldownMsg = checkCooldown('git_pull', GIT_PULL_COOLDOWN_MS);
  if (cooldownMsg) {
    await safeSend(ctx, chatJid, cooldownMsg);
    return;
  }

  const root = resolveRoot();

  try {
    // Fetch, stash, rebase, pop
    const { pulled } = gitSyncRepo(root);
    if (pulled === 0) {
      await safeSend(ctx, chatJid, '✅ git_pull: already up to date');
      return;
    }

    // Rebuild
    const nodeBinDir = path.dirname(process.execPath);
    execSync('npm run build', {
      cwd: root, encoding: 'utf-8', timeout: 120_000, stdio: 'pipe',
      env: { ...process.env, PATH: `${nodeBinDir}:${process.env.PATH}` },
    });

    // Deploy dist files to all active bot instances
    const distDir = path.join(root, 'dist');
    if (fs.existsSync(distDir)) {
      const jsFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));
      for (const bot of getActiveBots()) {
        const dstDir = path.join(root, '_runtime', 'instances', bot, 'dist');
        for (const f of jsFiles) {
          try { fs.copyFileSync(path.join(distDir, f), path.join(dstDir, f)); } catch { /* instance may not exist */ }
        }
      }
    }

    await safeSend(ctx, chatJid, `✅ git_pull: pulled ${pulled} commit(s), rebuilt, deployed`);
  } catch (err) {
    logger.error({ err }, 'git_pull failed');
    await safeSend(ctx, chatJid, `⛔ git_pull failed: ${errStr(err)}`);
  }
}

// ── Holodeck handlers ────────────────────────────────────────────────────

async function handleHolodeckCreate(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'holodeck_create')) return;
  const bot = parseBot(data);
  const branch = typeof data.branch === 'string' ? data.branch.trim() : '';
  const chatJid = parseChatJid(data);
  if (!branch) {
    await safeSend(ctx, chatJid, '⛔ holodeck_create: missing branch name');
    return;
  }
  if (!isSafeGitToken(branch)) {
    await safeSend(ctx, chatJid, '⛔ holodeck_create: invalid branch name');
    return;
  }
  logger.info({ bot, branch }, 'Holodeck create requested via IPC');
  await safeSend(ctx, chatJid, `🔧 Creating holodeck for ${bot} from branch '${branch}'...`);
  try {
    serviceHolodeckCreate(bot, branch);
    logger.info({ bot, branch }, 'Holodeck created');
    await safeSend(ctx, chatJid, `✅ Holodeck created for ${bot} (branch: ${branch})`);
  } catch (err) {
    logger.error({ bot, branch, err }, 'Holodeck create failed');
    await safeSend(ctx, chatJid, `⛔ holodeck_create failed for ${bot}: ${errStr(err)}`);
  }
}

async function handleHolodeckTeardown(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'holodeck_teardown')) return;
  const bot = parseBot(data);
  const chatJid = parseChatJid(data);
  logger.info({ bot }, 'Holodeck teardown requested via IPC');
  try {
    serviceHolodeckTeardown(bot);
    logger.info({ bot }, 'Holodeck torn down');
    await safeSend(ctx, chatJid, `✅ Holodeck torn down for ${bot}`);
  } catch (err) {
    logger.error({ bot, err }, 'Holodeck teardown failed');
    await safeSend(ctx, chatJid, `⛔ holodeck_teardown failed for ${bot}: ${errStr(err)}`);
  }
}

async function handleHolodeckPromote(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'holodeck_promote')) return;
  const bot = parseBot(data);
  const chatJid = parseChatJid(data);
  logger.info({ bot }, 'Holodeck promote requested via IPC');
  await safeSend(ctx, chatJid, `🔧 Promoting holodeck for ${bot} (merge + redeploy)...`);
  try {
    serviceHolodeckPromote(bot);
    logger.info({ bot }, 'Holodeck promoted');
    await safeSend(ctx, chatJid, `✅ Holodeck promoted for ${bot} — branch merged and live bot redeployed`);
  } catch (err) {
    logger.error({ bot, err }, 'Holodeck promote failed');
    await safeSend(ctx, chatJid, `⛔ holodeck_promote failed for ${bot}: ${errStr(err)}`);
  }
}

async function handleHolodeckSend(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'holodeck_send')) return;
  const bot = parseBot(data);
  const message = typeof data.message === 'string' ? data.message : '';
  const chatJid = parseChatJid(data);
  if (!message) {
    await safeSend(ctx, chatJid, '⛔ holodeck_send: missing message');
    return;
  }
  const hdBot = `${bot}-holodeck`;
  const root = resolveRoot();
  const dbPath = path.join(instanceDir(root, hdBot), 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) {
    await safeSend(ctx, chatJid, `⛔ No holodeck instance for ${bot} (no messages.db)`);
    return;
  }
  try {
    const db = new Database(dbPath);
    let msgId: string;
    try {
      msgId = `hd-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const timestamp = new Date().toISOString();
      const jidRow = db.prepare('SELECT jid FROM registered_groups LIMIT 1').get() as { jid: string } | undefined;
      const jid = jidRow?.jid || 'local:terminal';
      db.prepare(
        'INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, 0)',
      ).run(msgId, jid, 'operator', 'Captain', message, timestamp);
    } finally {
      db.close();
    }
    logger.info({ bot: hdBot, msgId }, 'Holodeck message injected');
    await safeSend(ctx, chatJid, `✅ Message sent to ${hdBot}`);
  } catch (err) {
    logger.error({ bot: hdBot, err }, 'Holodeck send failed');
    await safeSend(ctx, chatJid, `⛔ holodeck_send failed: ${errStr(err)}`);
  }
}

async function handleHolodeckRead(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'holodeck_read')) return;
  const bot = parseBot(data);
  const limit = typeof data.limit === 'number' && data.limit > 0 ? Math.min(data.limit, 100) : 20;
  const chatJid = parseChatJid(data);
  if (!chatJid) return;
  const hdBot = `${bot}-holodeck`;
  const root = resolveRoot();
  const dbPath = path.join(instanceDir(root, hdBot), 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) {
    await safeSend(ctx, chatJid, `⛔ No holodeck instance for ${bot} (no messages.db)`);
    return;
  }
  try {
    const db = new Database(dbPath, { readonly: true });
    let rows: Array<{ sender_name: string; content: string; timestamp: string }>;
    try {
      rows = db.prepare(
        'SELECT sender_name, content, timestamp FROM messages ORDER BY timestamp DESC LIMIT ?',
      ).all(limit) as Array<{ sender_name: string; content: string; timestamp: string }>;
    } finally {
      db.close();
    }
    if (rows.length === 0) {
      await safeSend(ctx, chatJid, `No messages in ${hdBot} holodeck.`);
      return;
    }
    const formatted = rows.reverse().map(
      (r) => `[${r.timestamp}] ${r.sender_name}: ${r.content.length > 200 ? r.content.slice(0, 200) + '...' : r.content}`,
    ).join('\n');
    await safeSend(ctx, chatJid, `**${hdBot} messages (last ${rows.length}):**\n\`\`\`\n${formatted}\n\`\`\``);
  } catch (err) {
    logger.error({ bot: hdBot, err }, 'Holodeck read failed');
    await safeSend(ctx, chatJid, `⛔ holodeck_read failed: ${errStr(err)}`);
  }
}

async function handleHolodeckStatus(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'holodeck_status')) return;
  const bot = parseBot(data);
  const chatJid = parseChatJid(data);
  if (!chatJid) return;
  const hdBot = `${bot}-holodeck`;
  try {
    let serviceInfo = '';
    try {
      serviceInfo = execFileSync('npx', ['pm2', 'show', `infiniclaw-${hdBot}`], {
        timeout: 5_000,
        cwd: resolveRoot(),
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (e) {
      serviceInfo = e instanceof Error ? e.message : 'not running';
    }
    const root = resolveRoot();
    const instance = instanceDir(root, hdBot);
    const exists = fs.existsSync(instance);
    const worktree = path.join(root, '_holodeck', bot);
    const worktreeExists = fs.existsSync(worktree);
    const parts = [
      `**${hdBot} holodeck status:**`,
      `Instance: ${exists ? instance : 'not deployed'}`,
      `Worktree: ${worktreeExists ? worktree : 'none'}`,
      `\`\`\`\n${serviceInfo}\n\`\`\``,
    ];
    await safeSend(ctx, chatJid, parts.join('\n'));
  } catch (err) {
    logger.error({ bot: hdBot, err }, 'Holodeck status failed');
    await safeSend(ctx, chatJid, `⛔ holodeck_status failed: ${errStr(err)}`);
  }
}

// ── Health & Fleet handlers ──────────────────────────────────────────

async function handleHealthCheck(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'health_check')) return;
  const chatJid = parseChatJid(data);
  if (!chatJid) return;
  try {
    const root = resolveRoot();
    const script = path.join(root, 'scripts', 'health-check.sh');
    if (!fs.existsSync(script)) {
      await ctx.sendMessage(chatJid, 'No health-check.sh script found.');
      return;
    }
    const output = execSync(`bash "${script}"`, {
      encoding: 'utf-8', timeout: 30_000, cwd: root,
      env: { ...process.env, MACHINE_NAME: os.hostname() },
    }).trim();
    await ctx.sendMessage(chatJid, `**${shipTag()} health:**\n\`\`\`\n${truncateOutput(output)}\n\`\`\``);
  } catch (err) {
    await safeSend(ctx, chatJid, `health_check failed: ${errStr(err)}`);
  }
}

async function handleFleetStatus(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'fleet_status')) return;
  const chatJid = parseChatJid(data);
  if (!chatJid) return;
  try {
    const config = loadShipConfig();
    const fleetPath = path.join(config.secretsPath, 'bots', 'fleet.json');
    const fleet = JSON.parse(fs.readFileSync(fleetPath, 'utf-8'));
    const bots = fleet.bots || {};
    const lines: string[] = [`**Fleet status** (${shipTag()}):\n`];
    const byRole: Record<string, Array<[string, { rank: number; ship: string | null; status: string }]>> = {};
    for (const [name, entry] of Object.entries(bots) as Array<[string, { role: string; rank: number; ship: string | null; status: string }]>) {
      if (!byRole[entry.role]) byRole[entry.role] = [];
      byRole[entry.role].push([name, entry]);
    }
    for (const [role, entries] of Object.entries(byRole)) {
      lines.push(`**${role}:**`);
      for (const [name, entry] of entries.sort((a, b) => a[1].rank - b[1].rank)) {
        const s = entry.status as string;
        const status = s === 'onduty' || s === 'active' ? 'ON ' : s === 'transit' ? 'TRN' : s === 'sleep' ? 'ZZZ' : s === 'quarters' ? 'QTR' : 'OFF';
        lines.push(`  ${status} #${entry.rank} ${name} → ${entry.ship || 'unassigned'}`);
      }
    }
    await ctx.sendMessage(chatJid, lines.join('\n'));
  } catch (err) {
    await safeSend(ctx, chatJid, `fleet_status failed: ${errStr(err)}`);
  }
}

// ── Main dispatcher ─────────────────────────────────────────────────────

/**
 * Handle InfiniClaw-specific IPC task commands.
 * Returns true if the command was handled, false if unknown.
 */
type CommandHandler = (data: CommandData, ctx: InfiniClawIpcContext) => void | Promise<void>;

// ── send_to_room ────────────────────────────────────────────────────────

async function handleSendToRoom(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'send_to_room')) return;
  const room = typeof data.room === 'string' ? data.room.trim() : '';
  const message = typeof data.message === 'string' ? data.message : '';
  if (!room || !message) {
    logger.warn({ sourceGroup: ctx.sourceGroup }, 'send_to_room: missing room or message');
    return;
  }

  // Resolve room name to JID
  const groups = ctx.registeredGroups();
  let targetJid: string | null = null;
  for (const [jid, group] of Object.entries(groups)) {
    if (group.name.toLowerCase() === room.toLowerCase()) {
      targetJid = jid;
      break;
    }
  }

  if (!targetJid) {
    logger.warn({ room, sourceGroup: ctx.sourceGroup }, 'send_to_room: room not found');
    return;
  }

  await safeSend(ctx, targetJid, message);
  logger.info({ room, sourceGroup: ctx.sourceGroup }, 'send_to_room delivered');
}

// ── Verification helpers ────────────────────────────────────────────

function verificationsPath(root: string): string {
  return path.join(root, '_runtime', 'data', 'verifications.json');
}

interface VerificationRecord {
  id: string;
  task_description: string;
  criteria: string;
  requested_by: string;
  assigned_to: string;
  status: 'pending' | 'verified' | 'failed';
  evidence?: string;
  requested_at: string;
  resolved_at?: string;
  source_group: string;
}

function readVerifications(root: string): VerificationRecord[] {
  const filePath = verificationsPath(root);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

function writeVerifications(root: string, records: VerificationRecord[]): void {
  const filePath = verificationsPath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2));
}

/** Sync verifications.json into a bot's instance data dir for container read access. */
function syncVerificationsToInstance(root: string, bot: string): void {
  const src = verificationsPath(root);
  if (!fs.existsSync(src)) return;
  const dst = path.join(instanceDir(root, bot), 'data', 'verifications.json');
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  } catch (err) { logger.warn({ bot, err }, 'Failed to sync verifications to instance'); }
}

async function handleRequestVerification(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'request_verification')) return;
  if (
    typeof data.id !== 'string' || !data.id.trim()
    || typeof data.task_description !== 'string' || !data.task_description.trim()
    || typeof data.criteria !== 'string' || !data.criteria.trim()
    || typeof data.requested_by !== 'string' || !data.requested_by.trim()
    || typeof data.assigned_to !== 'string' || !data.assigned_to.trim()
  ) {
    await safeSend(ctx, parseChatJid(data), '⛔ request_verification: missing required fields');
    return;
  }
  const root = resolveRoot();
  const record: VerificationRecord = {
    id: data.id.trim(),
    task_description: data.task_description.trim(),
    criteria: data.criteria.trim(),
    requested_by: data.requested_by.trim(),
    assigned_to: data.assigned_to.trim(),
    status: 'pending',
    requested_at: (data.timestamp as string) || new Date().toISOString(),
    source_group: data.groupFolder as string,
  };

  const records = readVerifications(root);
  records.push(record);
  writeVerifications(root, records);

  // Sync to all active bot instances so containers can read verifications.json
  for (const bot of getActiveBots()) {
    syncVerificationsToInstance(root, bot);
  }

  await safeSend(ctx, parseChatJid(data), `✅ Verification requested: ${record.id}\nAssigned to: ${record.assigned_to}\nCriteria: ${record.criteria}`);
}

async function handleSubmitVerification(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'submit_verification')) return;
  if (typeof data.id !== 'string' || !data.id.trim() || typeof data.passed !== 'boolean') {
    await safeSend(ctx, parseChatJid(data), '⛔ submit_verification: invalid id or passed flag');
    return;
  }
  const id = data.id.trim();
  const root = resolveRoot();
  const records = readVerifications(root);
  const record = records.find((r) => r.id === id);

  if (!record) {
    await safeSend(ctx, parseChatJid(data), `❌ Verification ${id} not found.`);
    return;
  }

  if (record.status !== 'pending') {
    await safeSend(ctx, parseChatJid(data), `Verification ${id} is already ${record.status}.`);
    return;
  }

  record.status = data.passed ? 'verified' : 'failed';
  if (typeof data.evidence === 'string') record.evidence = data.evidence;
  record.resolved_at = new Date().toISOString();

  writeVerifications(root, records);

  // Sync to all active bot instances
  for (const bot of getActiveBots()) {
    syncVerificationsToInstance(root, bot);
  }

  const icon = record.status === 'verified' ? '✅' : '❌';
  await safeSend(ctx, parseChatJid(data), `${icon} Verification ${record.id}: ${record.status.toUpperCase()}\nEvidence: ${record.evidence}`);
}

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  set_brain_mode: handleSetBrainMode,
  refresh_bot: handleRefreshBot,
  stop_bot: handleStopBot,
  rebuild_image: handleRebuildImage,
  bot_status: handleBotStatus,
  set_thread: handleSetThread,
  send_reaction: handleSendReaction,
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
  holodeck_send: handleHolodeckSend,
  holodeck_read: handleHolodeckRead,
  holodeck_status: handleHolodeckStatus,
};

export async function handleInfiniClawCommand(
  data: CommandData,
  ctx: InfiniClawIpcContext,
): Promise<boolean> {
  const handler = COMMAND_HANDLERS[data.type];
  if (!handler) return false;
  await handler(data, ctx);
  return true;
}
