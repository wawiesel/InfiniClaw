/**
 * InfiniClaw IPC command handlers.
 * Extended commands delegated from the base ipc.ts processTaskIpc switch.
 */
import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { isOllamaBaseUrl, parseEnvFile, upsertEnvLine } from 'nanoclaw/env-utils.js';

import {
  ASSISTANT_ROLE,
  MAIN_GROUP_FOLDER,
} from 'nanoclaw/config.js';
import { logger } from 'nanoclaw/logger.js';
import { loadMachineConfig } from './machine-config.js';
import {
  getActiveBots,
  bootstrapBot as serviceBootstrapBot,
  deployBot as serviceDeployBot,
  stopBot as serviceStopBot,
  rebuildImage as serviceRebuildImage,
  refreshPlist as serviceRefreshPlist,
  resolveRoot,
  instanceDir,
  loadProfileEnv,
  validateDeploy as serviceValidateDeploy,
  holodeckCreate as serviceHolodeckCreate,
  holodeckTeardown as serviceHolodeckTeardown,
  holodeckPromote as serviceHolodeckPromote,
} from './service.js';
import type { RegisteredGroup } from 'nanoclaw/types.js';
import { statusMessage } from './formatting.js';

// ── Cooldown tracking ───────────────────────────────────────────────────

const RESTART_COOLDOWN_MS = 60_000; // 60 seconds
const REBUILD_COOLDOWN_MS = 5 * 60_000; // 5 minutes — image builds are expensive
const GIT_PUSH_COOLDOWN_MS = 60_000; // 60 seconds
const cooldowns: Record<string, number> = {};

// ── Interfaces ──────────────────────────────────────────────────────────

export interface InfiniClawIpcContext {
  isMain: boolean;
  sourceGroup: string;
  sendMessage: (jid: string, text: string, threadId?: string) => Promise<void>;
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
}

// ── Helpers ─────────────────────────────────────────────────────────────

function trySync<T>(fn: () => T, fallback: (err: unknown) => T): T {
  try { return fn(); } catch (err) { return fallback(err); }
}

function errStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
    return `<font color="#888888"><em>${emoji} ${name} · 🔧 ${role} · 💬 ${group} · 🧠 ${model} · 🖥️ ${hostname}</em></font>`;
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
  return trySync(() => {
    const root = resolveRoot();
    serviceDeployBot(root, bot);
    serviceRebuildImage(root, bot);
    return { ok: true as boolean, output: '' };
  }, (err) => ({ ok: false, output: errStr(err) }));
}

function rebuildImage(bot: string): { ok: boolean; output: string } {
  return trySync(
    () => { serviceRebuildImage(resolveRoot(), bot); return { ok: true as boolean, output: '' }; },
    (err) => ({ ok: false, output: errStr(err) }),
  );
}

function applyBrainMode(
  bot: string,
  mode: 'anthropic' | 'ollama',
  model?: string,
): string {
  const config = loadMachineConfig();
  const envFile = path.join(config.secretsPath, bot, 'env');
  if (!fs.existsSync(envFile)) {
    throw new Error(`Missing profile env: ${envFile}`);
  }

  if (mode === 'anthropic') {
    upsertEnvLine(envFile, 'BRAIN_MODEL', model || 'claude-sonnet-4-5');
    upsertEnvLine(envFile, 'BRAIN_BASE_URL', '');
    upsertEnvLine(envFile, 'BRAIN_AUTH_TOKEN', '');
    upsertEnvLine(envFile, 'BRAIN_API_KEY', '');
    const effectiveModel = model || 'claude-sonnet-4-5';
    return `Updated ${bot} to anthropic/${effectiveModel}. Restart required.`;
  }

  const effectiveModel = model || 'devstral-small-2-fast:latest';
  upsertEnvLine(envFile, 'BRAIN_MODEL', effectiveModel);
  upsertEnvLine(
    envFile,
    'BRAIN_BASE_URL',
    'http://host.containers.internal:11434',
  );
  upsertEnvLine(envFile, 'BRAIN_AUTH_TOKEN', 'ollama');
  upsertEnvLine(envFile, 'BRAIN_API_KEY', '');
  upsertEnvLine(envFile, 'BRAIN_OAUTH_TOKEN', '');
  return `Updated ${bot} to ollama/${effectiveModel}. Restart required.`;
}

export function readBrainMode(bot: string): { mode: 'anthropic' | 'ollama' | 'unknown'; model: string } {
  const envFile = path.join(loadMachineConfig().secretsPath, bot, 'env');
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
  try { await ctx.sendMessage(chatJid, text); } catch { /* best-effort */ }
}

/** Parse chatJid from data, returning null if empty. */
function parseChatJid(data: CommandData): string | null {
  return typeof data.chatJid === 'string' && data.chatJid.trim().length > 0
    ? data.chatJid
    : null;
}

/** Parse bot name, defaulting if invalid. */
function parseBot(data: CommandData, defaultBot: string): string {
  return typeof data.bot === 'string' && getActiveBots().includes(data.bot)
    ? data.bot
    : defaultBot;
}

/** Truncate long output for chat display. */
function truncateOutput(text: string, max = 3000): string {
  return text.length > max ? text.slice(-max) : text;
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

  const buffer = Buffer.from((isImage ? data.imageData : data.fileData)!, 'base64');
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
    const summary = applyBrainMode(
      data.bot,
      data.mode as 'anthropic' | 'ollama',
      typeof data.model === 'string' ? data.model : undefined,
    );
    logger.info({ bot: data.bot, mode: data.mode }, 'Brain mode updated via IPC');
    const chatJid = parseChatJid(data);
    if (chatJid) await ctx.sendMessage(chatJid, `engineer:\n\n${summary}`);
  } catch (err) {
    logger.error({ err, data }, 'Failed to apply set_brain_mode');
  }
}

async function handleRestartBot(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'restart_bot')) return;
  const bot = parseBot(data, 'cid');
  const chatJid = parseChatJid(data);

  const cooldownMsg = checkCooldown(`restart:${bot}`, RESTART_COOLDOWN_MS);
  if (cooldownMsg) {
    logger.warn({ bot }, 'Restart rejected — cooldown active');
    await safeSend(ctx, chatJid, cooldownMsg);
    return;
  }

  logger.info({ bot }, 'Restart requested via IPC — validating deploy');

  const { ok, errors } = validateDeploy(bot);
  if (!ok) {
    logger.error({ bot, errors }, 'Deploy validation failed — aborting restart');
    await safeSend(ctx, chatJid, `⛔ deploy validation failed — not restarting:\n\n\`\`\`\n${truncateOutput(errors)}\n\`\`\``);
    return;
  }

  const selfBot = ASSISTANT_ROLE.toLowerCase();
  if (bot === selfBot) {
    await handleSelfRestart(bot, chatJid, ctx);
  } else {
    await handleCrossBotRestart(bot, chatJid, ctx);
  }
}

async function handleSelfRestart(bot: string, chatJid: string | null, ctx: InfiniClawIpcContext): Promise<void> {
  logger.info({ bot }, 'Deploy validation passed — deploying to self then restarting');
  const deploy = deployInstance(bot);
  if (!deploy.ok) {
    logger.error({ bot, output: deploy.output }, 'Self-deploy failed — aborting restart');
    await safeSend(ctx, chatJid, `⛔ self-deploy failed — not restarting:\n\n\`\`\`\n${truncateOutput(deploy.output)}\n\`\`\``);
    return;
  }
  const mainJid = getMainRoomJid(ctx) || chatJid;
  await safeSend(ctx, mainJid, botStatusLine(bot, '⭕️'));
  try {
    serviceRefreshPlist(resolveRoot(), bot);
  } catch (err) {
    logger.warn({ bot, err }, 'Plist refresh failed — restarting anyway');
  }
  setTimeout(() => process.exit(0), 500);
}

async function handleCrossBotRestart(bot: string, chatJid: string | null, ctx: InfiniClawIpcContext): Promise<void> {
  logger.info({ bot }, 'Deploy validation passed — bootstrapping');
  // Send restart notice to target bot's main room
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
          path.join(messagesDir, `restart-notice-${Date.now()}.json`),
          JSON.stringify(msg),
        );
      }
    }
  } catch (err) {
    logger.warn({ bot, err }, 'Failed to write restart notice to target bot IPC');
  }
  try {
    serviceBootstrapBot(resolveRoot(), bot);
    logger.info({ bot }, 'Cross-bot bootstrap succeeded');
  } catch (err) {
    logger.error({ bot, err }, 'Cross-bot bootstrap failed');
    await safeSend(ctx, chatJid, `⛔ bootstrap failed for ${bot}: ${errStr(err)}`);
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
  if (bot === ASSISTANT_ROLE.toLowerCase()) {
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
  const bot = parseBot(data, 'johnny5');
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
  const bot = typeof data.bot === 'string' && getActiveBots().includes(data.bot)
    ? data.bot
    : 'johnny5';
  const chatJid = parseChatJid(data);
  if (!chatJid) return;

  try {
    const logDir = path.resolve(process.env.INFINICLAW_ROOT || process.cwd(), 'logs');
    const errorLogPath = path.join(logDir, `${bot}.error.log`);
    const lastErrors = fs.existsSync(errorLogPath)
      ? fs.readFileSync(errorLogPath, 'utf8').split('\n').slice(-50).join('\n').trim()
      : '(no error log)';

    let launchctlInfo = '';
    try {
      launchctlInfo = execSync(`launchctl list com.infiniclaw.${bot} 2>&1`, { timeout: 5_000 }).toString().trim();
    } catch (e) {
      launchctlInfo = e instanceof Error ? e.message : 'unknown';
    }

    const parts = [`**${bot} status:**\n\`\`\`\n${launchctlInfo}\n\`\`\``];
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

async function handleRestartWksm(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'restart_wksm')) return;
  const chatJid = parseChatJid(data);
  logger.info('restart_wksm requested via IPC');
  try {
    const home = process.env.HOME || '/Users/ww5';
    const wksc = `${home}/2025-WKS/main/venv/bin/wksc`;

    if (chatJid) await ctx.sendMessage(chatJid, '🔄 Restarting wksm...');

    const killOut = execSync(`/usr/sbin/lsof -ti:8765 | xargs kill -9 2>&1 || echo "no process on 8765"`, {
      shell: '/bin/bash',
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    if (chatJid) await ctx.sendMessage(chatJid, `kill: ${killOut}`);

    await new Promise(r => setTimeout(r, 2000));

    const startOut = execSync(`${wksc} mcp proxy start 2>&1`, {
      shell: '/bin/bash',
      encoding: 'utf-8',
      timeout: 15000,
    }).trim();
    if (chatJid) await ctx.sendMessage(chatJid, `start: ${startOut}`);

    await new Promise(r => setTimeout(r, 2000));

    const health = execSync('curl -s http://localhost:8765/health', {
      shell: '/bin/bash',
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (chatJid) await ctx.sendMessage(chatJid, `health: ${health}`);
  } catch (err) {
    logger.error({ err }, 'restart_wksm failed');
    if (chatJid) await ctx.sendMessage(chatJid, `⛔ restart_wksm failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}


async function handleGitPush(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'git_push')) return;
  const chatJid = parseChatJid(data);
  const remote = typeof data.remote === 'string' ? data.remote.trim() : 'origin';
  const branches = Array.isArray(data.branches) ? data.branches.map(String) : ['main'];
  const safeBranch = /^[a-zA-Z0-9._\-/]+$/;
  if (!safeBranch.test(remote) || branches.some((b) => !safeBranch.test(b))) {
    await safeSend(ctx, chatJid, '⛔ git_push: invalid remote or branch name');
    return;
  }

  const cooldownMsg = checkCooldown('git_push', GIT_PUSH_COOLDOWN_MS);
  if (cooldownMsg) {
    logger.warn({ remote, branches }, 'git_push rejected — cooldown active');
    await safeSend(ctx, chatJid, cooldownMsg);
    return;
  }
  try {
    const branchArgs = branches.join(' ');
    execSync(`git push ${remote} ${branchArgs}`, {
      cwd: resolveRoot(),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    logger.info({ remote, branches }, 'git_push succeeded');
    await safeSend(ctx, chatJid, `✅ Pushed ${branches.join(', ')} to ${remote}`);
  } catch (err) {
    logger.error({ err, remote, branches }, 'git_push failed');
    await safeSend(ctx, chatJid, `⛔ git_push failed: ${errStr(err)}`);
  }
}

// ── Holodeck handlers ────────────────────────────────────────────────────

async function handleHolodeckCreate(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'holodeck_create')) return;
  const bot = parseBot(data, 'cid');
  const branch = typeof data.branch === 'string' ? data.branch.trim() : '';
  const chatJid = parseChatJid(data);
  if (!branch) {
    await safeSend(ctx, chatJid, '⛔ holodeck_create: missing branch name');
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
  const bot = parseBot(data, 'cid');
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
  const bot = parseBot(data, 'cid');
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
  const bot = parseBot(data, 'cid');
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
    const msgId = `hd-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const timestamp = new Date().toISOString();
    const jidRow = db.prepare('SELECT jid FROM registered_groups LIMIT 1').get() as { jid: string } | undefined;
    const jid = jidRow?.jid || 'local:terminal';
    db.prepare(
      'INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, 0)',
    ).run(msgId, jid, 'operator', 'Captain', message, timestamp);
    db.close();
    logger.info({ bot: hdBot, msgId }, 'Holodeck message injected');
    await safeSend(ctx, chatJid, `✅ Message sent to ${hdBot}`);
  } catch (err) {
    logger.error({ bot: hdBot, err }, 'Holodeck send failed');
    await safeSend(ctx, chatJid, `⛔ holodeck_send failed: ${errStr(err)}`);
  }
}

async function handleHolodeckRead(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (requireMain(ctx, 'holodeck_read')) return;
  const bot = parseBot(data, 'cid');
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
    const rows = db.prepare(
      'SELECT sender_name, content, timestamp FROM messages ORDER BY timestamp DESC LIMIT ?',
    ).all(limit) as Array<{ sender_name: string; content: string; timestamp: string }>;
    db.close();
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
  const bot = parseBot(data, 'cid');
  const chatJid = parseChatJid(data);
  if (!chatJid) return;
  const hdBot = `${bot}-holodeck`;
  try {
    let launchctlInfo = '';
    try {
      launchctlInfo = execSync(`launchctl list com.infiniclaw.${hdBot} 2>&1`, { timeout: 5_000 }).toString().trim();
    } catch (e) {
      launchctlInfo = e instanceof Error ? e.message : 'not running';
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
      `\`\`\`\n${launchctlInfo}\n\`\`\``,
    ];
    await safeSend(ctx, chatJid, parts.join('\n'));
  } catch (err) {
    logger.error({ bot: hdBot, err }, 'Holodeck status failed');
    await safeSend(ctx, chatJid, `⛔ holodeck_status failed: ${errStr(err)}`);
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

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  set_brain_mode: handleSetBrainMode,
  restart_bot: handleRestartBot,
  stop_bot: handleStopBot,
  rebuild_image: handleRebuildImage,
  bot_status: handleBotStatus,
  set_thread: handleSetThread,
  send_to_room: handleSendToRoom,
  restart_wksm: handleRestartWksm,

  git_push: handleGitPush,
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
