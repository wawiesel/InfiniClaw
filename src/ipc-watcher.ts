/**
 * InfiniClaw IPC watcher.
 * Uses upstream's composable createIpcPoller and processBaseTaskIpc,
 * adding InfiniClaw message types (image, file), delegate threading,
 * and commands (set_brain_mode, restart_bot, etc.) via handlers.
 */
import {
  createIpcPoller,
  processBaseTaskIpc,
} from 'nanoclaw/ipc.js';
import type { AvailableGroup } from 'nanoclaw/container-runner.js';
import {
  handleInfiniClawCommand,
  handleInfiniClawMessage,
} from './ipc-commands.js';
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
  syncGroupMetadata: (force: boolean) => Promise<void>;
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
}

async function handleTextMessage(
  data: TextMessageData,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();
  const targetGroup = registeredGroups[data.chatJid];
  // Allow if: main group, own registered group, or cross-bot message (any Matrix JID)
  // Cross-bot messages are validated by the MCP server before reaching here
  const isCrossBotTarget = data.chatJid.startsWith('matrix:');
  const authorized = isMain || (targetGroup && targetGroup.folder === sourceGroup) || isCrossBotTarget;

  if (!authorized) {
    logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC message attempt blocked');
    return;
  }

  const sender = typeof data.sender === 'string' && data.sender.trim()
    ? data.sender.trim()
    : deps.defaultSenderForGroup(sourceGroup);
  const explicitThreadId = typeof data.threadId === 'string' ? data.threadId : undefined;
  const body = String(data.text);
  const isDelegateHeader = body.startsWith('💭');

  // Auto-thread delegate output: create a new thread on the first delegate
  // message (the lobe header), then route all subsequent messages into it.
  const threadId = explicitThreadId ?? delegateThreadIds[sourceGroup];

  if (isDelegateHeader && !explicitThreadId) {
    // Start a new delegate thread rooted at this header message
    const eventId = await deps.sendMessageReturningId(data.chatJid, body, undefined);
    if (eventId) {
      delegateThreadIds[sourceGroup] = eventId;
      deps.writeLastEventId(sourceGroup, eventId);
      logger.info({ sourceGroup, eventId }, 'Delegate thread created');
    }
  } else {
    await deps.sendMessage(data.chatJid, body, threadId);
  }
  logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC message sent');
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  createIpcPoller({
    onMessage: async (_filePath, data, sourceGroup, isMain) => {
      if (data.type === 'message' && data.chatJid && data.text) {
        await handleTextMessage(
          {
            chatJid: data.chatJid as string,
            text: data.text as string,
            sender: data.sender as string | undefined,
            threadId: data.threadId as string | undefined,
          },
          sourceGroup,
          isMain,
          deps,
        );
      } else {
        // Handle extended message types (image, file)
        const registeredGroups = deps.registeredGroups();
        const targetGroup = registeredGroups[data.chatJid as string];
        const authorized = isMain || !!(targetGroup && targetGroup.folder === sourceGroup);
        await handleInfiniClawMessage(data as Parameters<typeof handleInfiniClawMessage>[0], {
          authorized,
          sourceGroup,
          sendImage: deps.sendImage,
          sendFile: deps.sendFile,
        });
      }
    },

    onTask: async (_filePath, data, sourceGroup, isMain) => {
      // Try base task types first (schedule, pause, resume, cancel, refresh, register)
      const handled = await processBaseTaskIpc(data, sourceGroup, isMain, {
        registeredGroups: deps.registeredGroups,
        registerGroup: (jid, group) => {
          // InfiniClaw extension: replace existing group with same folder
          const registeredGroups = deps.registeredGroups();
          const existing = Object.entries(registeredGroups)
            .find(([existingJid, g]) => g.folder === data.folder && existingJid !== data.jid);
          if (existing) {
            deps.unregisterGroup(existing[0]);
            logger.info({ oldJid: existing[0], newJid: data.jid, folder: data.folder }, 'Replaced existing group with same folder');
          }
          deps.registerGroup(jid, group);
        },
        syncGroupMetadata: deps.syncGroupMetadata,
        getAvailableGroups: deps.getAvailableGroups,
        writeGroupsSnapshot: deps.writeGroupsSnapshot,
      });

      if (handled) return;

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
        logger.warn({ type: data.type }, 'Unknown IPC task type');
      }
    },
  });
}
