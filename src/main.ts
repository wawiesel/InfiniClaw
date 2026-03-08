/**
 * InfiniClaw orchestrator entry point.
 * Composes upstream NanoClaw reusable pieces with InfiniClaw-specific logic.
 *
 * Upstream files (index.ts, container-runner.ts, ipc.ts) are read-only
 * dependencies — never modified by InfiniClaw.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from 'nanoclaw/config.js';
import {
  ASSISTANT_ROLE,
  CAPTAIN_USER_ID,
  HEAP_LIMIT_MB,
  LOCAL_CHANNEL_ENABLED,
  LOCAL_MIRROR_MATRIX_JID,
  MAIN_GROUP_FOLDER,
  MATRIX_ACCESS_TOKEN,
  MATRIX_HOMESERVER,
  MATRIX_PASSWORD,
  MATRIX_RECONNECT_INTERVAL,
  MATRIX_USERNAME,
  MEMORY_CHECK_INTERVAL,
  RESUME_DELAY_SECONDS,
  validateConfig,
} from './infini-config.js';
import {
  getAllChats,
  botParticipatesInThread,
  getMessagesSince,
  getNewMessages,
  getRecentMessages,
  getThreadMessages,
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
import { channels, setChannels, findChannel, getMainChatJid } from './channel-manager.js';
import {
  shellQuote,
  formatDuration,
  formatTimestamp,
  errStr,
  resolveRoot,
  assertValidBotName,
} from './utils.js';
import { getGitVersion, getGitVersionStr } from './formatting.js';
import { fleetManager } from './fleet-manager.js';
import { matrixService } from './matrix-service.js';

import {
  MAIN_PROVIDER,
  mainLlm,
  defaultSenderForGroup,
  resolveConfiguredMainModel,
  normalizeMainLlm,
  setMainLlm,
  maybeAutoSwitchBrainsOnQuotaError,
  recordMetrics,
} from './llm-service.js';
import {
  ensureChatActivity,
  setObjectiveFromMessages,
  markRunStarted,
  markRunEnded,
  markProgress,
  markCompletion,
  markError,
  buildMainMissionContext,
} from './chat-activity-service.js';
import { shouldIgnoreMessage, normalizeInboundMessage } from './message-filtering.js';
import { appendConversationLog } from './conversation-log.js';
import { statusMessage, getGitVersion, getGitVersionStr } from './formatting.js';
import { ensureContainerSystemRunning } from './podman-bootstrap.js';
import { uploadContent, uploadHtml, getPublicS3Url } from './s3-sync.js';
import { exportHistoryToS3 } from './history-export.js';
import { toolCallBreadcrumb } from './chat-activity-service.js';

// ── Git version info (resolved once at module load) ────────────────────────
const GIT_VERSION = getGitVersion(resolveRoot());

import { runContainerAgent } from './container-spawn.js';
import { startIpcWatcher } from './ipc-watcher.js';
import { readBrainMode } from './ipc-commands.js';
import { getActiveBots, loadProfileEnv } from './service.js';
import { loadFleet } from './ship-config.js';
import { buildTodoMessage, readTodoItems } from './todo-service.js';

import { botMatrixUserIds, setBotMatrixUserIds, botDisplayName } from './bot-manager.js';

// ── Module-level state ─────────────────────────────────────────────────

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
const PROGRESS_CHAT_COOLDOWN_MS = 10_000;
const lastProgressChatAt: Record<string, number> = {};
const workThreadIds: Record<string, string> = {};
const activeReplyThreadIds: Record<string, string | undefined> = {};
// Per-turn thread for tool call <details> blocks when on main timeline
const progressToolCallThreadIds: Record<string, string | undefined> = {};
const threadMapLastSeen: Record<string, number> = {};
const triggerAckByMessageKey: Record<string, number> = {};
let resumeGateResolve: (() => void) | null = null;
const resumeGate = new Promise<void>((resolve) => { resumeGateResolve = resolve; });
let isResuming = false;

// ── CO roster (initialized from fleet.json at startup, updated via lifecycle messages) ──
let matrixRef: MatrixChannel | null = null;

/** Parse relay lifecycle messages to update CO roster at runtime. */
async function handleLifecycleMessage(msg: { content: string; chat_jid: string; sender: string }): Promise<boolean> {
  const previousIsCO = fleetManager.isCO(msg.chat_jid, ASSISTANT_NAME);
  const result = fleetManager.handleLifecycleMessage(msg, ASSISTANT_NAME, botMatrixUserIds);
  const currentIsCO = fleetManager.isCO(msg.chat_jid, ASSISTANT_NAME);

  if (matrixRef && previousIsCO !== currentIsCO) {
    await matrixService.setDisplayName(botDisplayName(currentIsCO ? '⭐' : '🟢'));
  }
  return result;
}

/** Check if this bot is CO and there's an unaddressed human message on the main timeline. */
function isCOMainTimelineTrigger(chatJid: string, messages: NewMessage[]): boolean {
  return fleetManager.isCOMainTimelineTrigger(chatJid, messages, ASSISTANT_NAME, botMatrixUserIds);
}

/** Resolve which thread a response should go to. Reply where the message was. */
function resolveReplyThread(
  chatJid: string,
  messages: NewMessage[],
): string | undefined {
  // Find the most recent triggered/human thread message — that's where we should reply.
  // Scanning from end to find the latest thread message that triggered us.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.thread_id && !botMatrixUserIds.has(m.sender)) return m.thread_id;
  }
  // Also check last message (could be a bot thread message we're continuing)
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.thread_id) return lastMsg.thread_id;
  // Work thread override (set by setWorkThread MCP tool)
  if (workThreadIds[chatJid]) {
    threadMapLastSeen[`w:${chatJid}`] = Date.now();
    return workThreadIds[chatJid];
  }
  // Main timeline message → reply on main timeline (no auto-threading)
  return undefined;
}

// Exit-137 (SIGKILL) backoff — prevents tight respawn loops when containers are killed externally.
// We can't know if it's OOM or a host kill, but we should still back off to avoid hammering resources.
const KILL_137_COOLDOWN_MS = parseInt(process.env.KILL_137_COOLDOWN_MS || '60000', 10);
const KILL_137_MAX_CONSECUTIVE = parseInt(process.env.KILL_137_MAX_CONSECUTIVE || '3', 10);
const kill137Consecutive: Record<string, number> = {};
const kill137CooldownUntil: Record<string, number> = {};

// Idle pip — change display name pip after prolonged inactivity
const IDLE_PIP_THRESHOLD_MS = parseInt(process.env.IDLE_PIP_THRESHOLD_MS || '300000', 10); // 5 minutes default
const IDLE_PIP_CHECK_MS = 60_000;
let lastActivityAt = Date.now();
let idlePipActive = false;

const METRICS_HISTORY_FILE = path.join(DATA_DIR, 'metrics-history.jsonl');
const METRICS_HISTORY_MAX_LINES = 10_000;

function isThreadContext(chatJid: string): boolean {
  threadMapLastSeen[`r:${chatJid}`] = Date.now();
  return Boolean(activeReplyThreadIds[chatJid]);
}

function sendTriggerAck(chatJid: string, messages: NewMessage[]): void {
  void matrixService.setTyping(chatJid, true);
  for (const m of messages) {
    if (!m.id || /^(resume|out|system|op)-/.test(m.id)) continue;
    const key = `${chatJid}:${m.id}`;
    if (triggerAckByMessageKey[key]) continue;
    triggerAckByMessageKey[key] = Date.now();
    void matrixService.sendReaction(chatJid, m.id, '👀');
  }
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
  } catch (err) { logger.debug({ groupFolder, key, err }, 'Failed to update event ID file'); }
}

// ── Utility functions ──────────────────────────────────────────────────

let outgoingSeq = 0;

function storeOutgoing(chatJid: string, text: string, threadId?: string): void {
  // Ensure the chat exists so the FK constraint on messages is satisfied
  // (cross-bot IPC can target rooms not yet in this bot's chats table)
  storeChatMetadata(chatJid, new Date().toISOString());
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

function sendToolCallToMainTimeline(ctx: OutputHandlerContext, ch: Channel, toolCallHtml: string): void {
  const sendToToolThread = (targetThreadId: string) => {
    void ch.sendMessage(ctx.chatJid, toolCallHtml, targetThreadId).then(() => {
    }).catch((err) => {
      logger.warn({ chatJid: ctx.chatJid, err }, 'Failed to send tool call to dedicated thread');
    });
  };
  threadMapLastSeen[`p:${ctx.chatJid}`] = Date.now();
  if (progressToolCallThreadIds[ctx.chatJid]) {
    sendToToolThread(progressToolCallThreadIds[ctx.chatJid]!);
  } else if (ch.sendMessageReturningId) {
    void ch.sendMessageReturningId(ctx.chatJid, '<font color="#888888"><em>🔧 Tool calls</em></font>').then((anchorId) => {
      if (anchorId) {
        progressToolCallThreadIds[ctx.chatJid] = anchorId;
        threadMapLastSeen[`p:${ctx.chatJid}`] = Date.now();
        sendToToolThread(anchorId);
      } else {
        void ch.sendMessage(ctx.chatJid, toolCallHtml).catch((err) => { logger.warn({ chatJid: ctx.chatJid, err }, 'Fallback tool call send failed'); });
      }
    }).catch((err) => {
      logger.warn({ chatJid: ctx.chatJid, err }, 'Failed to open tool call thread anchor');
    });
  } else {
    void ch.sendMessage(ctx.chatJid, toolCallHtml).catch((err) => { logger.warn({ chatJid: ctx.chatJid, err }, 'Inline tool call send failed'); });
  }
}

function handleToolCallProgress(ctx: OutputHandlerContext, text: string, ch: Channel): void {
  const group = registeredGroups[ctx.chatJid];
  const groupName = group?.name ?? ctx.chatJid;
  const threadId = activeReplyThreadIds[ctx.chatJid];
  const contextMessages = threadId
    ? getThreadMessages(ctx.chatJid, threadId, 20)
    : getRecentMessages(ctx.chatJid, ASSISTANT_NAME, 10).reverse();
  const bc = toolCallBreadcrumb(text, contextMessages, groupName);
  const toolCallHtml = bc.html;
  void uploadHtml(bc.s3Key, bc.pageHtml).catch((err) => {
    logger.warn({ err }, 'Failed to upload tool call to S3');
  });

  threadMapLastSeen[`r:${ctx.chatJid}`] = Date.now();
  const activeThread = activeReplyThreadIds[ctx.chatJid];
  if (activeThread) {
    void ch.sendMessage(ctx.chatJid, toolCallHtml, activeThread).then(() => {
    }).catch((err) => {
      logger.warn({ chatJid: ctx.chatJid, err }, 'Failed to send tool call progress to thread');
    });
  } else {
    sendToolCallToMainTimeline(ctx, ch, toolCallHtml);
  }
}

function handleRegularProgress(ctx: OutputHandlerContext, text: string, ch: Channel): void {
  const formatted = `<small><em>${esc(text)}</em></small>`;
  threadMapLastSeen[`r:${ctx.chatJid}`] = Date.now();
  void ch.sendMessage(ctx.chatJid, formatted, activeReplyThreadIds[ctx.chatJid]).then(() => {
    threadMapLastSeen[`r:${ctx.chatJid}`] = Date.now();
  }).catch((err) => {
    logger.warn({ chatJid: ctx.chatJid, err }, 'Failed to send progress to chat');
  });
}

function handleProgressOutput(ctx: OutputHandlerContext, text: string): void {
  markProgress(ctx.chatJid, text);
  const isToolCall = text.includes('<details>');
  const now = Date.now();
  if (isToolCall || !lastProgressChatAt[ctx.chatJid] || now - lastProgressChatAt[ctx.chatJid] >= PROGRESS_CHAT_COOLDOWN_MS) {
    if (!isToolCall) lastProgressChatAt[ctx.chatJid] = now;
    const ch = findChannel(ctx.chatJid);
    if (ch) {
      if (isToolCall) {
        handleToolCallProgress(ctx, text, ch);
      } else {
        handleRegularProgress(ctx, text, ch);
      }
    }
  }
}

async function handleResultOutput(ctx: OutputHandlerContext, text: string): Promise<void> {
  markProgress(ctx.chatJid, text);
  // Set state before channel send to preserve original behavior if send throws
  ctx.onOutputSent(text);
  const ch = findChannel(ctx.chatJid);
  if (ch) {
    await matrixService.setTyping(ctx.chatJid, true);
    try {
      let sentEventId: string | undefined;
      threadMapLastSeen[`r:${ctx.chatJid}`] = Date.now();
      if (ch.sendMessageReturningId) {
        sentEventId = await ch.sendMessageReturningId(ctx.chatJid, text, activeReplyThreadIds[ctx.chatJid]);
      } else {
        await ch.sendMessage(ctx.chatJid, text, activeReplyThreadIds[ctx.chatJid]);
      }
      threadMapLastSeen[`r:${ctx.chatJid}`] = Date.now();
      storeOutgoing(ctx.chatJid, text, activeReplyThreadIds[ctx.chatJid]);
      if (sentEventId) {
        const group = registeredGroups[ctx.chatJid];
        if (group) updateEventIdFile(group.folder, 'lastSent', sentEventId);
      }
    } finally {
      await matrixService.setTyping(ctx.chatJid, false);
    }
  }
}

// ── Process group messages ─────────────────────────────────────────────

async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  // Exit-137 backoff: if we hit repeated SIGKILL exits, pause before respawning
  const killCooldownEnd = kill137CooldownUntil[chatJid] || 0;
  if (killCooldownEnd > Date.now()) {
    const remainSec = Math.round((killCooldownEnd - Date.now()) / 1000);
    logger.warn(
      { group: group.name, consecutiveKills: kill137Consecutive[chatJid], cooldownRemainingSec: remainSec },
      'Exit-137 cooldown active, deferring container spawn',
    );
    return false;
  }

  const channel = findChannel(chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
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

  // Separate actionable messages from noise.
  // A message triggers a response if it's from a human OR from a bot that calls out this bot.
  // Host commands (!operator) are visible as context but don't trigger responses.
  const actionableMessages = filteredMessages.filter(m => {
    if (/^!operator\b/i.test(m.content.trim())) return false;
    if (!botMatrixUserIds.has(m.sender)) return true; // human
    return TRIGGER_PATTERN.test(m.content.trim()); // bot callout
  });
  if (actionableMessages.length === 0) {
    // Only non-actionable messages — advance cursor, don't respond
    lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    return true;
  }

  // Response decision
  const hasTrigger = actionableMessages.some(m => TRIGGER_PATTERN.test(m.content.trim()));
  const hasParticipatingThread = actionableMessages.some(
    m => m.thread_id && botParticipatesInThread(chatJid, m.thread_id),
  );
  const isCOTrigger = isCOMainTimelineTrigger(chatJid, actionableMessages);

  // Need explicit callout, participating thread, or CO main timeline duty
  if (!hasTrigger && !hasParticipatingThread && !isCOTrigger) {
    lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    return true;
  }

  // Filter context by thread participation — exclude threads bot isn't part of
  const contextMessages = filteredMessages.filter(m => {
    if (!m.thread_id) return true;
    return botParticipatesInThread(chatJid, m.thread_id)
      || TRIGGER_PATTERN.test(m.content.trim());
  });

  // Acknowledge only messages that actually enter the context window.
  sendTriggerAck(chatJid, contextMessages);

  setObjectiveFromMessages(chatJid, contextMessages);

  activeReplyThreadIds[chatJid] = resolveReplyThread(chatJid, contextMessages);
  threadMapLastSeen[`r:${chatJid}`] = Date.now();
  logger.info(
    { group: group.name, replyThreadId: activeReplyThreadIds[chatJid], msgCount: contextMessages.length },
    'Thread routing resolved',
  );

  const basePrompt = formatMessages(contextMessages);
  const threadContext = buildThreadContextBlock(chatJid, contextMessages);
  const missionContext =
    isMainGroup ? buildMainMissionContext(chatJid) : undefined;
  const triageInstruction = 'The `branch_to_thread` tool is available for long-running tasks (>30s). Use it when a task needs to run in parallel without blocking new messages.';
  const parts: string[] = [];
  if (missionContext) parts.push(missionContext);
  if (isMainGroup) parts.push(triageInstruction);
  if (threadContext) parts.push(threadContext);
  parts.push(basePrompt);
  const prompt = parts.join('\n\n');

  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: contextMessages.length },
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
  lastActivityAt = Date.now();
  idlePipActive = false;
  const inboundMessageIds = contextMessages.map((m) => m.id).filter(Boolean) as string[];
  let hadError = false;
  let outputSentToUser = false;
  const agentResponses: string[] = [];
  let lastResponseBody: string | undefined;
  markRunStarted(chatJid);


  const outputHandler = createOutputHandler({
    chatJid,
    group,
    inboundMessageIds,
    onAcknowledge: () => { },
    onOutputSent: (text) => {
      outputSentToUser = true;
      lastResponseBody = text;
      agentResponses.push(text);
    },
    onError: () => { hadError = true; },
    onProgress: () => { },
    resetIdleTimer,
  });

  const runResult = await runAgent(group, prompt, chatJid, outputHandler);

  // Clear work thread after each response — thread context is per-turn, derived from
  // the incoming message's thread_id. set_thread() only overrides for a single response.
  delete workThreadIds[chatJid];
  // Clear per-turn tool call thread so next turn opens a fresh anchor
  delete progressToolCallThreadIds[chatJid];
  if (channel?.setTyping) await channel.setTyping(chatJid, false);
  if (channel?.setPresenceStatus) await channel.setPresenceStatus('online', 'idle');
  if (channel?.setStatusPip) {
    void channel.setStatusPip(chatJid, '🟢').catch((err) => { logger.debug({ chatJid, err }, 'Status pip green failed'); });
  }
  if (idleTimer) clearTimeout(idleTimer);

  if (runResult.status === 'error' || hadError) {
    const rawError =
      runResult.error ||
      (hadError ? 'agent returned an error status' : 'unknown error');
    await maybeAutoSwitchBrainsOnQuotaError(rawError, chatJid, async (jid, text) => {
      const ch = findChannel(jid);
      if (ch) await ch.sendMessage(jid, text);
    });
    const compactError = rawError.replace(/\s+/g, ' ').slice(0, 1000);
    markError(chatJid, compactError);

    // Track exit-137 (SIGKILL) kills and apply backoff after consecutive hits
    const isSigKill = /exit 137/.test(compactError) || /SIGKILL/.test(compactError);
    if (isSigKill) {
      kill137Consecutive[chatJid] = (kill137Consecutive[chatJid] || 0) + 1;
      if (kill137Consecutive[chatJid] >= KILL_137_MAX_CONSECUTIVE) {
        kill137CooldownUntil[chatJid] = Date.now() + KILL_137_COOLDOWN_MS;
        logger.warn(
          { group: group.name, consecutiveKills: kill137Consecutive[chatJid], cooldownMs: KILL_137_COOLDOWN_MS },
          'Repeated exit-137 kills — applying respawn cooldown',
        );
        kill137Consecutive[chatJid] = 0; // reset counter after engaging cooldown
      }
    } else {
      kill137Consecutive[chatJid] = 0; // reset on any clean run
    }

    if (!outputSentToUser && channel) {
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

    if (outputSentToUser) {
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

    if (output.newSessionId && output.status !== 'error') {
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

// ── Active-container IPC follow-ups ───────────────────────────────────
function writeMessageToActiveContainerIpc(chatJid: string, group: RegisteredGroup, text: string): boolean {
  const groupStatus = queue.getGroupStatus(chatJid);
  if (!groupStatus.active) return false;

  const inputDir = path.join(DATA_DIR, 'ipc', group.folder, 'input');
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    const filename = `message-${Date.now()}.json`;
    const filepath = path.join(inputDir, filename);
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
    fs.renameSync(tempPath, filepath);
    logger.info({ chatJid, group: group.name }, 'Queued message for active container via IPC');
    return true;
  } catch (err) {
    logger.error({ chatJid, err }, 'Failed to write active-container IPC message');
    return false;
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

  // Separate actionable messages from noise.
  // A message triggers a response if it's from a human OR from a bot that calls out this bot.
  // Host commands (!operator) are visible as context but don't trigger responses.
  const actionableMessages = filtered.filter(m => {
    if (/^!operator\b/i.test(m.content.trim())) return false;
    if (!botMatrixUserIds.has(m.sender)) return true; // human
    return TRIGGER_PATTERN.test(m.content.trim()); // bot callout
  });
  if (actionableMessages.length === 0) {
    // Only non-actionable messages — advance cursor, don't respond
    lastAgentTimestamp[chatJid] = groupMessages[groupMessages.length - 1].timestamp;
    saveState();
    return;
  }

  // Response decision
  const hasTrigger = actionableMessages.some(m => TRIGGER_PATTERN.test(m.content.trim()));
  const hasParticipatingThread = actionableMessages.some(
    m => m.thread_id && botParticipatesInThread(chatJid, m.thread_id),
  );
  const isCOTrigger = isCOMainTimelineTrigger(chatJid, actionableMessages);

  // Need explicit callout, participating thread, or CO main timeline duty
  if (!hasTrigger && !hasParticipatingThread && !isCOTrigger) {
    lastAgentTimestamp[chatJid] = groupMessages[groupMessages.length - 1].timestamp;
    saveState();
    return;
  }

  // Collect all pending messages since last agent response, filtered by thread participation
  const allPending = getMessagesSince(
    chatJid,
    lastAgentTimestamp[chatJid] || '',
    ASSISTANT_NAME,
  ).filter((msg) => {
    if (shouldIgnoreMessage(msg)) return false;
    // Include main timeline messages; for threads, only include if bot participates
    if (msg.thread_id) {
      return botParticipatesInThread(chatJid, msg.thread_id)
        || TRIGGER_PATTERN.test(msg.content.trim());
    }
    return true;
  });
  const messagesToSend = allPending.length > 0 ? allPending : filtered;

  // Acknowledge only messages that actually enter the context window.
  sendTriggerAck(chatJid, messagesToSend);

  setObjectiveFromMessages(chatJid, messagesToSend);
  const threadCtx = buildThreadContextBlock(chatJid, messagesToSend);
  const rawFormatted = formatMessages(messagesToSend);
  const formatted = threadCtx ? `${threadCtx}\n\n${rawFormatted}` : rawFormatted;

  activeReplyThreadIds[chatJid] = resolveReplyThread(chatJid, messagesToSend);
  threadMapLastSeen[`r:${chatJid}`] = Date.now();

  const groupStatus = queue.getGroupStatus(chatJid);
  if (groupStatus.active) {
    // Keep active-container IPC as a high-priority lane for captain/operator messages.
    // Bot-to-bot traffic should queue normally to avoid starvation/loop churn.
    const shouldPrioritizeToActiveContainer = messagesToSend.some((m) => {
      if (botMatrixUserIds.has(m.sender)) return false;
      const isCaptain = Boolean(CAPTAIN_USER_ID) && m.sender === CAPTAIN_USER_ID;
      const isOperatorTrigger = TRIGGER_PATTERN.test(m.content.trim());
      return isCaptain || isOperatorTrigger;
    });

    if (shouldPrioritizeToActiveContainer) {
      handlePipedToActiveContainer(chatJid, group, messagesToSend, formatted);
    } else {
      handleQueuedForProcessing(chatJid);
    }
    return;
  }

  handleQueuedForProcessing(chatJid);
}

function handlePipedToActiveContainer(
  chatJid: string,
  group: RegisteredGroup,
  messagesToSend: NewMessage[],
  formatted: string,
): void {
  if (!writeMessageToActiveContainerIpc(chatJid, group, formatted)) {
    handleQueuedForProcessing(chatJid);
    return;
  }

  logger.debug(
    { chatJid, count: messagesToSend.length },
    'Piped messages to active container',
  );
  lastAgentTimestamp[chatJid] = messagesToSend[messagesToSend.length - 1].timestamp;
  saveState();

  const ch = findChannel(chatJid);
  void matrixService.setTyping(chatJid, true);
  if (ch?.setPresenceStatus) void ch.setPresenceStatus('online', 'processing...').catch((err) => { logger.debug({ chatJid, err }, 'Set presence failed'); });
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
  await resumeGate;

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

function buildThreadContextBlock(chatJid: string, messages: NewMessage[]): string {
  const threadIds = new Set(messages.map(m => m.thread_id).filter(Boolean) as string[]);
  if (threadIds.size === 0) return '';
  const newMessageIds = new Set(messages.map(m => m.id).filter(Boolean) as string[]);
  let allThreadMessages: import('nanoclaw/types.js').NewMessage[] = [];
  for (const tid of threadIds) {
    allThreadMessages = allThreadMessages.concat(getThreadMessages(chatJid, tid));
  }
  return formatThreadContext(allThreadMessages, newMessageIds);
}

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

function handleMergeRequest(payload: { sourceGroup: string; threadId: string; bot: string; summary?: string }): void {
  const mainJid = getMainChatJid(registeredGroups);
  if (!mainJid) {
    logger.warn({ payload }, 'merge_request received but main group is not registered');
    return;
  }
  injectSystemNotice(mainJid, `[System] Thread ${payload.threadId} merged. Update the Captain on the main timeline.`);
  logger.info(
    { sourceGroup: payload.sourceGroup, threadId: payload.threadId, bot: payload.bot, hasSummary: Boolean(payload.summary) },
    'Injected merge_request notice into main timeline',
  );
}

// ── Recovery & resume ──────────────────────────────────────────────────

async function injectResumeMessage(): Promise<void> {
  isResuming = true;
  const mainJid = getMainChatJid(registeredGroups);

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
      // Strip trigger mentions from context so the resume message doesn't
      // falsely match the trigger pattern and start the container.
      const lines = recent.map((m) => {
        const sanitized = m.content.slice(0, 300).replace(TRIGGER_PATTERN, '[callout]');
        return `[${m.sender_name}]: ${sanitized}`;
      });
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

  // Process main group resume synchronously (container runs, reviews session)
  if (mainJid) {
    await processGroupMessages(mainJid);
  }

  // Send updated todo list to main room
  if (mainJid) {
    const items = readTodoItems(MAIN_GROUP_FOLDER);
    if (items.length > 0) {
      const ch = findChannel(mainJid);
      if (ch) {
        await ch.sendMessage(mainJid, buildTodoMessage(mainJid));
      }
    }
  }

  // Wait before opening the gate
  if (RESUME_DELAY_SECONDS > 0) {
    logger.info({ delaySeconds: RESUME_DELAY_SECONDS }, 'Resume delay before processing messages');
    await new Promise((r) => setTimeout(r, RESUME_DELAY_SECONDS * 1000));
  }

  isResuming = false;
  resumeGateResolve!();
  logger.info('Resume complete, message loop unblocked');
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

  // Validate config and warn about missing values
  const configWarnings = validateConfig();
  for (const w of configWarnings) logger.warn(w);
  loadState();

  // Populate bot Matrix user IDs for human-vs-bot message filtering
  try {
    setBotMatrixUserIds(collectBotMatrixUserIds());
    logger.info({ count: botMatrixUserIds.size, ids: [...botMatrixUserIds] }, 'Loaded bot Matrix user IDs');
  } catch (err) {
    logger.warn({ err }, 'Failed to collect bot Matrix user IDs, bot-filtering disabled');
  }

  // Persistent interval handles — populated below, cleared on shutdown
  const persistentTimers: ReturnType<typeof setInterval>[] = [];

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    for (const timer of persistentTimers) clearInterval(timer);
    for (const jid of Object.keys(registeredGroups)) {
      const ch = findChannel(jid);
      if (ch?.setStatusPip) {
        try { await ch.setStatusPip(jid, '🔴'); } catch { /* best-effort */ }
      }
    }
    for (const ch of channels) {
      if (ch.setPresenceStatus) await ch.setPresenceStatus('offline', 'shutting down...');
    }
    if (matrixRef) {
      try { await matrixService.setDisplayName(botDisplayName('🔴')); } catch { /* best-effort */ }
    }
    syncPersonas();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Determine initial CO status from fleet.json before connecting
  let initialBadge = '🟢';
  try {
    const fleet = loadFleet();
    const root = resolveRoot();
    const roomNameToJid: Record<string, string> = {};
    for (const [jid, group] of Object.entries(registeredGroups)) {
      roomNameToJid[group.name.toLowerCase()] = jid;
    }
    // Build roster from active bots in fleet.json
    for (const [botId, entry] of Object.entries(fleet)) {
      if (entry.status !== 'onduty') continue;
      const env = (() => { try { return loadProfileEnv(root, botId); } catch { return null; } })();
      const room = (env?.MAIN_GROUP_NAME || '').toLowerCase();
      const jid = roomNameToJid[room];
      if (!jid) continue;
      const name = env?.ASSISTANT_NAME || botId;
      if (!roomRoster[jid]) roomRoster[jid] = new Map();
      roomRoster[jid].set(name, entry.rank ?? 99);
    }
    // Determine CO for each room (lowest rank)
    for (const [jid, roster] of Object.entries(roomRoster)) {
      let coBotName: string | undefined;
      let coRank = Infinity;
      for (const [name, rank] of roster) {
        if (rank < coRank) { coBotName = name; coRank = rank; }
      }
      roomCO[jid] = coBotName;
      if (coBotName === ASSISTANT_NAME) {
        initialBadge = '⭐';
        process.env.IS_CO = 'true';
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to read fleet.json for initial CO badge');
  }

  // Create Matrix channel
  let matrix: MatrixChannel | null = null;
  if (
    MATRIX_HOMESERVER &&
    (MATRIX_ACCESS_TOKEN || (MATRIX_USERNAME && MATRIX_PASSWORD))
  ) {
    matrix = new MatrixChannel({
      displayName: botDisplayName(initialBadge),
      onMessage: (_chatJid, msg) => {
        const safeMsg = normalizeInboundMessage(msg);
        if (!safeMsg) {
          logger.warn({ chatJid: msg.chat_jid, sender: msg.sender, id: msg.id }, 'Dropped invalid inbound Matrix message');
          return;
        }
        if (safeMsg.content.trim().startsWith('!')) return; // operator commands — relay handles via intercom
        handleLifecycleMessage(safeMsg);
        storeMessage(safeMsg);
        if (safeMsg.id && safeMsg.id.startsWith('$')) {
          const group = registeredGroups[safeMsg.chat_jid];
          if (group) updateEventIdFile(group.folder, 'lastReceived', safeMsg.id);
        }
      },
      onChatMetadata: (chatJid, timestamp, name) => {
        storeChatMetadata(chatJid, timestamp, name);
      },
      registeredGroups: () => registeredGroups,
    });
    matrixRef = matrix;
  }

  let localCli: LocalCliChannel | null = null;
  if (LOCAL_CHANNEL_ENABLED) {
    localCli = new LocalCliChannel({
      onMessage: (_chatJid, msg) => {
        const safeMsg = normalizeInboundMessage(msg);
        if (!safeMsg) {
          logger.warn({ chatJid: msg.chat_jid, sender: msg.sender, id: msg.id }, 'Dropped invalid inbound local message');
          return;
        }
        if (safeMsg.content.trim().startsWith('!')) return; // operator commands — relay handles via intercom
        storeMessage(safeMsg);
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
    setChannels(allChannels.filter((ch): ch is Channel => ch != null && ch.isConnected()));
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
              const mainJid = getMainChatJid(registeredGroups);
              if (mainJid) {
                const label = reconnectCount > 1
                  ? statusMessage('🔌', `reconnected (${reconnectCount}x).`)
                  : statusMessage('🔌', 'reconnected.');
                if (reconnectEventId) {
                  matrix.editMessage(mainJid, reconnectEventId, label).catch((err) => { logger.warn({ mainJid, err }, 'Reconnect edit failed'); });
                } else {
                  const id = await matrix.sendMessageReturningId(mainJid, label).catch((err) => { logger.warn({ mainJid, err }, 'Reconnect send failed'); return undefined; });
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
    if (heapLimitBytes > 0 && usage.heapUsed > heapLimitBytes) {
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

  // Prune stale in-memory thread maps every 30 minutes (entries older than 6 hours)
  const STALE_THREAD_TTL = 6 * 60 * 60 * 1000;
  const STALE_THREAD_CHECK = 30 * 60 * 1000;
  persistentTimers.push(setInterval(() => {
    const now = Date.now();
    let pruned = 0;
    for (const jid of Object.keys(workThreadIds)) {
      if (!threadMapLastSeen[`w:${jid}`]) threadMapLastSeen[`w:${jid}`] = now;
      if (now - threadMapLastSeen[`w:${jid}`] > STALE_THREAD_TTL) {
        delete workThreadIds[jid];
        delete threadMapLastSeen[`w:${jid}`];
        pruned++;
      }
    }
    for (const jid of Object.keys(activeReplyThreadIds)) {
      if (!threadMapLastSeen[`r:${jid}`]) threadMapLastSeen[`r:${jid}`] = now;
      if (now - threadMapLastSeen[`r:${jid}`] > STALE_THREAD_TTL) {
        delete activeReplyThreadIds[jid];
        delete threadMapLastSeen[`r:${jid}`];
        pruned++;
      }
    }
    for (const jid of Object.keys(progressToolCallThreadIds)) {
      if (!threadMapLastSeen[`p:${jid}`]) threadMapLastSeen[`p:${jid}`] = now;
      if (now - threadMapLastSeen[`p:${jid}`] > STALE_THREAD_TTL) {
        delete progressToolCallThreadIds[jid];
        delete threadMapLastSeen[`p:${jid}`];
        pruned++;
      }
    }
    for (const key of Object.keys(triggerAckByMessageKey)) {
      if (now - triggerAckByMessageKey[key] > STALE_THREAD_TTL) {
        delete triggerAckByMessageKey[key];
        pruned++;
      }
    }
    if (pruned > 0) logger.info({ pruned }, 'Pruned stale thread map entries');
  }, STALE_THREAD_CHECK));

  // Periodic status snapshot
  const STATUS_SNAPSHOT_INTERVAL = 30_000;
  const appendMetricsHistory = () => {
    try {
      const ts = Date.now();
      const usage = process.memoryUsage();
      const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
      const rssMB = Math.round(usage.rss / 1024 / 1024);
      const metrics = {
        ts,
        groups: Object.entries(registeredGroups).map(([jid, g]) => {
          const queueStatus = queue.getGroupStatus(jid);
          const activity = getChatActivity(jid) || {};
          const consecutiveKills = kill137Consecutive[jid] || 0;
          const cooldownUntil = kill137CooldownUntil[jid] || 0;
          return {
            jid,
            name: g.name,
            kills137: consecutiveKills,
            killCooldownActive: cooldownUntil > ts,
            consecutiveKills,
            pendingMessages: queueStatus.pendingMessages,
            pendingTasks: queueStatus.pendingTasks,
            active: queueStatus.active,
            lastErrorAt: activity.lastErrorAt ?? null,
          };
        }),
        heapMB,
        rssMB,
      };

      const existing = fs.existsSync(METRICS_HISTORY_FILE)
        ? fs.readFileSync(METRICS_HISTORY_FILE, 'utf-8')
        : '';
      const lines = existing
        .split('\n')
        .filter((line) => line.length > 0);
      lines.push(JSON.stringify(metrics));

      const trimmed = lines.length > METRICS_HISTORY_MAX_LINES
        ? lines.slice(-METRICS_HISTORY_MAX_LINES)
        : lines;
      const tmpPath = `${METRICS_HISTORY_FILE}.tmp`;
      fs.writeFileSync(tmpPath, `${trimmed.join('\n')}\n`);
      fs.renameSync(tmpPath, METRICS_HISTORY_FILE);
    } catch (err) {
      logger.warn({ err }, 'Failed to append metrics history');
    }
  };

  const writeStatusSnapshot = () => {
    try {
      const snapshot = {
        timestamp: new Date().toISOString(),
        bot: ASSISTANT_NAME,
        role: ASSISTANT_ROLE,
        model: mainLlm,
        provider: MAIN_PROVIDER,
        brainModes: Object.fromEntries(
          getActiveBots().map((b) => [b, readBrainMode(b)])
        ),
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

      // Add verification summary to snapshot
      const vPath = path.join(process.cwd(), '_runtime', 'data', 'verifications.json');
      try {
        if (fs.existsSync(vPath)) {
          const vRecords = JSON.parse(fs.readFileSync(vPath, 'utf-8')) as Array<{ status: string }>;
          const pending = vRecords.filter((v) => v.status === 'pending').length;
          const verified = vRecords.filter((v) => v.status === 'verified').length;
          const failed = vRecords.filter((v) => v.status === 'failed').length;
          (snapshot as Record<string, unknown>).verifications = { pending, verified, failed, total: vRecords.length };
        }
      } catch { /* ok */ }

      for (const g of Object.values(registeredGroups)) {
        const ipcDir = path.join(DATA_DIR, 'ipc', g.folder);
        if (!fs.existsSync(ipcDir)) continue;
        const statusPath = path.join(ipcDir, 'status.json');
        const tmpPath = `${statusPath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2));
        fs.renameSync(tmpPath, statusPath);
      }

      appendMetricsHistory();
    } catch (err) {
      logger.warn({ err }, 'Failed to write status snapshot');
    }
  };
  writeStatusSnapshot();
  persistentTimers.push(setInterval(writeStatusSnapshot, STATUS_SNAPSHOT_INTERVAL));

  // Export conversation history to S3 every 15 minutes
  const HISTORY_EXPORT_INTERVAL = 15 * 60 * 1000;
  persistentTimers.push(setInterval(() => {
    void exportHistoryToS3(DATA_DIR, ASSISTANT_NAME, registeredGroups).catch((err) => {
      logger.warn({ err }, 'History export error');
    });
  }, HISTORY_EXPORT_INTERVAL));

  // Start subsystems
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    runContainerAgent,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid: string, rawText: string) => {
      const ch = findChannel(jid);
      if (!ch) return;
      const text = stripInternalTags(rawText);
      if (text) {
        await ch.sendMessage(jid, text);
        storeOutgoing(jid, text);
      }
    },
  });
  startIpcWatcher({
    // TODO: Keep merge_request routing here while IPC task parsing lives in src/ipc-watcher.ts.
    sendMessage: async (jid, text, threadId) => {
      const ch = findChannel(jid);
      if (!ch) {
        logger.warn({ jid }, 'No channel found for IPC message');
        return;
      }
      await ch.sendMessage(jid, text, threadId);
      storeOutgoing(jid, text, threadId);
    },
    sendMessageReturningId: async (jid, text, threadId) => {
      const ch = findChannel(jid);
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
      const ch = findChannel(jid);
      if (ch?.sendImage) return ch.sendImage(jid, buffer, filename, mimetype, caption);
      logger.warn({ jid }, 'No channel with image support found for IPC image');
      return Promise.resolve();
    },
    sendFile: (jid, buffer, filename, mimetype, caption) => {
      const ch = findChannel(jid);
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
        threadMapLastSeen[`w:${chatJid}`] = Date.now();
      } else {
        delete workThreadIds[chatJid];
        delete threadMapLastSeen[`w:${chatJid}`];
      }
      // Mirror work thread state into last_event_ids.json so containers can
      // read and restore it around delegate_to_lobe calls.
      const group = registeredGroups[chatJid];
      if (group) {
        const idsFile = path.join(DATA_DIR, 'ipc', group.folder, 'last_event_ids.json');
        try {
          let existing: Record<string, string> = {};
          if (fs.existsSync(idsFile)) existing = JSON.parse(fs.readFileSync(idsFile, 'utf-8'));
          if (threadId) {
            existing.workThreadId = threadId;
          } else {
            delete existing.workThreadId;
          }
          fs.writeFileSync(idsFile, JSON.stringify(existing, null, 2));
        } catch (err) { logger.debug({ chatJid, err }, 'Failed to write workThread to IPC file'); }
      }
    },
    syncGroups: async () => { },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
    writeLastEventId: (sourceGroup, eventId) => updateEventIdFile(sourceGroup, 'lastSent', eventId),
    onMergeRequest: handleMergeRequest,
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
  // Start message loop (blocks on resumeGate until resume finishes)
  startMessageLoop();
  // Resume flow: inject messages, run resume container, wait delay, then open gate
  await injectResumeMessage();

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

  // Idle pip — change display name pip after prolonged inactivity
  persistentTimers.push(setInterval(() => {
    if (idlePipActive) return;
    if (Date.now() - lastActivityAt < IDLE_PIP_THRESHOLD_MS) return;
    idlePipActive = true;
    for (const [jid] of Object.entries(registeredGroups)) {
      const ch = findChannel(jid);
      if (ch?.setStatusPip) {
        void ch.setStatusPip(jid, '💤').catch((err) => { logger.debug({ jid, err }, 'Idle pip set failed'); });
      }
    }
    logger.info({ thresholdMs: IDLE_PIP_THRESHOLD_MS }, 'Bot idle — pip set to 💤');
  }, IDLE_PIP_CHECK_MS));

  // Set presence on startup (boot announcement is handled by the relay/intercom)
  const presenceTimer = setInterval(async () => {
    const mainJid = getMainChatJid(registeredGroups);
    if (!mainJid) return;
    const ch = findChannel(mainJid);
    if (!ch) return;
    clearInterval(presenceTimer);
    try {
      if (ch.setPresenceStatus) await ch.setPresenceStatus('online', 'idle');
    } catch (err) {
      logger.warn({ err }, 'Failed to set presence');
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
