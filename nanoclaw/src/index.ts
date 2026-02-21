import fs from 'fs';
import path from 'path';

import { parseEnvLine } from './env-utils.js';

import {
  ASSISTANT_NAME,
  ASSISTANT_ROLE,
  ASSISTANT_TRIGGER,
  DATA_DIR,
  HEAP_LIMIT_MB,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  MATRIX_ACCESS_TOKEN,
  MATRIX_HOMESERVER,
  MATRIX_PASSWORD,
  MATRIX_RECONNECT_INTERVAL,
  MATRIX_USERNAME,
  LOCAL_CHANNEL_ENABLED,
  LOCAL_MIRROR_MATRIX_JID,
  MEMORY_CHECK_INTERVAL,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
  CAPTAIN_USER_ID,
} from './config.js';
import { grantTemporaryMount, revokeMount } from './mount-security.js';
import { MatrixChannel } from './channels/matrix.js';
import { LocalCliChannel } from './channels/local-cli.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  deleteSession,
  getMessagesSince,
  getNewMessages,
  getRecentMessages,
  getRouterState,
  initDatabase,
  deleteRegisteredGroup,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { readBrainMode } from './ipc.js';
import { findChannel, formatMessages, stripInternalTags } from './router.js';
import { syncPersona } from './service.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// [InfiniClaw] extracted modules
import {
  MAIN_PROVIDER,
  mainLlm,
  mainSender,
  defaultSenderForGroup,
  resolveConfiguredMainModel,
  normalizeMainLlm,
  updateMainLlm,
  setMainLlm,
  maybeAutoSwitchBrainsOnQuotaError,
} from './infiniclaw/brain-management.js';
import {
  ensureChatActivity,
  getChatActivity,
  setObjectiveFromMessages,
  markRunStarted,
  markRunEnded,
  markProgress,
  markCompletion,
  markError,
  buildMainMissionContext,
} from './infiniclaw/chat-activity.js';
import { shouldIgnoreMessage } from './infiniclaw/message-filtering.js';
import { appendConversationLog } from './infiniclaw/conversation-log.js';
import { ensureContainerSystemRunning } from './infiniclaw/podman-bootstrap.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
const QUEUED_ACK_COOLDOWN_MS = 30_000;
const lastQueuedAckAt: Record<string, number> = {};
const ACTIVE_PIPE_ACK_COOLDOWN_MS = 5_000;
const lastActivePipeAckAt: Record<string, number> = {};
const PROGRESS_CHAT_COOLDOWN_MS = 10_000;
const lastProgressChatAt: Record<string, number> = {};
const PIP_PULSE = ['🔵', '🔷', '🔹', '🔷'] as const;
const pipPulseIndex: Record<string, number> = {};
// Per-group work thread IDs — set by container via IPC, used by processGroupMessages
const workThreadIds: Record<string, string> = {};
// Per-group reply thread — tracks the thread for the active run's replies.
// Updated both at run start and when messages are piped to an active container.
const activeReplyThreadIds: Record<string, string | undefined> = {};
// Per-group working indicator: a single "⏳ working..." message edited with elapsed time.
interface WorkingIndicator {
  eventId: string;
  startedAt: number;
  timer: ReturnType<typeof setInterval>;
  chatJid: string;
}
const workingIndicators: Record<string, WorkingIndicator> = {};

function startWorkingIndicator(chatJid: string, threadId?: string): void {
  // Don't stack indicators
  if (workingIndicators[chatJid]) return;
  const ch = findChannel(channels, chatJid);
  if (!ch?.sendMessageReturningId || !ch?.editMessage) return;
  const startedAt = Date.now();
  ch.sendMessageReturningId(chatJid, '⏳ working...', threadId).then((eventId) => {
    if (!eventId) return;
    // Check we weren't already cleared while awaiting
    if (workingIndicators[chatJid]) {
      // Already started by another path — redact the duplicate
      if (ch.redactMessage) ch.redactMessage(chatJid, eventId).catch(() => {});
      return;
    }
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 60_000);
      const label = elapsed < 1 ? '<1m' : `${elapsed}m`;
      ch.editMessage!(chatJid, eventId, `⏳ working (${label})...`).catch(() => {});
    }, 30_000);
    workingIndicators[chatJid] = { eventId, startedAt, timer, chatJid };
  }).catch(() => {});
}

function clearWorkingIndicator(chatJid: string): void {
  const indicator = workingIndicators[chatJid];
  if (!indicator) return;
  clearInterval(indicator.timer);
  delete workingIndicators[chatJid];
  // Stamp final elapsed time as a checkpoint instead of deleting
  const ch = findChannel(channels, chatJid);
  const elapsed = Math.floor((Date.now() - indicator.startedAt) / 60_000);
  const label = elapsed < 1 ? '<1m' : `${elapsed}m`;
  if (ch?.editMessage) {
    ch.editMessage(chatJid, indicator.eventId, `⏳ checkpoint (${label})`).catch(() => {});
  }
}

/** Stamp old indicator as checkpoint and send a new one below any new messages. */
function bumpWorkingIndicator(chatJid: string, threadId?: string): void {
  const indicator = workingIndicators[chatJid];
  if (!indicator) return;
  const ch = findChannel(channels, chatJid);
  if (!ch?.sendMessageReturningId || !ch?.editMessage) return;
  const { startedAt } = indicator;
  // Stamp old message as checkpoint
  clearInterval(indicator.timer);
  const elapsed = Math.floor((Date.now() - startedAt) / 60_000);
  const checkpointLabel = elapsed < 1 ? '<1m' : `${elapsed}m`;
  ch.editMessage(chatJid, indicator.eventId, `⏳ checkpoint (${checkpointLabel})`).catch(() => {});
  delete workingIndicators[chatJid];
  // Send new working indicator at the bottom
  const label = checkpointLabel;
  ch.sendMessageReturningId(chatJid, `⏳ working (${label})...`, threadId).then((eventId) => {
    if (!eventId) return;
    if (workingIndicators[chatJid]) {
      // Already started by another path — stamp this one too
      if (ch.editMessage) ch.editMessage(chatJid, eventId, `⏳ checkpoint (${label})`).catch(() => {});
      return;
    }
    const timer = setInterval(() => {
      const el = Math.floor((Date.now() - startedAt) / 60_000);
      const lb = el < 1 ? '<1m' : `${el}m`;
      ch.editMessage!(chatJid, eventId, `⏳ working (${lb})...`).catch(() => {});
    }, 30_000);
    workingIndicators[chatJid] = { eventId, startedAt, timer, chatJid };
  }).catch(() => {});
}

const RUN_PROGRESS_NUDGE_STALE_MS = 90_000;
const RUN_PROGRESS_NUDGE_COOLDOWN_MS = 120_000;
const RUN_PROGRESS_NUDGE_CHECK_MS = 15_000;

function ensureGroupForIncomingChat(chatJid: string): void {
  // Only log metadata for known groups — no auto-registration
  if (!registeredGroups[chatJid]) {
    logger.debug({ chatJid }, 'Ignored message from unregistered chat');
  }
}

function getMainChatJid(): string | undefined {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === MAIN_GROUP_FOLDER) return jid;
  }
  return undefined;
}

function formatMainMessage(body: string): string {
  return body.trim();
}

let outgoingSeq = 0;

/** Store an outgoing bot message in the DB for monitoring/audit. */
function storeOutgoing(chatJid: string, text: string, threadId?: string): void {
  const id = `out-${Date.now()}-${++outgoingSeq}`;
  storeMessage({
    id,
    chat_jid: chatJid,
    sender: ASSISTANT_NAME,
    sender_name: ASSISTANT_NAME,
    content: text,
    timestamp: new Date().toISOString(),
    is_from_me: true,
    thread_id: threadId,
  });
}

/**
 * Sync group .md files + skills back to personas/ directory for version control.
 * Delegates to service.syncPersona which is the single source of truth.
 */
function syncPersonas(): void {
  const rootDir = process.env.INFINICLAW_ROOT;
  const personaName = process.env.PERSONA_NAME;
  if (!rootDir || !personaName) return;

  try {
    syncPersona(rootDir, personaName);
    logger.info({ personaName }, 'Synced group memory and skills to personas/');
  } catch (err) {
    logger.warn({ err, personaName }, 'Failed to sync personas on shutdown');
  }
}

let channels: Channel[] = [];
const queue = new GroupQueue();


function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  const configuredMainModel = resolveConfiguredMainModel();
  const storedMainModel = normalizeMainLlm(getRouterState('main_model'));
  if (configuredMainModel) {
    const pinnedChanged =
      storedMainModel && configuredMainModel !== storedMainModel;
    setMainLlm(configuredMainModel);
    setRouterState('main_model', mainLlm);

    // If model pin changed, drop the main session so Claude initializes fresh
    // on the requested model instead of resuming a prior-model session.
    if (pinnedChanged && sessions[MAIN_GROUP_FOLDER]) {
      deleteSession(MAIN_GROUP_FOLDER);
      delete sessions[MAIN_GROUP_FOLDER];
      logger.info(
        {
          fromModel: storedMainModel,
          toModel: configuredMainModel,
        },
        'Pinned MAIN model changed; cleared main session',
      );
    }
  } else if (storedMainModel) {
    setMainLlm(storedMainModel);
  }
  logger.info(
    { groupCount: Object.keys(registeredGroups).length, mainModel: mainLlm },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
  setRouterState('main_model', mainLlm);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

function unregisterGroup(jid: string): void {
  const group = registeredGroups[jid];
  delete registeredGroups[jid];
  deleteRegisteredGroup(jid);
  logger.info({ jid, folder: group?.folder }, 'Group unregistered');
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && (c.jid.startsWith('matrix:') || c.jid.endsWith('@g.us')))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const allMissed = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (allMissed.length === 0) return true;
  const missedMessages = allMissed;

  // Filter out other-bot noise; everything else gets processed
  const filteredMessages = missedMessages.filter((msg) => !shouldIgnoreMessage(msg));
  if (filteredMessages.length === 0) return true;

  // Trigger gating: non-main groups with requiresTrigger skip messages without the trigger
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = filteredMessages.some((m) => TRIGGER_PATTERN.test(m.content.trim()));
    if (!hasTrigger) {
      // Advance cursor past these messages without processing
      lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
      saveState();
      return true;
    }
  }

  setObjectiveFromMessages(chatJid, filteredMessages);

  // Thread routing: prefer incoming message thread, fall back to work thread set by container.
  // Uses activeReplyThreadIds map so piped messages can update thread mid-run.
  const lastMsg = filteredMessages[filteredMessages.length - 1];
  activeReplyThreadIds[chatJid] = lastMsg?.thread_id || workThreadIds[chatJid];
  logger.info(
    { group: group.name, replyThreadId: activeReplyThreadIds[chatJid], lastMsgThreadId: lastMsg?.thread_id, workThread: workThreadIds[chatJid], msgCount: filteredMessages.length },
    'Thread routing resolved',
  );

  const basePrompt = formatMessages(filteredMessages);
  const missionContext =
    isMainGroup ? buildMainMissionContext(chatJid) : undefined;
  const parts: string[] = [];
  if (missionContext) parts.push(missionContext);
  parts.push(basePrompt);
  const prompt = parts.join('\n\n');

  // Advance cursor past ALL messages (including ignored) so we don't reprocess
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: filteredMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  const channel = findChannel(channels, chatJid);
  if (channel?.setPresenceStatus) await channel.setPresenceStatus('online', 'processing...');
  startWorkingIndicator(chatJid, activeReplyThreadIds[chatJid]);
  // Track inbound message IDs for acknowledgement reaction once bot produces output
  const inboundMessageIds = filteredMessages.map((m) => m.id).filter(Boolean);
  let acknowledged = false;
  let hadError = false;
  let outputSentToUser = false;
  const agentResponses: string[] = [];
  let lastResponseBody: string | undefined;
  let lastSentResultText = '';
  let consecutiveDupSent = 0;
  let lastRunOutputAt = Date.now();
  let lastRunProgressNudgeAt = 0;
  let runProgressNudgeTimer: ReturnType<typeof setInterval> | null = null;

  markRunStarted(chatJid);

  // Set working pip on bot's last message
  if (channel?.setStatusPip) {
    pipPulseIndex[chatJid] = 0;
    void channel.setStatusPip(chatJid, PIP_PULSE[0]).catch(() => {});
  }

  if (isMainGroup) {
    runProgressNudgeTimer = setInterval(() => {
      const now = Date.now();
      if (now - lastRunOutputAt < RUN_PROGRESS_NUDGE_STALE_MS) return;
      if (now - lastRunProgressNudgeAt < RUN_PROGRESS_NUDGE_COOLDOWN_MS) return;
      // Don't nudge if the agent already reported done/idle
      const activity = ensureChatActivity(chatJid);
      if (activity.lastCompletion && /\b(idle|done)\b/i.test(activity.lastCompletion)) return;
      const nudged = queue.sendMessage(
        chatJid,
        'If you are still running, send a concise progress update now: done, in-progress, next.',
      );
      if (nudged) {
        lastRunProgressNudgeAt = now;
        logger.info({ chatJid }, 'Sent automatic run-progress nudge');
      }
    }, RUN_PROGRESS_NUDGE_CHECK_MS);
  }

  const runResult = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (group.folder === MAIN_GROUP_FOLDER && result.model) {
      updateMainLlm(result.model);
    }
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      if (text) {
        // Acknowledge inbound messages with 🔹 on first bot output (proves bot saw them)
        if (!acknowledged && inboundMessageIds.length > 0) {
          acknowledged = true;
          const ch = findChannel(channels, chatJid);
          if (ch?.sendReaction) {
            for (const msgId of inboundMessageIds) {
              void ch.sendReaction(chatJid, msgId, '🔹').catch(() => {});
            }
          }
        }
        lastRunOutputAt = Date.now();
        if (result.isProgress) {
          markProgress(chatJid, text);
          // Forward progress to chat; rate-limit plain text but always show tool calls
          const isToolCall = text.includes('<details>');
          const now = Date.now();
          if (isToolCall || !lastProgressChatAt[chatJid] || now - lastProgressChatAt[chatJid] >= PROGRESS_CHAT_COOLDOWN_MS) {
            if (!isToolCall) lastProgressChatAt[chatJid] = now;
            const ch = findChannel(channels, chatJid);
            if (ch) {
              // Tool calls have <details> formatting from agent-runner;
              // plain thinking text gets dimmed small italic
              const formatted = isToolCall
                ? text
                : `<small><em>${text}</em></small>`;
              void ch.sendMessage(chatJid, formatted, activeReplyThreadIds[chatJid]).then(() => {
                bumpWorkingIndicator(chatJid, activeReplyThreadIds[chatJid]);
              }).catch((err) => {
                logger.warn({ chatJid, err }, 'Failed to send progress to chat');
              });
            }
          }
        } else {
          // Final result: deliver to chat (with dedup for stuck agents)
          const dedupKey = text.replace(/\s+/g, ' ').trim();
          if (dedupKey === lastSentResultText) {
            consecutiveDupSent++;
          } else {
            consecutiveDupSent = 0;
            lastSentResultText = dedupKey;
          }
          if (consecutiveDupSent >= 2) {
            logger.warn({ group: group.name, dupCount: consecutiveDupSent }, 'Suppressed duplicate result to chat');
          } else {
            markProgress(chatJid, text);
            lastResponseBody = text;
            const ch = findChannel(channels, chatJid);
            if (ch) {
              clearWorkingIndicator(chatJid);
              if (ch.setTyping) await ch.setTyping(chatJid, true);
              await ch.sendMessage(chatJid, formatMainMessage(text), activeReplyThreadIds[chatJid]);
              if (ch.setTyping) await ch.setTyping(chatJid, false);
              storeOutgoing(chatJid, formatMainMessage(text), activeReplyThreadIds[chatJid]);
            }
            outputSentToUser = true;
            agentResponses.push(formatMainMessage(text));
          }
        }
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
      if (result.error) {
        markError(chatJid, result.error);
      }
    }
  });

  clearWorkingIndicator(chatJid);
  if (channel?.setTyping) await channel.setTyping(chatJid, false);
  if (channel?.setPresenceStatus) await channel.setPresenceStatus('online', 'idle');
  // Set idle pip on bot's last message
  if (channel?.setStatusPip) {
    void channel.setStatusPip(chatJid, '🟢').catch(() => {});
  }
  if (idleTimer) clearTimeout(idleTimer);
  if (runProgressNudgeTimer) clearInterval(runProgressNudgeTimer);

  if (runResult.status === 'error' || hadError) {
    const rawError =
      runResult.error ||
      (hadError ? 'agent returned an error status' : 'unknown error');
    await maybeAutoSwitchBrainsOnQuotaError(rawError, chatJid, async (jid, text) => {
      const ch = findChannel(channels, jid);
      if (ch) await ch.sendMessage(jid, text);
    });
    const compactError = rawError.replace(/\s+/g, ' ').slice(0, 1000);
    markError(chatJid, compactError);

    if (!outputSentToUser && channel) {
      const errorReply =
        formatMainMessage(
          `I hit an error while processing that request: ${compactError}`,
        );
      try {
        await channel.sendMessage(chatJid, errorReply, activeReplyThreadIds[chatJid]);
        storeOutgoing(chatJid, errorReply, activeReplyThreadIds[chatJid]);
        outputSentToUser = true;
        agentResponses.push(errorReply);
      } catch (sendErr) {
        logger.warn(
          { group: group.name, err: sendErr },
          'Failed to send error reply to channel',
        );
      }
    }

    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      appendConversationLog(group.folder, missedMessages, agentResponses, channel?.name);
      delete activeReplyThreadIds[chatJid];
      markRunEnded(chatJid);
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    delete activeReplyThreadIds[chatJid];
    markRunEnded(chatJid);
    return false;
  }

  if (lastResponseBody) {
    markCompletion(chatJid, lastResponseBody);
  }
  delete activeReplyThreadIds[chatJid];
  markRunEnded(chatJid);

  appendConversationLog(group.folder, missedMessages, agentResponses, channel?.name);
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<{ status: 'success' | 'error'; error?: string }> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionKey = group.folder;
  const sessionId = sessions[sessionKey];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[sessionKey] = output.newSessionId;
          setSession(sessionKey, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[sessionKey] = output.newSessionId;
      setSession(sessionKey, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return {
        status: 'error',
        error: output.error || 'container agent error',
      };
    }

    return { status: 'success' };
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

          // Filter out other-bot noise; everything else gets processed
          const filtered = groupMessages.filter((msg) => !shouldIgnoreMessage(msg));
          if (filtered.length === 0) continue;

          // Trigger gating: non-main groups with requiresTrigger skip messages without the trigger
          if (!isMainGroup && group.requiresTrigger !== false) {
            const hasTrigger = filtered.some((m) => TRIGGER_PATTERN.test(m.content.trim()));
            if (!hasTrigger) {
              lastAgentTimestamp[chatJid] = groupMessages[groupMessages.length - 1].timestamp;
              saveState();
              continue;
            }
          }

          // Pull all messages since lastAgentTimestamp so context is included
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          ).filter((msg) => !shouldIgnoreMessage(msg));
          const messagesToSend =
            allPending.length > 0 ? allPending : filtered;

          setObjectiveFromMessages(chatJid, messagesToSend);
          const formatted = formatMessages(messagesToSend);

          // Update reply thread from piped messages so responses go to the right thread.
          // Always update (even to undefined) so a main-timeline message clears a stale thread.
          const lastPiped = messagesToSend[messagesToSend.length - 1];
          activeReplyThreadIds[chatJid] = lastPiped?.thread_id || workThreadIds[chatJid];

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            startWorkingIndicator(chatJid, activeReplyThreadIds[chatJid]);
            const now = Date.now();
            if (
              !lastActivePipeAckAt[chatJid] ||
              now - lastActivePipeAckAt[chatJid] >= ACTIVE_PIPE_ACK_COOLDOWN_MS
            ) {
              // Acknowledgement reaction (🔹) is placed when the bot first produces output
              lastActivePipeAckAt[chatJid] = now;
            }
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing/presence indicator while the container processes the piped message
            const ch = findChannel(channels, chatJid);
            if (ch?.setTyping) await ch.setTyping(chatJid, true);
            if (ch?.setPresenceStatus) await ch.setPresenceStatus('online', 'processing...');
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
            const now = Date.now();
            if (
              !lastQueuedAckAt[chatJid] ||
              now - lastQueuedAckAt[chatJid] >= QUEUED_ACK_COOLDOWN_MS
            ) {
              lastQueuedAckAt[chatJid] = now;
            }
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

/**
 * After any restart, inject a synthetic message into every registered group
 * so the agent re-enters the conversation instead of sitting idle.
 */
function injectResumeMessage(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    // Include recent conversation history so the bot has context
    const recent = getRecentMessages(chatJid, ASSISTANT_NAME, 10).reverse();
    let contextBlock = '';
    if (recent.length > 0) {
      const lines = recent.map((m) => `[${m.sender_name}]: ${m.content.slice(0, 300)}`);
      contextBlock = `\n\nHere are the last ${recent.length} messages before restart:\n${lines.join('\n')}`;
    }

    storeMessage({
      id: `resume-${Date.now()}-${group.folder}`,
      chat_jid: chatJid,
      chat_name: group.name,
      sender: 'system',
      sender_name: 'System',
      content: `You were restarted. Review the conversation below and your memory, then resume any in-progress work. If nothing was in progress, say so briefly and wait.${contextBlock}`,
      timestamp: new Date().toISOString(),
    });
    queue.enqueueMessageCheck(chatJid);
    logger.info({ chatJid, group: group.name, recentCount: recent.length }, 'Injected resume message with context');
  }
}

async function main(): Promise<void> {
  // Load supplemental env from .env.local (for vars not in launchd plist)
  const envLocalPath = path.join(process.cwd(), '.env.local');
  if (fs.existsSync(envLocalPath)) {
    for (const line of fs.readFileSync(envLocalPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
  // Ensure common tool paths are available (launchd provides minimal PATH)
  for (const p of ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']) {
    if (!(process.env.PATH || '').includes(p)) {
      process.env.PATH = `${p}:${process.env.PATH || ''}`;
    }
  }
  await ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    // Set shutdown pip on all registered groups
    for (const [jid] of Object.entries(registeredGroups)) {
      const ch = findChannel(channels, jid);
      if (ch?.setStatusPip) {
        try { await ch.setStatusPip(jid, '🔴'); } catch { /* best-effort */ }
      }
    }
    for (const ch of channels) {
      if (ch.setPresenceStatus) await ch.setPresenceStatus('offline', 'shutting down...');
    }
    syncPersonas();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Create Matrix channel (activates only if configured)
  let matrix: MatrixChannel | null = null;
  if (
    MATRIX_HOMESERVER &&
    (MATRIX_ACCESS_TOKEN || (MATRIX_USERNAME && MATRIX_PASSWORD))
  ) {
    matrix = new MatrixChannel({
      onMessage: (_chatJid, msg) => {
        if (handleMountCommand(msg)) return;
        ensureGroupForIncomingChat(msg.chat_jid);
        storeMessage(msg);
      },
      onChatMetadata: (chatJid, timestamp, name) => {
        ensureGroupForIncomingChat(chatJid);
        storeChatMetadata(chatJid, timestamp, name);
      },
      registeredGroups: () => registeredGroups,
    });
  }

  let localCli: LocalCliChannel | null = null;
  if (LOCAL_CHANNEL_ENABLED) {
    localCli = new LocalCliChannel({
      onMessage: (_chatJid, msg) => {
        if (handleMountCommand(msg)) return;
        ensureGroupForIncomingChat(msg.chat_jid);
        storeMessage(msg);
      },
      onChatMetadata: (chatJid, timestamp, name) =>
        storeChatMetadata(chatJid, timestamp, name),
      mirrorToMatrix: LOCAL_MIRROR_MATRIX_JID
        ? async (text: string) => {
            if (!matrix || !matrix.isConnected()) return;
            await matrix.sendMessage(LOCAL_MIRROR_MATRIX_JID, text);
          }
        : undefined,
    });
  }

  function getCaptainUserId(): string {
    // Re-read from profile env file each time so it picks up changes without restart
    const profileEnvPath = path.join(process.env.INFINICLAW_ROOT || path.resolve(process.cwd(), '..', '..', '..'), 'bots', 'profiles', 'engineer', 'env');
    if (fs.existsSync(profileEnvPath)) {
      for (const line of fs.readFileSync(profileEnvPath, 'utf-8').split('\n')) {
        const parsed = parseEnvLine(line);
        if (parsed?.[0] === 'CAPTAIN_USER_ID') return parsed[1].trim();
      }
    }
    return CAPTAIN_USER_ID; // fallback to module-level value
  }

  function handleMountCommand(msg: { sender: string; content: string; chat_jid: string }): boolean {
    const captainUserId = getCaptainUserId();
    if (!msg.content.startsWith('!grant-mount') && !msg.content.startsWith('!revoke-mount') && !msg.content.startsWith('!restart-wksm')) return false;
    logger.info({ sender: msg.sender, captainUserId, content: msg.content.slice(0, 50) }, 'handleMountCommand');
    if (!captainUserId || msg.sender !== captainUserId) {
      void (async () => {
        if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, `⛔ Unauthorized: only the Captain can run mount commands.`);
      })();
      return true; // consume the message regardless
    }
    const grant = msg.content.match(/^!grant-mount\s+(\S+)(?:\s+(\d+))?/);
    if (grant) {
      const [, hostPath, mins] = grant;
      const duration = parseInt(mins ?? '30', 10);
      logger.info({ hostPath, duration }, 'grant-mount command');
      void (async () => {
        try {
          grantTemporaryMount(hostPath, true, duration, undefined, process.env.PERSONA_NAME);
          const expiry = new Date(Date.now() + duration * 60 * 1000).toLocaleTimeString();
          if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, `✅ Mount granted: ${hostPath} (read-write, expires ~${expiry})\nRestart required to pick up new mount.`);
        } catch (err) {
          if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, `⛔ grant-mount failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      return true;
    }
    const revoke = msg.content.match(/^!revoke-mount\s+(\S+)/);
    if (revoke) {
      const hostPath = revoke[1];
      logger.info({ hostPath }, 'revoke-mount command');
      void (async () => {
        const removed = revokeMount(hostPath);
        if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, removed ? `✅ Mount revoked: ${hostPath}` : `ℹ️ No mount found for: ${hostPath}`);
      })();
      return true;
    }
    if (msg.content.trim() === '!restart-wksm') {
      logger.info('restart-wksm command');
      void (async () => {
        try {
          if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, '🔄 Restarting wksm...');
          const { execSync } = await import('child_process');
          const home = process.env.HOME || '/Users/ww5';
          const wksc = `${home}/2025-WKS/main/venv/bin/wksc`;
          // Kill whatever is on port 8765 using full path to lsof (macOS)
          const killOut = execSync(`/usr/sbin/lsof -ti:8765 | xargs kill -9 2>&1 || echo "no process on 8765"`, { shell: '/bin/bash' }).toString().trim();
          if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, `kill: ${killOut}`);
          await new Promise(r => setTimeout(r, 2000));
          const startOut = execSync(`${wksc} mcp proxy start 2>&1`, { shell: '/bin/bash' }).toString().trim();
          if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, `start: ${startOut}`);
          await new Promise(r => setTimeout(r, 2000));
          const health = execSync('curl -s http://localhost:8765/health', { shell: '/bin/bash' }).toString().trim();
          if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, `health: ${health}`);
        } catch (err) {
          if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, `⛔ restart-wksm failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      return true;
    }
    return false;
  }

  // Build channels array (only include connected channels)
  const allChannels: (Channel | null)[] = [localCli, matrix];
  const refreshConnectedChannels = () => {
    channels = allChannels.filter((ch): ch is Channel => ch != null && ch.isConnected());
  };
  refreshConnectedChannels();

  if (localCli) {
    try {
      await localCli.connect();
    } catch (err) {
      logger.error({ err }, 'Local CLI channel connect failed');
    }
    refreshConnectedChannels();
  }

  // Connect channels
  if (matrix) {
    // Wait for Matrix before starting subsystems (scheduler, message loop).
    // Local CLI is already connected above, so the terminal is responsive.
    try {
      await matrix.connect();
    } catch (err) {
      logger.error({ err }, 'Initial Matrix connection failed; continuing in degraded mode');
    }
    refreshConnectedChannels();

    let matrixReconnectInProgress = false;
    setInterval(async () => {
      if (!matrix || matrixReconnectInProgress) return;
      matrixReconnectInProgress = true;
      try {
        const healthy = await matrix.checkHealth();
        if (!healthy) {
          await matrix.connect();
          if (matrix.isConnected()) {
            logger.info('Matrix reconnected');
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Matrix reconnect attempt failed');
      } finally {
        refreshConnectedChannels();
        matrixReconnectInProgress = false;
      }
    }, MATRIX_RECONNECT_INTERVAL);
  }

  // Memory watchdog — gracefully recycle before OOM
  const heapLimitBytes = HEAP_LIMIT_MB * 1024 * 1024;
  const heartbeatPath = path.join(DATA_DIR, 'heartbeat');
  setInterval(() => {
    const usage = process.memoryUsage();
    const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
    const rssMB = Math.round(usage.rss / 1024 / 1024);
    logger.info({ heapMB, rssMB, limitMB: HEAP_LIMIT_MB }, 'Memory');
    // Write heartbeat so external tooling can detect a stuck event loop
    try { fs.writeFileSync(heartbeatPath, String(Date.now())); } catch {}
    if (usage.heapUsed > heapLimitBytes) {
      logger.warn({ heapMB, limitMB: HEAP_LIMIT_MB }, 'Heap limit exceeded, recycling');
      shutdown('HEAP_LIMIT');
    }
  }, MEMORY_CHECK_INTERVAL);
  // Write initial heartbeat
  try { fs.writeFileSync(heartbeatPath, String(Date.now())); } catch {}

  // Periodic status snapshot for containers to read via check_health MCP tool
  const STATUS_SNAPSHOT_INTERVAL = 30_000;
  const writeStatusSnapshot = () => {
    try {
      const snapshot = {
        timestamp: new Date().toISOString(),
        bot: ASSISTANT_NAME,
        role: ASSISTANT_ROLE,
        model: mainLlm,
        provider: MAIN_PROVIDER,
        brainModes: {
          engineer: readBrainMode('engineer'),
          commander: readBrainMode('commander'),
        },
        groups: Object.entries(registeredGroups).map(([jid, g]) => {
          const queueStatus = queue.getGroupStatus(jid);
          const activity = getChatActivity(jid) || {};
          return {
            jid,
            name: g.name,
            folder: g.folder,
            active: queueStatus.active,
            hasProcess: queueStatus.hasProcess,
            containerName: queueStatus.containerName,
            pendingMessages: queueStatus.pendingMessages,
            pendingTasks: queueStatus.pendingTasks,
            currentObjective: activity.currentObjective,
            lastProgress: activity.lastProgress,
            lastProgressAt: activity.lastProgressAt,
            lastError: activity.lastError,
            lastErrorAt: activity.lastErrorAt,
          };
        }),
      };

      for (const [, g] of Object.entries(registeredGroups)) {
        const ipcDir = path.join(DATA_DIR, 'ipc', g.folder);
        if (!fs.existsSync(ipcDir)) continue;
        const statusPath = path.join(ipcDir, 'status.json');
        const tmpPath = `${statusPath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2));
        fs.renameSync(tmpPath, statusPath);
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to write status snapshot');
    }
  };
  writeStatusSnapshot();
  setInterval(writeStatusSnapshot, STATUS_SNAPSHOT_INTERVAL);

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const ch = findChannel(channels, jid);
      if (!ch) return;
      const text = stripInternalTags(rawText);
      if (text) {
        await ch.sendMessage(jid, formatMainMessage(text));
        storeOutgoing(jid, formatMainMessage(text));
      }
    },
  });
  startIpcWatcher({
    sendMessage: async (jid, text, threadId) => {
      const ch = findChannel(channels, jid);
      if (!ch) {
        logger.warn({ jid }, 'No channel found for IPC message');
        return;
      }
      await ch.sendMessage(jid, text, threadId);
      storeOutgoing(jid, text, threadId);
    },
    defaultSenderForGroup: (sourceGroup: string) => defaultSenderForGroup(sourceGroup, registeredGroups),
    sendImage: (jid, buffer, filename, mimetype, caption) => {
      const ch = findChannel(channels, jid);
      if (ch?.sendImage) return ch.sendImage(jid, buffer, filename, mimetype, caption);
      logger.warn({ jid }, 'No channel with image support found for IPC image');
      return Promise.resolve();
    },
    sendFile: (jid, buffer, filename, mimetype, caption) => {
      const ch = findChannel(channels, jid);
      if (ch?.sendFile) return ch.sendFile(jid, buffer, filename, mimetype, caption);
      logger.warn({ jid }, 'No channel with file support found for IPC file');
      return Promise.resolve();
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    unregisterGroup,
    setWorkThread: (chatJid: string, threadId: string | null) => {
      if (threadId) {
        workThreadIds[chatJid] = threadId;
      } else {
        delete workThreadIds[chatJid];
      }
    },
    syncGroupMetadata: async () => {},
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);

  // [InfiniClaw] register group-queue hooks
  queue.setPreCloseHook((_groupJid, inputDir) => {
    // Inject a memory-save prompt before close so the agent can persist learnings.
    // File sorts before _close alphabetically (0 < _).
    const saveFile = path.join(inputDir, '0-memory-save.json');
    const saveMsg = JSON.stringify({
      type: 'message',
      text: '[System] Session ending. If you learned anything important this session, save it to memory now. Be concise — only record genuinely new insights.',
    });
    const tmpSave = `${saveFile}.tmp`;
    fs.writeFileSync(tmpSave, saveMsg);
    fs.renameSync(tmpSave, saveFile);
  });

  queue.setShutdownHook(async () => {
    // Signal active containers to save memory and close via IPC
    const activeContainers: string[] = [];
    for (const jid of queue.getActiveGroupJids()) {
      try { queue.closeStdin(jid); } catch { /* best effort */ }
      const status = queue.getGroupStatus(jid);
      if (status.hasProcess && status.containerName) {
        activeContainers.push(status.containerName);
      }
    }
    // Wait for containers to process memory-save prompt before shutdown
    if (activeContainers.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
    logger.info({ signaled: activeContainers }, 'InfiniClaw shutdown: containers signaled');
  });

  recoverPendingMessages();
  injectResumeMessage();
  startMessageLoop();

  // Periodic memory-save reminder: every 10 minutes, nudge active bots to save state.
  // This ensures bots have recent memory even after an unexpected crash.
  const MEMORY_SAVE_INTERVAL_MS = 10 * 60 * 1000;
  setInterval(() => {
    for (const [chatJid, group] of Object.entries(registeredGroups)) {
      const status = queue.getGroupStatus(chatJid);
      if (!status.active) continue;
      queue.sendMessage(
        chatJid,
        '[System] Periodic checkpoint: if you have completed or are mid-way through any tasks, save a brief summary to your memory now using /save-memory. Include what you were doing and what remains.',
      );
      logger.debug({ chatJid, group: group.name }, 'Sent periodic memory-save reminder');
    }
  }, MEMORY_SAVE_INTERVAL_MS);

  // Send boot announcement once main channel is available
  const bootAnnounceTimer = setInterval(async () => {
    const mainJid = getMainChatJid();
    if (!mainJid) return;
    const ch = findChannel(channels, mainJid);
    if (!ch) return;
    clearInterval(bootAnnounceTimer);
    try {
      if (ch.setPresenceStatus) await ch.setPresenceStatus('online', 'idle');
      await ch.sendMessage(mainJid, `✅ <font color="#00cc00">online.</font>\n\n${mainSender()}`);
    } catch (err) {
      logger.warn({ err }, 'Failed to send boot announcement');
    }
  }, 2000);

}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
