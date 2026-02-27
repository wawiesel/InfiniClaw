/**
 * InfiniClaw orchestrator entry point.
 * Composes upstream NanoClaw reusable pieces with InfiniClaw-specific logic.
 *
 * Upstream files (index.ts, container-runner.ts, ipc.ts) are read-only
 * dependencies — never modified by InfiniClaw.
 */
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  ASSISTANT_ROLE,
  DATA_DIR,
  HEAP_LIMIT_MB,
  IDLE_TIMEOUT,
  LOCAL_CHANNEL_ENABLED,
  LOCAL_MIRROR_MATRIX_JID,
  MAIN_GROUP_FOLDER,
  MATRIX_ACCESS_TOKEN,
  MATRIX_HOMESERVER,
  MATRIX_PASSWORD,
  MATRIX_RECONNECT_INTERVAL,
  MATRIX_USERNAME,
  POLL_INTERVAL,
  MEMORY_CHECK_INTERVAL,
  TRIGGER_PATTERN,
} from 'nanoclaw/config.js';
import {
  getAllChats,
  getMessagesSince,
  getNewMessages,
  getRecentMessages,
  getRouterState,
  getSession,
  initDatabase,
  deleteRegisteredGroup,
  deleteSession,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  updateChatName,
} from 'nanoclaw/db.js';
import { GroupQueue } from 'nanoclaw/group-queue.js';
import {
  ContainerOutput,
  writeGroupsSnapshot,
} from 'nanoclaw/container-runner.js';
import type { AvailableGroup } from 'nanoclaw/container-runner.js';
import {
  loadBaseState,
  saveBaseState,
  groupMessagesByChat,
  recoverPendingMessages,
  writeAgentSnapshots,
  wrapOnOutputForSession,
} from 'nanoclaw/composables.js';
import { pruneExpired } from './allow-list.js';
import { MatrixChannel } from './channels/matrix.js';
import { LocalCliChannel } from './channels/local-cli.js';
import { findChannel, formatMessages, stripInternalTags } from 'nanoclaw/router.js';
import { syncPersona } from './service.js';
import { startSchedulerLoop } from 'nanoclaw/task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from 'nanoclaw/types.js';
import { logger } from 'nanoclaw/logger.js';

import {
  MAIN_PROVIDER,
  mainLlm,
  mainSender,
  defaultSenderForGroup,
  resolveConfiguredMainModel,
  normalizeMainLlm,
  setMainLlm,
  maybeAutoSwitchBrainsOnQuotaError,
} from './brain-management.js';
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
} from './chat-activity.js';
import { shouldIgnoreMessage } from './message-filtering.js';
import { appendConversationLog } from './conversation-log.js';
import { statusMessage } from './formatting.js';
import { ensureContainerSystemRunning } from './podman-bootstrap.js';
import { runContainerAgent } from './container-spawn.js';
import { startIpcWatcher } from './ipc-watcher.js';
import { readBrainMode } from './ipc-commands.js';
import { handleOperatorCommand, buildTodoMessage, readTodoItems } from './operator-commands.js';

// ── Module-level state ─────────────────────────────────────────────────

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
const PROGRESS_CHAT_COOLDOWN_MS = 10_000;
const lastProgressChatAt: Record<string, number> = {};
const PIP_PULSE = ['🔵', '🔷', '🔹', '🔷'] as const;
const workThreadIds: Record<string, string> = {};
const activeReplyThreadIds: Record<string, string | undefined> = {};

function isThreadContext(chatJid: string): boolean {
  return Boolean(activeReplyThreadIds[chatJid]);
}

function updateEventIdFile(groupFolder: string, key: 'lastSent' | 'lastReceived', eventId: string): void {
  const idsFile = path.join(DATA_DIR, 'ipc', groupFolder, 'last_event_ids.json');
  try {
    let existing: Record<string, string> = {};
    if (fs.existsSync(idsFile)) {
      existing = JSON.parse(fs.readFileSync(idsFile, 'utf-8'));
    }
    existing[key] = eventId;
    existing[`${key}At`] = new Date().toISOString();
    fs.writeFileSync(idsFile, JSON.stringify(existing, null, 2));
  } catch { /* best effort */ }
}

interface StatusIndicator {
  eventId: string;
  startedAt: number;
  timer: ReturnType<typeof setInterval>;
  chatJid: string;
}

// ── Shared indicator timing ────────────────────────────────────────────

const INDICATOR_DELAY_MS = 5_000;
const INDICATOR_FAST_INTERVAL_MS = 5_000;
const INDICATOR_SLOW_INTERVAL_MS = 15_000;
const INDICATOR_SLOW_THRESHOLD_MS = 55_000; // switch at ~1 minute

function formatElapsed(startedAt: number): string {
  const secs = Math.round((Date.now() - startedAt) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Create an adaptive timer: fast (5s) for the first minute, then slow (15s). */
function createAdaptiveTimer(
  startedAt: number,
  onTick: () => void,
  registry: Record<string, StatusIndicator>,
  chatJid: string,
): ReturnType<typeof setInterval> {
  const fastTimer = setInterval(() => {
    onTick();
    if (Date.now() - startedAt >= INDICATOR_SLOW_THRESHOLD_MS && registry[chatJid]?.timer === fastTimer) {
      clearInterval(fastTimer);
      const slowTimer = setInterval(onTick, INDICATOR_SLOW_INTERVAL_MS);
      registry[chatJid].timer = slowTimer;
    }
  }, INDICATOR_FAST_INTERVAL_MS);
  return fastTimer;
}

// ── Generic status indicator ───────────────────────────────────────────

/** Reusable status indicator that posts, edits, and auto-escalates timing. */
function createIndicatorSet(emoji: string, activeVerb: string, doneVerb: string, delayMs?: number) {
  const indicators: Record<string, StatusIndicator> = {};
  const delays: Record<string, ReturnType<typeof setTimeout>> = {};

  function start(chatJid: string, threadId?: string): void {
    if (indicators[chatJid] || delays[chatJid]) return;
    const startedAt = Date.now();
    const send = () => {
      if (indicators[chatJid]) return;
      const ch = findChannel(channels, chatJid);
      if (!ch?.sendMessageReturningId || !ch?.editMessage) return;
      ch.sendMessageReturningId(chatJid, statusMessage(emoji, `${activeVerb}...`), threadId).then((eventId) => {
        if (!eventId) return;
        if (indicators[chatJid]) {
          ch.editMessage!(chatJid, eventId, statusMessage(emoji, `${doneVerb} (${formatElapsed(startedAt)})`)).catch(() => { });
          return;
        }
        const doEdit = () => ch.editMessage!(chatJid, eventId, statusMessage(emoji, `${activeVerb} (${formatElapsed(startedAt)})`)).catch(() => { });
        const timer = createAdaptiveTimer(startedAt, doEdit, indicators, chatJid);
        indicators[chatJid] = { eventId, startedAt, timer, chatJid };
      }).catch(() => { });
    };
    if (delayMs) {
      delays[chatJid] = setTimeout(() => { delete delays[chatJid]; send(); }, delayMs);
    } else {
      send();
    }
  }

  function clear(chatJid: string): void {
    if (delays[chatJid]) { clearTimeout(delays[chatJid]); delete delays[chatJid]; return; }
    const indicator = indicators[chatJid];
    if (!indicator) return;
    if (indicator.timer) clearInterval(indicator.timer);
    delete indicators[chatJid];
    if (!indicator.eventId) return;
    const ch = findChannel(channels, chatJid);
    if (ch?.editMessage) {
      ch.editMessage(chatJid, indicator.eventId, statusMessage(emoji, `${doneVerb} (${formatElapsed(indicator.startedAt)})`)).catch(() => { });
    }
  }

  function bump(chatJid: string, threadId?: string): void {
    if (delays[chatJid]) { clearTimeout(delays[chatJid]); delete delays[chatJid]; start(chatJid, threadId); return; }
    const indicator = indicators[chatJid];
    if (!indicator) { start(chatJid, threadId); return; }
    const ch = findChannel(channels, chatJid);
    if (ch?.editMessage) {
      ch.editMessage(chatJid, indicator.eventId, statusMessage(emoji, `${activeVerb} (${formatElapsed(indicator.startedAt)})`)).catch(() => { });
    }
  }

  return { indicators, start, clear, bump };
}

// ── Working & idle indicators ──────────────────────────────────────────

const working = createIndicatorSet('⏳', 'working', 'worked', INDICATOR_DELAY_MS);
const idle = createIndicatorSet('💤', 'idling', 'idled');
const { start: startWorkingIndicator, clear: clearWorkingIndicator, bump: bumpWorkingIndicator } = working;
const { start: startIdleIndicator, clear: clearIdleIndicator } = idle;

const RUN_PROGRESS_NUDGE_STALE_MS = 90_000;
const RUN_PROGRESS_NUDGE_COOLDOWN_MS = 120_000;
const RUN_PROGRESS_NUDGE_CHECK_MS = 15_000;

// ── Utility functions ──────────────────────────────────────────────────

function getMainChatJid(): string | undefined {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === MAIN_GROUP_FOLDER) return jid;
  }
  return undefined;
}

let outgoingSeq = 0;

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

// ── State load/save ────────────────────────────────────────────────────

function loadState(): void {
  const state = loadBaseState();
  lastTimestamp = state.lastTimestamp;
  lastAgentTimestamp = state.lastAgentTimestamp;
  sessions = state.sessions;
  registeredGroups = state.registeredGroups;

  const configuredMainModel = resolveConfiguredMainModel();
  const storedMainModel = normalizeMainLlm(getRouterState('main_model'));
  if (configuredMainModel) {
    const pinnedChanged =
      storedMainModel && configuredMainModel !== storedMainModel;
    setMainLlm(configuredMainModel);
    setRouterState('main_model', mainLlm);

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
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  saveBaseState(lastTimestamp, lastAgentTimestamp);
  setRouterState('main_model', mainLlm);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

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

export function getAvailableGroups(): AvailableGroup[] {
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

// ── Output handler context ──────────────────────────────────────────────

interface OutputHandlerContext {
  chatJid: string;
  group: RegisteredGroup;
  inboundMessageIds: string[];
  onAcknowledge: () => void;
  onOutputSent: (text: string) => void;
  onError: () => void;
  onProgress: (text: string) => void;
  stopNudgeTimer: () => void;
  resetIdleTimer: () => void;
}

function createOutputHandler(ctx: OutputHandlerContext): (result: ContainerOutput) => Promise<void> {
  let acknowledged = false;
  let lastSentResultText = '';
  let consecutiveDupSent = 0;

  return async (result: ContainerOutput) => {
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      if (text) {
        // Acknowledge inbound messages on first output
        if (!acknowledged && ctx.inboundMessageIds.length > 0) {
          acknowledged = true;
          ctx.onAcknowledge();
        }
        ctx.onProgress(text);

        if (result.isProgress) {
          handleProgressOutput(ctx, text);
        } else {
          const dedupKey = text.replace(/\s+/g, ' ').trim();
          if (dedupKey === lastSentResultText) {
            consecutiveDupSent++;
          } else {
            consecutiveDupSent = 0;
            lastSentResultText = dedupKey;
          }
          if (consecutiveDupSent >= 2) {
            logger.warn({ group: ctx.group.name, dupCount: consecutiveDupSent }, 'Suppressed duplicate result to chat');
          } else {
            await handleResultOutput(ctx, text);
          }
        }
      }
      ctx.resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(ctx.chatJid);
    }
    if (result.status === 'error') {
      ctx.onError();
    }
  };
}

function handleProgressOutput(ctx: OutputHandlerContext, text: string): void {
  clearIdleIndicator(ctx.chatJid);
  markProgress(ctx.chatJid, text);
  const isToolCall = text.includes('<details>');
  const now = Date.now();
  if (isToolCall || !lastProgressChatAt[ctx.chatJid] || now - lastProgressChatAt[ctx.chatJid] >= PROGRESS_CHAT_COOLDOWN_MS) {
    if (!isToolCall) lastProgressChatAt[ctx.chatJid] = now;
    const ch = findChannel(channels, ctx.chatJid);
    if (ch) {
      const formatted = isToolCall ? text : `<small><em>${text}</em></small>`;
      void ch.sendMessage(ctx.chatJid, formatted, activeReplyThreadIds[ctx.chatJid]).then(() => {
        bumpWorkingIndicator(ctx.chatJid, activeReplyThreadIds[ctx.chatJid]);
      }).catch((err) => {
        logger.warn({ chatJid: ctx.chatJid, err }, 'Failed to send progress to chat');
      });
    }
  }
}

async function handleResultOutput(ctx: OutputHandlerContext, text: string): Promise<void> {
  clearIdleIndicator(ctx.chatJid);
  markProgress(ctx.chatJid, text);
  // Set state before channel send to preserve original behavior if send throws
  ctx.onOutputSent(text);
  ctx.stopNudgeTimer();
  const ch = findChannel(channels, ctx.chatJid);
  if (ch) {
    if (ch.setTyping && !isThreadContext(ctx.chatJid)) await ch.setTyping(ctx.chatJid, true);
    let sentEventId: string | undefined;
    if (ch.sendMessageReturningId) {
      sentEventId = await ch.sendMessageReturningId(ctx.chatJid, text, activeReplyThreadIds[ctx.chatJid]);
    } else {
      await ch.sendMessage(ctx.chatJid, text, activeReplyThreadIds[ctx.chatJid]);
    }
    if (ch.setTyping && !isThreadContext(ctx.chatJid)) await ch.setTyping(ctx.chatJid, false);
    storeOutgoing(ctx.chatJid, text, activeReplyThreadIds[ctx.chatJid]);
    if (sentEventId) {
      const group = registeredGroups[ctx.chatJid];
      if (group) updateEventIdFile(group.folder, 'lastSent', sentEventId);
    }
  }
}

// ── Process group messages ─────────────────────────────────────────────

async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  const filteredMessages = missedMessages.filter((msg) => !shouldIgnoreMessage(msg));
  if (filteredMessages.length === 0) return true;

  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = filteredMessages.some((m) => TRIGGER_PATTERN.test(m.content.trim()));
    if (!hasTrigger) {
      lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
      saveState();
      return true;
    }
  }

  setObjectiveFromMessages(chatJid, filteredMessages);

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

  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: filteredMessages.length },
    'Processing messages',
  );

  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  if (channel?.setPresenceStatus) await channel.setPresenceStatus('online', 'processing...');
  startWorkingIndicator(chatJid, activeReplyThreadIds[chatJid]);
  const inboundMessageIds = filteredMessages.map((m) => m.id).filter(Boolean) as string[];
  let hadError = false;
  let outputSentToUser = false;
  const agentResponses: string[] = [];
  let lastResponseBody: string | undefined;
  let lastRunOutputAt = Date.now();
  let lastRunProgressNudgeAt = 0;
  let runProgressNudgeTimer: ReturnType<typeof setInterval> | null = null;

  markRunStarted(chatJid);

  if (channel?.setStatusPip) {
    void channel.setStatusPip(chatJid, PIP_PULSE[0]).catch(() => { });
  }

  if (isMainGroup) {
    runProgressNudgeTimer = setInterval(() => {
      const now = Date.now();
      if (now - lastRunOutputAt < RUN_PROGRESS_NUDGE_STALE_MS) return;
      if (now - lastRunProgressNudgeAt < RUN_PROGRESS_NUDGE_COOLDOWN_MS) return;
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

  const outputHandler = createOutputHandler({
    chatJid,
    group,
    inboundMessageIds,
    onAcknowledge: () => {
      const ch = findChannel(channels, chatJid);
      if (ch?.sendReaction) {
        for (const msgId of inboundMessageIds) {
          // Skip synthetic IDs (resume-, out-, system-, op-) — only channel-native IDs can be reacted to
          if (/^(resume|out|system|op)-/.test(msgId)) continue;
          void ch.sendReaction(chatJid, msgId, '🔹').catch(() => { });
        }
      }
    },
    onOutputSent: (text) => {
      outputSentToUser = true;
      lastResponseBody = text;
      agentResponses.push(text);
    },
    onError: () => { hadError = true; },
    onProgress: () => { lastRunOutputAt = Date.now(); },
    stopNudgeTimer: () => {
      if (runProgressNudgeTimer) {
        clearInterval(runProgressNudgeTimer);
        runProgressNudgeTimer = null;
      }
    },
    resetIdleTimer,
  });

  const runResult = await runAgent(group, prompt, chatJid, outputHandler);

  clearWorkingIndicator(chatJid);
  clearIdleIndicator(chatJid);
  if (outputSentToUser) {
    startIdleIndicator(chatJid, activeReplyThreadIds[chatJid]);
  }
  // Clear work thread after each response — thread context is per-turn, derived from
  // the incoming message's thread_id. set_thread() only overrides for a single response.
  delete workThreadIds[chatJid];
  if (channel?.setTyping && !isThreadContext(chatJid)) await channel.setTyping(chatJid, false);
  if (channel?.setPresenceStatus) await channel.setPresenceStatus('online', 'idle');
  if (channel?.setStatusPip) {
    void channel.setStatusPip(chatJid, '🟢').catch(() => { });
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

    const isOomKill = /OOM KILLED/.test(compactError);
    if (isOomKill && sessions[group.folder]) {
      deleteSession(group.folder);
      delete sessions[group.folder];
      logger.info({ group: group.name }, 'Cleared session after OOM kill');
    }

    if (!outputSentToUser && channel) {
      // OOM kills and signal-based crashes get a prominent standalone status line
      const isSignalCrash = /^⚠️ /.test(compactError);
      const errorReply = isSignalCrash
        ? compactError
        : `I hit an error while processing that request: ${compactError}`;
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

    if (outputSentToUser && !isOomKill) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      appendConversationLog(group.folder, missedMessages, agentResponses, channel?.name);
      delete activeReplyThreadIds[chatJid];
      markRunEnded(chatJid);
      return true;
    }
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

// ── Run agent ──────────────────────────────────────────────────────────

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<{ status: 'success' | 'error'; error?: string }> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  writeAgentSnapshots(group.folder, isMain, registeredGroups, getAvailableGroups);
  const wrappedOnOutput = wrapOnOutputForSession(sessions, group.folder, onOutput);

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
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return { status: 'error', error: output.error };
    }

    return { status: 'success' };
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Per-group message handling ─────────────────────────────────────────

async function handleGroupMessagesInLoop(
  chatJid: string,
  groupMessages: NewMessage[],
): Promise<void> {
  const group = registeredGroups[chatJid];
  if (!group) return;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
  const filtered = groupMessages.filter((msg) => !shouldIgnoreMessage(msg));
  if (filtered.length === 0) return;

  // Check trigger requirement for non-main groups
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = filtered.some((m) => TRIGGER_PATTERN.test(m.content.trim()));
    if (!hasTrigger) {
      lastAgentTimestamp[chatJid] = groupMessages[groupMessages.length - 1].timestamp;
      saveState();
      return;
    }
  }

  // Collect all pending messages since last agent response
  const allPending = getMessagesSince(
    chatJid,
    lastAgentTimestamp[chatJid] || '',
    ASSISTANT_NAME,
  ).filter((msg) => !shouldIgnoreMessage(msg));
  const messagesToSend = allPending.length > 0 ? allPending : filtered;

  setObjectiveFromMessages(chatJid, messagesToSend);
  const formatted = formatMessages(messagesToSend);

  const lastPiped = messagesToSend[messagesToSend.length - 1];
  activeReplyThreadIds[chatJid] = lastPiped?.thread_id || workThreadIds[chatJid];

  if (queue.sendMessage(chatJid, formatted)) {
    await handlePipedToActiveContainer(chatJid, messagesToSend);
  } else {
    handleQueuedForProcessing(chatJid);
  }
}

async function handlePipedToActiveContainer(
  chatJid: string,
  messagesToSend: NewMessage[],
): Promise<void> {
  logger.debug(
    { chatJid, count: messagesToSend.length },
    'Piped messages to active container',
  );
  clearIdleIndicator(chatJid);
  startWorkingIndicator(chatJid, activeReplyThreadIds[chatJid]);

  lastAgentTimestamp[chatJid] = messagesToSend[messagesToSend.length - 1].timestamp;
  saveState();

  const ch = findChannel(channels, chatJid);
  if (ch?.setTyping && !isThreadContext(chatJid)) await ch.setTyping(chatJid, true);
  if (ch?.setPresenceStatus) await ch.setPresenceStatus('online', 'processing...');
}

function handleQueuedForProcessing(chatJid: string): void {
  queue.enqueueMessageCheck(chatJid);
}

// ── Message loop ───────────────────────────────────────────────────────

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

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

        lastTimestamp = newTimestamp;
        saveState();

        const messagesByGroup = groupMessagesByChat(messages);

        for (const [chatJid, groupMessages] of messagesByGroup) {
          await handleGroupMessagesInLoop(chatJid, groupMessages);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

// ── System notifications ───────────────────────────────────────────────

function injectSystemNotice(chatJid: string, content: string): void {
  storeMessage({
    id: `system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: chatJid,
    sender: 'system',
    sender_name: 'System',
    content,
    timestamp: new Date().toISOString(),
  });
  queue.enqueueMessageCheck(chatJid);
}

// ── Recovery & resume ──────────────────────────────────────────────────

function injectResumeMessage(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    // Ensure chat entry exists (FK constraint) — fresh deploys may not have one yet
    updateChatName(chatJid, group.name);

    // Build active tasks block from todo list
    const todos = readTodoItems(group.folder);
    const activeTodos = todos.filter((t) => t.status !== 'completed');
    let taskBlock = '';
    if (activeTodos.length > 0) {
      const taskLines = activeTodos.map((t) => `- [${t.status}] ${t.content}`);
      taskBlock = `\n\nActive tasks:\n${taskLines.join('\n')}`;
    }

    const recent = getRecentMessages(chatJid, ASSISTANT_NAME, 10).reverse();
    let contextBlock = '';
    if (recent.length > 0) {
      const lines = recent.map((m) => `[${m.sender_name}]: ${m.content.slice(0, 300)}`);
      contextBlock = `\n\nHere are the last ${recent.length} messages before restart:\n${lines.join('\n')}`;
    }

    storeMessage({
      id: `resume-${Date.now()}-${group.folder}`,
      chat_jid: chatJid,
      sender: 'system',
      sender_name: 'System',
      content: `You were restarted. Review the conversation and your active tasks below, then resume any in-progress work. If nothing was in progress, say so briefly and wait.${taskBlock}${contextBlock}`,
      timestamp: new Date().toISOString(),
    });
    queue.enqueueMessageCheck(chatJid);
    logger.info({ chatJid, group: group.name, recentCount: recent.length }, 'Injected resume message with context');
  }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load supplemental env from .env.local
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

  // Persistent interval handles — populated below, cleared on shutdown
  const persistentTimers: ReturnType<typeof setInterval>[] = [];

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    for (const timer of persistentTimers) clearInterval(timer);
    for (const jid of Object.keys(registeredGroups)) {
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

  // Create Matrix channel
  let matrix: MatrixChannel | null = null;
  if (
    MATRIX_HOMESERVER &&
    (MATRIX_ACCESS_TOKEN || (MATRIX_USERNAME && MATRIX_PASSWORD))
  ) {
    matrix = new MatrixChannel({
      onMessage: (_chatJid, msg) => {
        if (handleOperatorCommand(msg, matrix, injectSystemNotice)) return;
        storeMessage(msg);
        if (msg.id && msg.id.startsWith('$')) {
          const group = registeredGroups[msg.chat_jid];
          if (group) updateEventIdFile(group.folder, 'lastReceived', msg.id);
        }
      },
      onChatMetadata: (chatJid, timestamp, name) => {
        storeChatMetadata(chatJid, timestamp, name);
      },
      registeredGroups: () => registeredGroups,
    });
  }

  let localCli: LocalCliChannel | null = null;
  if (LOCAL_CHANNEL_ENABLED) {
    localCli = new LocalCliChannel({
      onMessage: (_chatJid, msg) => {
        if (handleOperatorCommand(msg, matrix, injectSystemNotice)) return;
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

  // Build channels array
  const allChannels: (Channel | null)[] = [localCli, matrix];
  const refreshConnectedChannels = () => {
    channels = allChannels.filter((ch): ch is Channel => ch != null && ch.isConnected());
  };

  if (localCli) {
    try {
      await localCli.connect();
    } catch (err) {
      logger.error({ err }, 'Local CLI channel connect failed');
    }
    refreshConnectedChannels();
  }

  if (matrix) {
    try {
      await matrix.connect();
    } catch (err) {
      logger.error({ err }, 'Initial Matrix connection failed; continuing in degraded mode');
    }
    refreshConnectedChannels();

    let matrixReconnectInProgress = false;
    let matrixReconnectDelay = MATRIX_RECONNECT_INTERVAL;
    const MATRIX_RECONNECT_MAX_DELAY = 5 * 60_000;
    let reconnectEventId: string | undefined;
    let reconnectCount = 0;
    const scheduleReconnect = (): void => {
      setTimeout(async () => {
        if (!matrix || matrixReconnectInProgress) {
          scheduleReconnect();
          return;
        }
        matrixReconnectInProgress = true;
        try {
          const healthy = await matrix.checkHealth();
          if (!healthy) {
            logger.info({ nextRetryMs: matrixReconnectDelay }, 'Matrix disconnected, attempting reconnect...');
            await matrix.connect();
            if (matrix.isConnected()) {
              logger.info('Matrix reconnected');
              matrixReconnectDelay = MATRIX_RECONNECT_INTERVAL;
              refreshConnectedChannels();
              reconnectCount++;
              const mainJid = getMainChatJid();
              if (mainJid) {
                const label = reconnectCount > 1
                  ? statusMessage('🔌', `reconnected (${reconnectCount}x).`)
                  : statusMessage('🔌', 'reconnected.');
                if (reconnectEventId) {
                  matrix.editMessage(mainJid, reconnectEventId, label).catch(() => { });
                } else {
                  const id = await matrix.sendMessageReturningId(mainJid, label).catch(() => undefined);
                  if (id) reconnectEventId = id;
                }
              }
            }
          } else {
            matrixReconnectDelay = MATRIX_RECONNECT_INTERVAL;
          }
        } catch (err) {
          matrixReconnectDelay = Math.min(matrixReconnectDelay * 2, MATRIX_RECONNECT_MAX_DELAY);
          logger.warn({ err, nextRetryMs: matrixReconnectDelay }, 'Matrix reconnect failed, backing off');
        } finally {
          refreshConnectedChannels();
          matrixReconnectInProgress = false;
          scheduleReconnect();
        }
      }, matrixReconnectDelay);
    };
    scheduleReconnect();
  }

  // Memory watchdog
  const heapLimitBytes = HEAP_LIMIT_MB * 1024 * 1024;
  const heartbeatPath = path.join(DATA_DIR, 'heartbeat');
  persistentTimers.push(setInterval(() => {
    const usage = process.memoryUsage();
    const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
    const rssMB = Math.round(usage.rss / 1024 / 1024);
    logger.info({ heapMB, rssMB, limitMB: HEAP_LIMIT_MB }, 'Memory');
    try { fs.writeFileSync(heartbeatPath, String(Date.now())); } catch { }
    if (usage.heapUsed > heapLimitBytes) {
      logger.warn({ heapMB, limitMB: HEAP_LIMIT_MB }, 'Heap limit exceeded, recycling');
      shutdown('HEAP_LIMIT');
    }
  }, MEMORY_CHECK_INTERVAL));
  try { fs.writeFileSync(heartbeatPath, String(Date.now())); } catch { }

  // Prune expired allow-list entries every 5 minutes
  persistentTimers.push(setInterval(() => {
    const count = pruneExpired();
    if (count > 0) logger.info({ count }, 'Pruned expired allow-list entries');
  }, 5 * 60 * 1000));

  // Periodic status snapshot
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

      for (const g of Object.values(registeredGroups)) {
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
  persistentTimers.push(setInterval(writeStatusSnapshot, STATUS_SNAPSHOT_INTERVAL));

  // Start subsystems
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
        await ch.sendMessage(jid, text);
        storeOutgoing(jid, text);
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
    sendMessageReturningId: async (jid, text, threadId) => {
      const ch = findChannel(channels, jid);
      if (!ch) {
        logger.warn({ jid }, 'No channel found for IPC message (returning id)');
        return undefined;
      }
      const eventId = ch.sendMessageReturningId
        ? await ch.sendMessageReturningId(jid, text, threadId)
        : undefined;
      storeOutgoing(jid, text, threadId);
      return eventId;
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
    syncGroupMetadata: async () => { },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
    writeLastEventId: (sourceGroup, eventId) => updateEventIdFile(sourceGroup, 'lastSent', eventId),
  });
  queue.setProcessMessagesFn(processGroupMessages);

  // Group-queue hooks
  queue.setPreCloseHook((_groupJid, inputDir) => {
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
    const activeContainers: string[] = [];
    for (const jid of queue.getActiveGroupJids()) {
      try { queue.closeStdin(jid); } catch { /* best effort */ }
      const status = queue.getGroupStatus(jid);
      if (status.hasProcess && status.containerName) {
        activeContainers.push(status.containerName);
      }
    }
    if (activeContainers.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
    logger.info({ signaled: activeContainers }, 'InfiniClaw shutdown: containers signaled');
  });

  recoverPendingMessages({
    registeredGroups,
    lastAgentTimestamp,
    assistantName: ASSISTANT_NAME,
    enqueueCheck: (chatJid) => queue.enqueueMessageCheck(chatJid),
  });
  injectResumeMessage();
  startMessageLoop();

  // Periodic memory-save reminder (only when bot is actively working, not idle)
  const MEMORY_SAVE_INTERVAL_MS = 10 * 60 * 1000;
  persistentTimers.push(setInterval(() => {
    for (const [chatJid, group] of Object.entries(registeredGroups)) {
      const status = queue.getGroupStatus(chatJid);
      if (!status.active || status.idleWaiting) continue;
      queue.sendMessage(
        chatJid,
        '[System] Periodic checkpoint: if you have completed or are mid-way through any tasks, save a brief summary to your memory now using /save-memory. Include what you were doing and what remains.',
      );
      logger.debug({ chatJid, group: group.name }, 'Sent periodic memory-save reminder');
    }
  }, MEMORY_SAVE_INTERVAL_MS));

  // Periodic todo list enforcement (every 2 minutes)
  const TODO_ENFORCE_INTERVAL_MS = 2 * 60 * 1000;
  persistentTimers.push(setInterval(() => {
    for (const [chatJid, group] of Object.entries(registeredGroups)) {
      const status = queue.getGroupStatus(chatJid);
      if (!status.active || status.idleWaiting) continue;

      // Read todo file
      const todosDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude', 'todos');
      if (!fs.existsSync(todosDir)) {
        injectSystemNotice(chatJid, '[System] TodoWrite reminder: Your todo list is empty. Please update it to reflect your current work.');
        logger.debug({ chatJid, group: group.name }, 'Sent todo enforcement reminder (no todos dir)');
        continue;
      }

      const sessionId = getSession(group.folder);
      if (!sessionId) continue;

      const sessionFile = path.join(todosDir, `${sessionId}-agent-${sessionId}.json`);
      let hasInProgress = false;
      try {
        if (fs.existsSync(sessionFile)) {
          const raw = fs.readFileSync(sessionFile, 'utf-8').trim();
          if (raw && raw !== '[]') {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              hasInProgress = parsed.some((t: { status?: string }) => t.status === 'in_progress');
            }
          }
        }
      } catch {
        // Ignore parse errors
      }

      if (!hasInProgress) {
        injectSystemNotice(chatJid, '[System] TodoWrite reminder: Your todo list has no in_progress items. Please update it to reflect what you are currently working on.');
        logger.debug({ chatJid, group: group.name }, 'Sent todo enforcement reminder (no in_progress)');
      }
    }
  }, TODO_ENFORCE_INTERVAL_MS));

  // Boot announcement
  const bootAnnounceTimer = setInterval(async () => {
    const mainJid = getMainChatJid();
    if (!mainJid) return;
    const ch = findChannel(channels, mainJid);
    if (!ch) return;
    clearInterval(bootAnnounceTimer);
    try {
      if (ch.setPresenceStatus) await ch.setPresenceStatus('online', 'idle');
      await ch.sendMessage(mainJid, `${statusMessage('✅', 'online.')}<br>${mainSender()}`);
      // Auto-send todo list so Operator sees what the bot is picking up
      const todo = buildTodoMessage(mainJid);
      await ch.sendMessage(mainJid, todo);
    } catch (err) {
      logger.warn({ err }, 'Failed to send boot announcement');
    }
  }, 2000);
}

// Guard: only run when executed directly
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start InfiniClaw');
    process.exit(1);
  });
}
