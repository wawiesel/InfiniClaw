/**
 * InfiniClaw IPC command handlers.
 * Extended commands delegated from the base ipc.ts processTaskIpc switch.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { upsertEnvLine } from 'nanoclaw/env-utils.js';

import {
  ASSISTANT_ROLE,
} from 'nanoclaw/config.js';
import { logger } from 'nanoclaw/logger.js';
import {
  BOTS,
  bootstrapBot as serviceBootstrapBot,
  deployBot as serviceDeployBot,
  stopBot as serviceStopBot,
  rebuildImage as serviceRebuildImage,
  refreshPlist as serviceRefreshPlist,
  resolveRoot,
  instanceDir,
  validateDeploy as serviceValidateDeploy,
} from './service.js';
import type { RegisteredGroup } from 'nanoclaw/types.js';
import { statusMessage } from './formatting.js';

// ── Interfaces ──────────────────────────────────────────────────────────

export interface InfiniClawIpcContext {
  isMain: boolean;
  sourceGroup: string;
  sendMessage: (jid: string, text: string, threadId?: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  setWorkThread: (chatJid: string, threadId: string | null) => void;
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
}

// ── Helpers ─────────────────────────────────────────────────────────────

function resolveInfiniClawRoot(): string {
  return resolveRoot();
}

function validateDeploy(bot: string): Promise<{ ok: boolean; errors: string }> {
  return new Promise((resolve) => {
    try {
      const result = serviceValidateDeploy(resolveRoot(), bot);
      resolve(result);
    } catch (err) {
      resolve({ ok: false, errors: err instanceof Error ? err.message : String(err) });
    }
  });
}

function deployInstance(bot: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    try {
      const root = resolveRoot();
      serviceDeployBot(root, bot);
      serviceRebuildImage(root, bot);
      resolve({ ok: true, output: '' });
    } catch (err) {
      resolve({ ok: false, output: err instanceof Error ? err.message : String(err) });
    }
  });
}

function rebuildImage(bot: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    try {
      serviceRebuildImage(resolveRoot(), bot);
      resolve({ ok: true, output: '' });
    } catch (err) {
      resolve({ ok: false, output: err instanceof Error ? err.message : String(err) });
    }
  });
}

function applyBrainMode(
  bot: string,
  mode: 'anthropic' | 'ollama',
  model?: string,
): string {
  const root = resolveInfiniClawRoot();
  const envFile = path.join(root, 'bots', 'profiles', bot, 'env');
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
  const root = resolveInfiniClawRoot();
  const envFile = path.join(root, 'bots', 'profiles', bot, 'env');
  if (!fs.existsSync(envFile)) {
    return { mode: 'unknown', model: '' };
  }
  const content = fs.readFileSync(envFile, 'utf-8');
  const getValue = (key: string): string => {
    const match = content.match(new RegExp(`^${key}=(.*)`, 'm'));
    return match ? match[1].trim() : '';
  };
  const model = getValue('BRAIN_MODEL');
  const baseUrl = getValue('BRAIN_BASE_URL');
  const authToken = getValue('BRAIN_AUTH_TOKEN');
  if (baseUrl && (baseUrl.includes('ollama') || baseUrl.includes('11434'))) {
    return { mode: 'ollama', model };
  }
  if (authToken === 'ollama') {
    return { mode: 'ollama', model };
  }
  return { mode: model ? 'anthropic' : 'unknown', model };
}

/** Parse chatJid from data, returning null if empty. */
function parseChatJid(data: CommandData): string | null {
  return typeof data.chatJid === 'string' && data.chatJid.trim().length > 0
    ? data.chatJid
    : null;
}

/** Parse bot name, defaulting if invalid. */
function parseBot(data: CommandData, defaultBot: string): string {
  return typeof data.bot === 'string' && (BOTS as readonly string[]).includes(data.bot)
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
  if (data.type === 'image' && data.chatJid && data.imageData) {
    if (ctx.authorized) {
      const buffer = Buffer.from(data.imageData, 'base64');
      await ctx.sendImage(
        data.chatJid,
        buffer,
        data.filename || 'image.png',
        data.mimetype || 'image/png',
        data.caption,
      );
      logger.info(
        { chatJid: data.chatJid, sourceGroup: ctx.sourceGroup, filename: data.filename },
        'IPC image sent',
      );
    } else {
      logger.warn(
        { chatJid: data.chatJid, sourceGroup: ctx.sourceGroup },
        'Unauthorized IPC image attempt blocked',
      );
    }
    return true;
  }

  if (data.type === 'file' && data.chatJid && data.fileData) {
    if (ctx.authorized) {
      const buffer = Buffer.from(data.fileData, 'base64');
      await ctx.sendFile(
        data.chatJid,
        buffer,
        data.filename || 'attachment.bin',
        data.mimetype || 'application/octet-stream',
        data.caption,
      );
      logger.info(
        { chatJid: data.chatJid, sourceGroup: ctx.sourceGroup, filename: data.filename },
        'IPC file sent',
      );
    } else {
      logger.warn(
        { chatJid: data.chatJid, sourceGroup: ctx.sourceGroup },
        'Unauthorized IPC file attempt blocked',
      );
    }
    return true;
  }

  return false;
}

// ── Command handlers ────────────────────────────────────────────────────

async function handleSetBrainMode(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (!ctx.isMain) {
    logger.warn({ sourceGroup: ctx.sourceGroup }, 'Unauthorized set_brain_mode attempt blocked');
    return;
  }
  const validBot = data.bot === 'engineer' || data.bot === 'commander';
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
  if (!ctx.isMain) {
    logger.warn({ sourceGroup: ctx.sourceGroup }, 'Unauthorized restart_bot attempt blocked');
    return;
  }
  const bot = parseBot(data, 'engineer');
  const chatJid = parseChatJid(data);
  logger.info({ bot }, 'Restart requested via IPC — validating deploy');

  const { ok, errors } = await validateDeploy(bot);
  if (!ok) {
    logger.error({ bot, errors }, 'Deploy validation failed — aborting restart');
    if (chatJid) {
      try {
        await ctx.sendMessage(chatJid, `⛔ deploy validation failed — not restarting:\n\n\`\`\`\n${truncateOutput(errors)}\n\`\`\``);
      } catch {}
    }
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
  const deploy = await deployInstance(bot);
  if (!deploy.ok) {
    logger.error({ bot, output: deploy.output }, 'Self-deploy failed — aborting restart');
    if (chatJid) {
      try {
        await ctx.sendMessage(chatJid, `⛔ self-deploy failed — not restarting:\n\n\`\`\`\n${truncateOutput(deploy.output)}\n\`\`\``);
      } catch {}
    }
    return;
  }
  if (chatJid) {
    try { await ctx.sendMessage(chatJid, statusMessage('⭕️', 'restarting...')); } catch {}
  }
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
          text: statusMessage('⭕️', 'restarting...'),
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
    if (chatJid) {
      try {
        await ctx.sendMessage(chatJid, `⛔ bootstrap failed for ${bot}: ${(err as Error).message}`);
      } catch {}
    }
  }
}

async function handleStopBot(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (!ctx.isMain) {
    logger.warn({ sourceGroup: ctx.sourceGroup }, 'Unauthorized stop_bot attempt blocked');
    return;
  }
  const bot = typeof data.bot === 'string' && (BOTS as readonly string[]).includes(data.bot)
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
    if (chatJid) {
      try { await ctx.sendMessage(chatJid, `<font color="#555555">🛑 ${bot} stopped.</font>`); } catch {}
    }
  } catch (err) {
    logger.error({ bot, err }, 'Failed to stop bot');
    if (chatJid) {
      try { await ctx.sendMessage(chatJid, `⛔ failed to stop ${bot}: ${(err as Error).message}`); } catch {}
    }
  }
}

async function handleRebuildImage(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (!ctx.isMain) {
    logger.warn({ sourceGroup: ctx.sourceGroup }, 'Unauthorized rebuild_image attempt blocked');
    return;
  }
  const bot = parseBot(data, 'commander');
  const chatJid = parseChatJid(data);
  logger.info({ bot }, 'Container image rebuild requested via IPC');
  if (chatJid) {
    try { await ctx.sendMessage(chatJid, `🔧 rebuilding nanoclaw-${bot}:latest...`); } catch {}
  }
  const result = await rebuildImage(bot);
  if (!result.ok) {
    logger.error({ bot, output: result.output }, 'Image rebuild failed');
    if (chatJid) {
      try {
        await ctx.sendMessage(chatJid, `⛔ image rebuild failed for ${bot}:\n\n\`\`\`\n${truncateOutput(result.output)}\n\`\`\``);
      } catch {}
    }
  } else {
    logger.info({ bot }, 'Image rebuild succeeded');
    if (chatJid) {
      try { await ctx.sendMessage(chatJid, `✅ nanoclaw-${bot}:latest rebuilt`); } catch {}
    }
  }
}

async function handleBotStatus(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (!ctx.isMain) {
    logger.warn({ sourceGroup: ctx.sourceGroup }, 'Unauthorized bot_status attempt blocked');
    return;
  }
  const bot = typeof data.bot === 'string' && ['engineer', 'commander'].includes(data.bot)
    ? data.bot
    : 'commander';
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
  logger.info({ chatJid: targetJid, threadId, sourceGroup: ctx.sourceGroup }, 'Work thread updated via IPC');
}

async function handleRestartWksm(data: CommandData, ctx: InfiniClawIpcContext): Promise<void> {
  if (!ctx.isMain) {
    logger.warn({ sourceGroup: ctx.sourceGroup }, 'Unauthorized restart_wksm attempt blocked');
    return;
  }
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
  if (!ctx.isMain) {
    logger.warn({ sourceGroup: ctx.sourceGroup }, 'Unauthorized git_push attempt blocked');
    return;
  }
  const chatJid = parseChatJid(data) ?? '';
  const remote = typeof data.remote === 'string' ? data.remote.trim() : 'origin';
  const branches = Array.isArray(data.branches) ? data.branches.map(String) : ['main'];
  const safeBranch = /^[a-zA-Z0-9._\-/]+$/;
  if (!safeBranch.test(remote) || branches.some((b) => !safeBranch.test(b))) {
    if (chatJid) await ctx.sendMessage(chatJid, '⛔ git_push: invalid remote or branch name');
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
    if (chatJid) await ctx.sendMessage(chatJid, `✅ Pushed ${branches.join(', ')} to ${remote}`);
  } catch (err) {
    logger.error({ err, remote, branches }, 'git_push failed');
    if (chatJid) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.sendMessage(chatJid, `⛔ git_push failed: ${msg}`);
    }
  }
}

// ── Main dispatcher ─────────────────────────────────────────────────────

/**
 * Handle InfiniClaw-specific IPC task commands.
 * Returns true if the command was handled, false if unknown.
 */
export async function handleInfiniClawCommand(
  data: CommandData,
  ctx: InfiniClawIpcContext,
): Promise<boolean> {
  switch (data.type) {
    case 'set_brain_mode':
      await handleSetBrainMode(data, ctx);
      return true;
    case 'restart_bot':
      await handleRestartBot(data, ctx);
      return true;
    case 'stop_bot':
      await handleStopBot(data, ctx);
      return true;
    case 'rebuild_image':
      await handleRebuildImage(data, ctx);
      return true;
    case 'bot_status':
      await handleBotStatus(data, ctx);
      return true;
    case 'set_thread':
      handleSetThread(data, ctx);
      return true;
    case 'restart_wksm':
      await handleRestartWksm(data, ctx);
      return true;
    case 'git_push':
      await handleGitPush(data, ctx);
      return true;
    default:
      return false;
  }
}
