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

// ── Extended task commands ───────────────────────────────────────────────

/**
 * Handle InfiniClaw-specific IPC task commands.
 * Returns true if the command was handled, false if unknown.
 */
export async function handleInfiniClawCommand(
  data: {
    type: string;
    bot?: string;
    mode?: string;
    model?: string;
    chatJid?: string;
    threadId?: string;
    remote?: string;
    branches?: string[];
  },
  ctx: InfiniClawIpcContext,
): Promise<boolean> {
  const registeredGroups = ctx.registeredGroups();

  switch (data.type) {
    case 'set_brain_mode': {
      if (!ctx.isMain) {
        logger.warn(
          { sourceGroup: ctx.sourceGroup },
          'Unauthorized set_brain_mode attempt blocked',
        );
        return true;
      }
      if (
        data.bot &&
        (data.bot === 'engineer' || data.bot === 'commander') &&
        data.mode &&
        (data.mode === 'anthropic' || data.mode === 'ollama')
      ) {
        try {
          const summary = applyBrainMode(
            data.bot,
            data.mode,
            typeof data.model === 'string' ? data.model : undefined,
          );
          logger.info({ bot: data.bot, mode: data.mode }, 'Brain mode updated via IPC');
          if (typeof data.chatJid === 'string' && data.chatJid.trim().length > 0) {
            await ctx.sendMessage(data.chatJid, `engineer:\n\n${summary}`);
          }
        } catch (err) {
          logger.error({ err, data }, 'Failed to apply set_brain_mode');
        }
      } else {
        logger.warn({ data }, 'Invalid set_brain_mode request');
      }
      return true;
    }

    case 'restart_bot': {
      if (!ctx.isMain) {
        logger.warn({ sourceGroup: ctx.sourceGroup }, 'Unauthorized restart_bot attempt blocked');
        return true;
      }
      const bot = typeof data.bot === 'string' && (BOTS as readonly string[]).includes(data.bot)
        ? data.bot
        : 'engineer';
      logger.info({ bot }, 'Restart requested via IPC — validating deploy');
      const chatJid = typeof data.chatJid === 'string' && data.chatJid.trim().length > 0
        ? data.chatJid
        : null;
      const { ok, errors } = await validateDeploy(bot);
      if (!ok) {
        logger.error({ bot, errors }, 'Deploy validation failed — aborting restart');
        if (chatJid) {
          try {
            const trimmed = errors.length > 3000 ? errors.slice(-3000) : errors;
            await ctx.sendMessage(chatJid, `⛔ deploy validation failed — not restarting:\n\n\`\`\`\n${trimmed}\n\`\`\``);
          } catch {}
        }
        return true;
      }
      const selfBot = ASSISTANT_ROLE.toLowerCase();
      if (bot === selfBot) {
        logger.info({ bot }, 'Deploy validation passed — deploying to self then restarting');
        const deploy = await deployInstance(bot);
        if (!deploy.ok) {
          logger.error({ bot, output: deploy.output }, 'Self-deploy failed — aborting restart');
          if (chatJid) {
            try {
              const trimmed = deploy.output.length > 3000 ? deploy.output.slice(-3000) : deploy.output;
              await ctx.sendMessage(chatJid, `⛔ self-deploy failed — not restarting:\n\n\`\`\`\n${trimmed}\n\`\`\``);
            } catch {}
          }
          return true;
        }
        if (chatJid) {
          try {
            await ctx.sendMessage(chatJid, statusMessage('⭕️', 'restarting...'));
          } catch {}
        }
        setTimeout(() => {
          process.exit(0);
        }, 500);
      } else {
        logger.info({ bot }, 'Deploy validation passed — bootstrapping');
        // Send restarting notice to the TARGET bot's own main room (not the caller's room).
        // We find the target's registered JID from its available_groups.json and write
        // a message directly into its ipc-watcher messages dir.
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
          const root = resolveRoot();
          serviceBootstrapBot(root, bot);
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
      return true;
    }

    case 'stop_bot': {
      if (!ctx.isMain) {
        logger.warn({ sourceGroup: ctx.sourceGroup }, 'Unauthorized stop_bot attempt blocked');
        return true;
      }
      const bot = typeof data.bot === 'string' && (BOTS as readonly string[]).includes(data.bot)
        ? data.bot
        : null;
      if (!bot) {
        logger.warn({ data }, 'Invalid stop_bot request — missing or invalid bot name');
        return true;
      }
      const selfBot = ASSISTANT_ROLE.toLowerCase();
      if (bot === selfBot) {
        logger.warn({ bot }, 'Cannot stop self via stop_bot — use restart_self instead');
        return true;
      }
      const chatJid = typeof data.chatJid === 'string' && data.chatJid.trim().length > 0
        ? data.chatJid
        : null;
      logger.info({ bot }, 'Stop requested via IPC');
      try {
        serviceStopBot(bot);
        logger.info({ bot }, 'Bot stopped');
        if (chatJid) {
          try {
            await ctx.sendMessage(chatJid, `<font color="#555555">🛑 ${bot} stopped.</font>`);
          } catch {}
        }
      } catch (err) {
        logger.error({ bot, err }, 'Failed to stop bot');
        if (chatJid) {
          try {
            await ctx.sendMessage(chatJid, `⛔ failed to stop ${bot}: ${(err as Error).message}`);
          } catch {}
        }
      }
      return true;
    }

    case 'rebuild_image': {
      if (!ctx.isMain) {
        logger.warn({ sourceGroup: ctx.sourceGroup }, 'Unauthorized rebuild_image attempt blocked');
        return true;
      }
      const imgBot = typeof data.bot === 'string' && (BOTS as readonly string[]).includes(data.bot)
        ? data.bot
        : 'commander';
      const imgChatJid = typeof data.chatJid === 'string' && data.chatJid.trim().length > 0
        ? data.chatJid
        : null;
      logger.info({ bot: imgBot }, 'Container image rebuild requested via IPC');
      if (imgChatJid) {
        try { await ctx.sendMessage(imgChatJid, `🔧 rebuilding nanoclaw-${imgBot}:latest...`); } catch {}
      }
      const result = await rebuildImage(imgBot);
      if (!result.ok) {
        logger.error({ bot: imgBot, output: result.output }, 'Image rebuild failed');
        if (imgChatJid) {
          try {
            const trimmed = result.output.length > 3000 ? result.output.slice(-3000) : result.output;
            await ctx.sendMessage(imgChatJid, `⛔ image rebuild failed for ${imgBot}:\n\n\`\`\`\n${trimmed}\n\`\`\``);
          } catch {}
        }
      } else {
        logger.info({ bot: imgBot }, 'Image rebuild succeeded');
        if (imgChatJid) {
          try { await ctx.sendMessage(imgChatJid, `✅ nanoclaw-${imgBot}:latest rebuilt`); } catch {}
        }
      }
      return true;
    }

    case 'bot_status': {
      if (!ctx.isMain) {
        logger.warn({ sourceGroup: ctx.sourceGroup }, 'Unauthorized bot_status attempt blocked');
        return true;
      }
      const statusBot = typeof data.bot === 'string' && ['engineer', 'commander'].includes(data.bot)
        ? data.bot
        : 'commander';
      const statusChatJid = typeof data.chatJid === 'string' && data.chatJid.trim().length > 0
        ? data.chatJid
        : null;
      if (!statusChatJid) return true;

      try {
        const logDir = path.resolve(process.env.INFINICLAW_ROOT || process.cwd(), 'logs');
        const errorLogPath = path.join(logDir, `${statusBot}.error.log`);
        const lastErrors = fs.existsSync(errorLogPath)
          ? fs.readFileSync(errorLogPath, 'utf8').split('\n').slice(-50).join('\n').trim()
          : '(no error log)';

        let launchctlInfo = '';
        try {
          launchctlInfo = execSync(`launchctl list com.infiniclaw.${statusBot} 2>&1`, { timeout: 5_000 }).toString().trim();
        } catch (e) {
          launchctlInfo = e instanceof Error ? e.message : 'unknown';
        }

        const parts = [`**${statusBot} status:**\n\`\`\`\n${launchctlInfo}\n\`\`\``];
        if (lastErrors && lastErrors !== '(no error log)') {
          const trimmed = lastErrors.length > 3000 ? lastErrors.slice(-3000) : lastErrors;
          parts.push(`**Last errors:**\n\`\`\`\n${trimmed}\n\`\`\``);
        }
        await ctx.sendMessage(statusChatJid, parts.join('\n\n'));
      } catch (err) {
        logger.error({ statusBot, err }, 'Failed to get bot status');
      }
      return true;
    }

    case 'set_thread': {
      const targetJid = typeof data.chatJid === 'string' ? data.chatJid.trim() : '';
      if (!targetJid) {
        logger.warn({ sourceGroup: ctx.sourceGroup }, 'set_thread missing chatJid');
        return true;
      }
      const targetGroup = registeredGroups[targetJid];
      const authorized = ctx.isMain || (targetGroup && targetGroup.folder === ctx.sourceGroup);
      if (!authorized) {
        logger.warn({ sourceGroup: ctx.sourceGroup, targetJid }, 'Unauthorized set_thread attempt blocked');
        return true;
      }
      const threadId = typeof data.threadId === 'string' && data.threadId.trim() ? data.threadId.trim() : null;
      ctx.setWorkThread(targetJid, threadId);
      logger.info({ chatJid: targetJid, threadId, sourceGroup: ctx.sourceGroup }, 'Work thread updated via IPC');
      return true;
    }

    case 'git_push': {
      if (!ctx.isMain) {
        logger.warn({ sourceGroup: ctx.sourceGroup }, 'Unauthorized git_push attempt blocked');
        return true;
      }
      const gpChatJid = typeof data.chatJid === 'string' ? data.chatJid.trim() : '';
      const remote = typeof data.remote === 'string' ? data.remote.trim() : 'origin';
      const branches = Array.isArray(data.branches) ? data.branches.map(String) : ['main'];
      const safeBranch = /^[a-zA-Z0-9._\-/]+$/;
      if (!safeBranch.test(remote) || branches.some((b) => !safeBranch.test(b))) {
        if (gpChatJid) await ctx.sendMessage(gpChatJid, '⛔ git_push: invalid remote or branch name');
        return true;
      }
      try {
        const root = resolveRoot();
        const branchArgs = branches.join(' ');
        execSync(`git push ${remote} ${branchArgs}`, {
          cwd: root,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30000,
        });
        logger.info({ remote, branches }, 'git_push succeeded');
        if (gpChatJid) await ctx.sendMessage(gpChatJid, `✅ Pushed ${branches.join(', ')} to ${remote}`);
      } catch (err) {
        logger.error({ err, remote, branches }, 'git_push failed');
        if (gpChatJid) {
          const msg = err instanceof Error ? err.message : String(err);
          await ctx.sendMessage(gpChatJid, `⛔ git_push failed: ${msg}`);
        }
      }
      return true;
    }

    default:
      return false;
  }
}
