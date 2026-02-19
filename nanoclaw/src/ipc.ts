import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { upsertEnvLine } from './env-utils.js';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  ASSISTANT_ROLE,
  CAPTAIN_USER_ID,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { logger } from './logger.js';
import { grantTemporaryMount, revokeMount } from './mount-security.js';
import {
  validateDeploy as serviceValidateDeploy,
  BOTS,
  bootstrapBot as serviceBootstrapBot,
  deployBot as serviceDeployBot,
  stopBot as serviceStopBot,
  rebuildImage as serviceRebuildImage,
  resolveRoot,
} from './service.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string, threadId?: string) => Promise<void>;
  sendImage: (jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string) => Promise<void>;
  sendFile: (jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string) => Promise<void>;
  defaultSenderForGroup: (sourceGroup: string) => string;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  unregisterGroup: (jid: string) => void;
  setWorkThread: (chatJid: string, threadId: string | null) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

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

/** Deploy instance: save persona, rsync code, deps, build, restore persona, rebuild container image. */
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

/** Rebuild a container image (e.g. nanoclaw-commander:latest). */
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

// upsertEnvLine imported from env-utils.ts (was upsertEnvValue)

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

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Authorization: verify this group can send to this chatJid
              const targetGroup = registeredGroups[data.chatJid];
              const authorized = isMain || (targetGroup && targetGroup.folder === sourceGroup);

              if (data.type === 'message' && data.chatJid && data.text) {
                if (authorized) {
                  const sender =
                    typeof data.sender === 'string' && data.sender.trim()
                      ? data.sender.trim()
                      : deps.defaultSenderForGroup(sourceGroup);
                  const threadId = typeof data.threadId === 'string' ? data.threadId : undefined;
                  await deps.sendMessage(
                    data.chatJid,
                    `${sender}:\n\n${String(data.text)}`,
                    threadId,
                  );
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (data.type === 'image' && data.chatJid && data.imageData) {
                if (authorized) {
                  const buffer = Buffer.from(data.imageData, 'base64');
                  await deps.sendImage(
                    data.chatJid,
                    buffer,
                    data.filename || 'image.png',
                    data.mimetype || 'image/png',
                    data.caption,
                  );
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup, filename: data.filename },
                    'IPC image sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC image attempt blocked',
                  );
                }
              } else if (data.type === 'file' && data.chatJid && data.fileData) {
                if (authorized) {
                  const buffer = Buffer.from(data.fileData, 'base64');
                  await deps.sendFile(
                    data.chatJid,
                    buffer,
                    data.filename || 'attachment.bin',
                    data.mimetype || 'application/octet-stream',
                    data.caption,
                  );
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup, filename: data.filename },
                    'IPC file sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC file attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              fs.unlinkSync(filePath);
              await processTaskIpc(data, sourceGroup, isMain, deps);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For brain mode control
    bot?: string;
    mode?: string;
    model?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For git_push
    remote?: string;
    branches?: string[];
    // For set_thread
    threadId?: string;
    // For grant_mount / revoke_mount
    hostPath?: string;
    allowReadWrite?: boolean;
    durationMinutes?: number;
    description?: string;
    sender?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        // Remove any existing group with the same folder but different JID
        const existing = Object.entries(registeredGroups)
          .find(([jid, g]) => g.folder === data.folder && jid !== data.jid);
        if (existing) {
          deps.unregisterGroup(existing[0]);
          logger.info({ oldJid: existing[0], newJid: data.jid, folder: data.folder }, 'Replaced existing group with same folder');
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'set_brain_mode':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized set_brain_mode attempt blocked',
        );
        break;
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
            await deps.sendMessage(data.chatJid, `engineer:\n\n${summary}`);
          }
        } catch (err) {
          logger.error({ err, data }, 'Failed to apply set_brain_mode');
        }
      } else {
        logger.warn({ data }, 'Invalid set_brain_mode request');
      }
      break;

    case 'restart_bot': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized restart_bot attempt blocked');
        break;
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
            await deps.sendMessage(chatJid, `⛔ deploy validation failed — not restarting:\n\n\`\`\`\n${trimmed}\n\`\`\``);
          } catch {}
        }
        break;
      }
      // Determine if this is a self-restart or cross-bot restart
      const selfBot = ASSISTANT_ROLE.toLowerCase();
      if (bot === selfBot) {
        logger.info({ bot }, 'Deploy validation passed — deploying to self then restarting');
        const deploy = await deployInstance(bot);
        if (!deploy.ok) {
          logger.error({ bot, output: deploy.output }, 'Self-deploy failed — aborting restart');
          if (chatJid) {
            try {
              const trimmed = deploy.output.length > 3000 ? deploy.output.slice(-3000) : deploy.output;
              await deps.sendMessage(chatJid, `⛔ self-deploy failed — not restarting:\n\n\`\`\`\n${trimmed}\n\`\`\``);
            } catch {}
          }
          break;
        }
        if (chatJid) {
          try {
            await deps.sendMessage(chatJid, `<font color="#555555">⭕️ restarting ${bot}...</font>`);
          } catch {}
        }
        // Exit gracefully — launchd will restart with the newly deployed code
        setTimeout(() => {
          process.exit(0);
        }, 500);
      } else {
        // Cross-bot: use bootstrapBot (handles both new and existing bots)
        logger.info({ bot }, 'Deploy validation passed — bootstrapping');
        if (chatJid) {
          try {
            await deps.sendMessage(chatJid, `<font color="#555555">⭕️ restarting ${bot}...</font>`);
          } catch {}
        }
        try {
          const root = resolveRoot();
          serviceBootstrapBot(root, bot);
          logger.info({ bot }, 'Cross-bot bootstrap succeeded');
        } catch (err) {
          logger.error({ bot, err }, 'Cross-bot bootstrap failed');
          if (chatJid) {
            try {
              await deps.sendMessage(chatJid, `⛔ bootstrap failed for ${bot}: ${(err as Error).message}`);
            } catch {}
          }
        }
      }
      break;
    }

    case 'stop_bot': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized stop_bot attempt blocked');
        break;
      }
      const bot = typeof data.bot === 'string' && (BOTS as readonly string[]).includes(data.bot)
        ? data.bot
        : null;
      if (!bot) {
        logger.warn({ data }, 'Invalid stop_bot request — missing or invalid bot name');
        break;
      }
      const selfBot = ASSISTANT_ROLE.toLowerCase();
      if (bot === selfBot) {
        logger.warn({ bot }, 'Cannot stop self via stop_bot — use restart_self instead');
        break;
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
            await deps.sendMessage(chatJid, `<font color="#555555">🛑 ${bot} stopped.</font>`);
          } catch {}
        }
      } catch (err) {
        logger.error({ bot, err }, 'Failed to stop bot');
        if (chatJid) {
          try {
            await deps.sendMessage(chatJid, `⛔ failed to stop ${bot}: ${(err as Error).message}`);
          } catch {}
        }
      }
      break;
    }

    case 'rebuild_image': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized rebuild_image attempt blocked');
        break;
      }
      const imgBot = typeof data.bot === 'string' && (BOTS as readonly string[]).includes(data.bot)
        ? data.bot
        : 'commander';
      const imgChatJid = typeof data.chatJid === 'string' && data.chatJid.trim().length > 0
        ? data.chatJid
        : null;
      logger.info({ bot: imgBot }, 'Container image rebuild requested via IPC');
      if (imgChatJid) {
        try { await deps.sendMessage(imgChatJid, `🔧 rebuilding nanoclaw-${imgBot}:latest...`); } catch {}
      }
      const result = await rebuildImage(imgBot);
      if (!result.ok) {
        logger.error({ bot: imgBot, output: result.output }, 'Image rebuild failed');
        if (imgChatJid) {
          try {
            const trimmed = result.output.length > 3000 ? result.output.slice(-3000) : result.output;
            await deps.sendMessage(imgChatJid, `⛔ image rebuild failed for ${imgBot}:\n\n\`\`\`\n${trimmed}\n\`\`\``);
          } catch {}
        }
      } else {
        logger.info({ bot: imgBot }, 'Image rebuild succeeded');
        if (imgChatJid) {
          try { await deps.sendMessage(imgChatJid, `✅ nanoclaw-${imgBot}:latest rebuilt`); } catch {}
        }
      }
      break;
    }

    case 'bot_status': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized bot_status attempt blocked');
        break;
      }
      const statusBot = typeof data.bot === 'string' && ['engineer', 'commander'].includes(data.bot)
        ? data.bot
        : 'commander';
      const statusChatJid = typeof data.chatJid === 'string' && data.chatJid.trim().length > 0
        ? data.chatJid
        : null;
      if (!statusChatJid) break;

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
        await deps.sendMessage(statusChatJid, parts.join('\n\n'));
      } catch (err) {
        logger.error({ statusBot, err }, 'Failed to get bot status');
      }
      break;
    }

    case 'set_thread': {
      // Any group can set its own work thread; main can set any group's thread
      const targetJid = typeof data.chatJid === 'string' ? data.chatJid.trim() : '';
      if (!targetJid) {
        logger.warn({ sourceGroup }, 'set_thread missing chatJid');
        break;
      }
      const targetGroup = registeredGroups[targetJid];
      const authorized = isMain || (targetGroup && targetGroup.folder === sourceGroup);
      if (!authorized) {
        logger.warn({ sourceGroup, targetJid }, 'Unauthorized set_thread attempt blocked');
        break;
      }
      const threadId = typeof data.threadId === 'string' && data.threadId.trim() ? data.threadId.trim() : null;
      deps.setWorkThread(targetJid, threadId);
      logger.info({ chatJid: targetJid, threadId, sourceGroup }, 'Work thread updated via IPC');
      break;
    }

    case 'git_push': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized git_push attempt blocked');
        break;
      }
      const gpChatJid = typeof data.chatJid === 'string' ? data.chatJid.trim() : '';
      const remote = typeof data.remote === 'string' ? data.remote.trim() : 'origin';
      const branches = Array.isArray(data.branches) ? data.branches.map(String) : ['main'];
      // Validate branch names (no shell injection)
      const safeBranch = /^[a-zA-Z0-9._\-/]+$/;
      if (!safeBranch.test(remote) || branches.some((b) => !safeBranch.test(b))) {
        if (gpChatJid) await deps.sendMessage(gpChatJid, '⛔ git_push: invalid remote or branch name');
        break;
      }
      try {
        const root = resolveRoot();
        const branchArgs = branches.join(' ');
        const output = execSync(`git push ${remote} ${branchArgs}`, {
          cwd: root,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30000,
        });
        logger.info({ remote, branches }, 'git_push succeeded');
        if (gpChatJid) await deps.sendMessage(gpChatJid, `✅ Pushed ${branches.join(', ')} to ${remote}`);
      } catch (err) {
        logger.error({ err, remote, branches }, 'git_push failed');
        if (gpChatJid) {
          const msg = err instanceof Error ? err.message : String(err);
          await deps.sendMessage(gpChatJid, `⛔ git_push failed: ${msg}`);
        }
      }
      break;
    }

    case 'grant_mount': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized grant_mount attempt blocked');
        break;
      }
      const gmChatJid = typeof data.chatJid === 'string' ? data.chatJid.trim() : '';
      const gmSender = typeof data.sender === 'string' ? data.sender.trim() : '';
      if (CAPTAIN_USER_ID && gmSender !== CAPTAIN_USER_ID) {
        logger.warn({ sender: gmSender }, 'grant_mount blocked: sender is not the Captain');
        if (gmChatJid) await deps.sendMessage(gmChatJid, '⛔ grant_mount: unauthorized sender');
        break;
      }
      const gmPath = typeof data.hostPath === 'string' ? data.hostPath.trim() : '';
      const gmRw = data.allowReadWrite === true;
      const gmDuration = typeof data.durationMinutes === 'number' && data.durationMinutes > 0
        ? Math.min(data.durationMinutes, 480) // cap at 8 hours
        : 30;
      if (!gmPath) {
        if (gmChatJid) await deps.sendMessage(gmChatJid, '⛔ grant_mount: hostPath required');
        break;
      }
      try {
        grantTemporaryMount(gmPath, gmRw, gmDuration, typeof data.description === 'string' ? data.description : undefined);
        const expiry = new Date(Date.now() + gmDuration * 60 * 1000).toLocaleTimeString();
        if (gmChatJid) await deps.sendMessage(gmChatJid, `✅ Mount granted: \`${gmPath}\` (${gmRw ? 'read-write' : 'read-only'}, expires ~${expiry})`);
      } catch (err) {
        logger.error({ err, gmPath }, 'grant_mount failed');
        if (gmChatJid) await deps.sendMessage(gmChatJid, `⛔ grant_mount failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case 'revoke_mount': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized revoke_mount attempt blocked');
        break;
      }
      const rmChatJid = typeof data.chatJid === 'string' ? data.chatJid.trim() : '';
      const rmSender = typeof data.sender === 'string' ? data.sender.trim() : '';
      if (CAPTAIN_USER_ID && rmSender !== CAPTAIN_USER_ID) {
        logger.warn({ sender: rmSender }, 'revoke_mount blocked: sender is not the Captain');
        break;
      }
      const rmPath = typeof data.hostPath === 'string' ? data.hostPath.trim() : '';
      if (!rmPath) {
        if (rmChatJid) await deps.sendMessage(rmChatJid, '⛔ revoke_mount: hostPath required');
        break;
      }
      const revoked = revokeMount(rmPath);
      if (rmChatJid) await deps.sendMessage(rmChatJid, revoked ? `✅ Mount revoked: \`${rmPath}\`` : `ℹ️ No mount found for \`${rmPath}\``);
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
