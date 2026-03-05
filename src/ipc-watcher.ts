/**
 * InfiniClaw IPC watcher.
 * Polls per-group IPC directories for message and task files.
 * Uses upstream's processTaskIpc for base task types, adds InfiniClaw
 * message types (image, file), delegate threading, and extended commands.
 */
import fs from 'fs';
import path from 'path';

import { processTaskIpc } from 'nanoclaw/ipc.js';
import type { AvailableGroup } from 'nanoclaw/container-runner.js';
import { DATA_DIR, IPC_POLL_INTERVAL } from 'nanoclaw/config.js';
import {
  handleInfiniClawCommand,
  handleInfiniClawMessage,
} from './ipc-commands.js';
import { sendViaIntercom } from './intercom-relay.js';
import { logger } from 'nanoclaw/logger.js';
import type { RegisteredGroup } from 'nanoclaw/types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string, threadId?: string) => Promise<void>;
  sendMessageReturningId: (jid: string, text: string, threadId?: string) => Promise<string | undefined>;
  sendImage: (jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string) => Promise<void>;
  sendFile: (jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string) => Promise<void>;
  defaultSenderForGroup: (sourceGroup: string) => string;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  unregisterGroup: (jid: string) => void;
  setWorkThread: (chatJid: string, threadId: string | null) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  writeLastEventId: (sourceGroup: string, eventId: string) => void;
}

let ipcWatcherRunning = false;

// Per-group delegate thread IDs — created on first delegate message, cleared when set_thread(null) fires
const delegateThreadIds: Record<string, string> = {};
const MAX_IPC_MESSAGE_JSON_BYTES = 14 * 1024 * 1024; // Allows up to 10MB base64 payloads plus metadata.
const MAX_IPC_TASK_JSON_BYTES = 64 * 1024;

function clearDelegateThread(sourceGroup: string): void {
  if (sourceGroup in delegateThreadIds) {
    delete delegateThreadIds[sourceGroup];
    logger.debug({ sourceGroup }, 'Delegate thread ID pruned');
  }
}

interface TextMessageData {
  chatJid: string;
  text: string;
  sender?: string;
  threadId?: string;
  crossRoom?: boolean;
  senderName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readValidatedIpcJson(filePath: string, maxBytes: number): Record<string, unknown> {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('IPC payload must be a regular file');
  }
  if (stat.size > maxBytes) {
    throw new Error(`IPC payload exceeds ${maxBytes} bytes`);
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (!isRecord(parsed)) {
    throw new Error('IPC payload must be a JSON object');
  }
  return parsed;
}

async function handleTextMessage(
  data: TextMessageData,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  // Cross-room messages go through intercom relay
  if (data.crossRoom && data.senderName) {
    const text = `${data.senderName}: ${data.text}`;
    const sent = await sendViaIntercom(data.chatJid, text);
    if (sent) {
      logger.info({ chatJid: data.chatJid, senderName: data.senderName, sourceGroup }, 'Cross-room message relayed via intercom');
    } else {
      logger.error({ chatJid: data.chatJid, sourceGroup }, 'Failed to relay cross-room message via intercom');
    }
    return;
  }

  const registeredGroups = deps.registeredGroups();
  const targetGroup = registeredGroups[data.chatJid];
  const authorized = isMain || (targetGroup && targetGroup.folder === sourceGroup);

  if (!authorized) {
    logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC message attempt blocked');
    return;
  }

  const explicitThreadId = typeof data.threadId === 'string' ? data.threadId : undefined;
  const body = String(data.text);
  const isDelegateHeader = body.startsWith('💭');

  const threadId = explicitThreadId ?? delegateThreadIds[sourceGroup];

  if (isDelegateHeader && !explicitThreadId) {
    const eventId = await deps.sendMessageReturningId(data.chatJid, body, undefined);
    if (eventId) {
      delegateThreadIds[sourceGroup] = eventId;
      deps.writeLastEventId(sourceGroup, eventId);
      logger.info({ sourceGroup, eventId }, 'Delegate thread created');
    }
  } else {
    const eventId = await deps.sendMessageReturningId(data.chatJid, body, threadId);
    if (eventId) deps.writeLastEventId(sourceGroup, eventId);
  }
  logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC message sent');
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
    try { await processIpcFilesInner(); } catch (err) {
      logger.error({ err }, 'IPC watcher unexpected error — recovering');
    }
    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  const processIpcFilesInner = async () => {
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      return;
    }

    const registeredGroups = deps.registeredGroups();
    const registeredFolders = new Set(Object.values(registeredGroups).map((g) => g.folder));

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      // Ignore unknown source folders once registration is initialized.
      if (registeredFolders.size > 0 && !registeredFolders.has(sourceGroup)) {
        logger.warn({ sourceGroup }, 'Skipping IPC for unregistered source group');
        continue;
      }
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => entry.name);
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            const processingPath = `${filePath}.processing`;
            const errorPath = `${filePath}.error`;
            try {
              fs.renameSync(filePath, processingPath);
              const data = readValidatedIpcJson(processingPath, MAX_IPC_MESSAGE_JSON_BYTES);
              const type = typeof data.type === 'string' ? data.type : '';

              if (type === 'message' && typeof data.chatJid === 'string' && typeof data.text === 'string') {
                await handleTextMessage(
                  {
                    chatJid: data.chatJid,
                    text: data.text,
                    sender: data.sender as string | undefined,
                    threadId: data.threadId as string | undefined,
                    crossRoom: data.crossRoom as boolean | undefined,
                    senderName: data.senderName as string | undefined,
                  },
                  sourceGroup,
                  isMain,
                  deps,
                );
              } else {
                // Extended message types (image, file)
                const targetGroup = registeredGroups[data.chatJid as string];
                const authorized = isMain || !!(targetGroup && targetGroup.folder === sourceGroup);
                await handleInfiniClawMessage(data as Parameters<typeof handleInfiniClawMessage>[0], {
                  authorized,
                  sourceGroup,
                  sendImage: deps.sendImage,
                  sendFile: deps.sendFile,
                });
              }
              fs.unlinkSync(processingPath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
              try { fs.renameSync(processingPath, errorPath); } catch { /* already gone or couldn't move */ }
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC messages directory');
      }

      // Process tasks
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => entry.name);
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            const processingPath = `${filePath}.processing`;
            const errorPath = `${filePath}.error`;
            try {
              fs.renameSync(filePath, processingPath);
              const data = readValidatedIpcJson(processingPath, MAX_IPC_TASK_JSON_BYTES);
              if (typeof data.type !== 'string') {
                throw new Error('IPC task missing string type');
              }
              const taskData = data as Parameters<typeof processTaskIpc>[0];

              // Try base task types first (schedule, pause, resume, cancel, refresh, register)
              const baseTypes = ['schedule_task', 'pause_task', 'resume_task', 'cancel_task', 'refresh_groups', 'register_group'];
              if (baseTypes.includes(taskData.type)) {
                await processTaskIpc(taskData, sourceGroup, isMain, {
                  sendMessage: (jid: string, text: string) => deps.sendMessage(jid, text),
                  registeredGroups: deps.registeredGroups,
                  registerGroup: (jid: string, group: RegisteredGroup) => {
                    // InfiniClaw extension: replace existing group with same folder
                    const groups = deps.registeredGroups();
                    const existing = Object.entries(groups)
                      .find(([existingJid, g]) => g.folder === taskData.folder && existingJid !== taskData.jid);
                    if (existing) {
                      deps.unregisterGroup(existing[0]);
                      logger.info({ oldJid: existing[0], newJid: taskData.jid, folder: taskData.folder }, 'Replaced existing group with same folder');
                    }
                    deps.registerGroup(jid, group);
                  },
                  syncGroups: deps.syncGroups,
                  getAvailableGroups: deps.getAvailableGroups,
                  writeGroupsSnapshot: deps.writeGroupsSnapshot,
                });
              } else {
                // Delegate to InfiniClaw extended command handlers
                const extHandled = await handleInfiniClawCommand(data as Parameters<typeof handleInfiniClawCommand>[0], {
                  isMain,
                  sourceGroup,
                  sendMessage: deps.sendMessage,
                  registeredGroups: deps.registeredGroups,
                  setWorkThread: deps.setWorkThread,
                  clearDelegateThread,
                });
                if (!extHandled) {
                  logger.warn({ type: taskData.type }, 'Unknown IPC task type');
                }
              }
              fs.unlinkSync(processingPath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC task');
              try { fs.renameSync(processingPath, errorPath); } catch { /* already gone or couldn't move */ }
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}
