/**
 * InfiniClaw orchestrator entry point.
 * Composes upstream NanoClaw reusable pieces with InfiniClaw-specific logic.
 */
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
  HEAP_LIMIT_MB,
  MAIN_GROUP_FOLDER,
  MEMORY_CHECK_INTERVAL,
  RESUME_DELAY_SECONDS,
} from './infini-config.js';
import {
  botParticipatesInThread,
  getMessagesSince,
  getNewMessages,
  getRecentMessages,
  getThreadMessages,
  initDatabase,
  setSession,
  storeChatMetadata,
  storeMessage,
} from 'nanoclaw/db.js';
import { GroupQueue } from 'nanoclaw/group-queue.js';
import {
  ContainerOutput,
  writeGroupsSnapshot,
} from 'nanoclaw/container-runner.js';
import {
  recoverPendingMessages,
  writeAgentSnapshots,
  wrapOnOutputForSession,
} from 'nanoclaw/composables.js';
import { formatMessages, formatThreadContext, stripInternalTags } from 'nanoclaw/router.js';
import { startSchedulerLoop } from 'nanoclaw/task-scheduler.js';
import { pruneExpired } from './allow-list.js';
import { setChannels, findChannel, getMainChatJid } from './channel-manager.js';
import {
  resolveRoot,
} from './utils.js';
import { getGitVersion, esc } from './formatting.js';
import { fleetManager } from './fleet-manager.js';
import { matrixService } from './matrix-service.js';

import {
  MAIN_PROVIDER,
  mainLlm,
  defaultSenderForGroup,
  maybeAutoSwitchBrainsOnQuotaError,
} from './llm-service.js';
import {
  setObjectiveFromMessages,
  markRunStarted,
  markRunEnded,
  markProgress,
  markCompletion,
  markError,
  buildMainMissionContext,
  getChatActivity,
} from './chat-activity-service.js';
import { shouldIgnoreMessage, normalizeInboundMessage } from './message-filtering.js';
import { appendConversationLog } from './conversation-log.js';
import { uploadHtml } from './s3-sync.js';
import { exportHistoryToS3 } from './history-export.js';
import { toolCallBreadcrumb } from './chat-activity-service.js';

import { runContainerAgent } from './container-spawn.js';
import { startIpcWatcher } from './ipc-watcher.js';
import { readBrainMode } from './ipc-commands.js';
import { getActiveBots, loadProfileEnv } from './service.js';

import { botMatrixUserIds, setBotMatrixUserIds, botDisplayName } from './bot-manager.js';

import { bootstrapSystem } from './bootstrap.js';
import { setupMatrixChannel, setupLocalCliChannel } from './channel-setup.js';
import { setupShutdownHandlers } from './shutdown-handler.js';
import {
  lastTimestamp,
  lastAgentTimestamp,
  sessions,
  registeredGroups,
  loadState,
  saveState,
  registerGroup,
  unregisterGroup,
  getAvailableGroups,
  updateLastTimestamp,
  updateLastAgentTimestamp,
} from './state-service.js';
import { NewMessage, Channel } from 'nanoclaw/types.js';

// ── Git version info ──
const GIT_VERSION = getGitVersion(resolveRoot());

// ── Internal state ──
let messageLoopRunning = false;
const PROGRESS_CHAT_COOLDOWN_MS = 10_000;
const lastProgressChatAt: Record<string, number> = {};
const workThreadIds: Record<string, string> = {};
const activeReplyThreadIds: Record<string, string | undefined> = {};
const progressToolCallThreadIds: Record<string, string | undefined> = {};
const threadMapLastSeen: Record<string, number> = {};
const triggerAckByMessageKey: Record<string, number> = {};
let resumeGateResolve: (() => void) | null = null;
const resumeGate = new Promise<void>((resolve) => { resumeGateResolve = resolve; });
let isResuming = false;
let matrixRef: any = null;

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
function resolveReplyThread(chatJid: string, messages: NewMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.thread_id && !botMatrixUserIds.has(m.sender)) return m.thread_id;
  }
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.thread_id) return lastMsg.thread_id;
  if (workThreadIds[chatJid]) {
    threadMapLastSeen[`w:${chatJid}`] = Date.now();
    return workThreadIds[chatJid];
  }
  return undefined;
}

// Exit-137 (SIGKILL) backoff
const KILL_137_COOLDOWN_MS = parseInt(process.env.KILL_137_COOLDOWN_MS || '60000', 10);
const KILL_137_MAX_CONSECUTIVE = parseInt(process.env.KILL_137_MAX_CONSECUTIVE || '3', 10);
const kill137Consecutive: Record<string, number> = {};
const kill137CooldownUntil: Record<string, number> = {};

// Idle tracking
let lastActivityAt = Date.now();
let idlePipActive = false;

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

export function updateEventIdFile(groupFolder: string, key: 'lastSent' | 'lastReceived', eventId: string): void {
  const idsFile = path.join(DATA_DIR, 'ipc', groupFolder, 'last_event_ids.json');
  try {
    let existing: Record<string, string> = {};
    if (fs.existsSync(idsFile)) existing = JSON.parse(fs.readFileSync(idsFile, 'utf-8'));
    existing[key] = eventId;
    existing[`${key}At`] = new Date().toISOString();
    fs.writeFileSync(idsFile, JSON.stringify(existing, null, 2));
  } catch (err) { logger.debug({ groupFolder, key, err }, 'Failed to update event ID file'); }
}

let outgoingSeq = 0;
function storeOutgoing(chatJid: string, text: string, threadId?: string): void {
  storeChatMetadata(chatJid, new Date().toISOString());
  storeMessage({
    id: `out-${Date.now()}-${++outgoingSeq}`,
    chat_jid: chatJid,
    sender: ASSISTANT_NAME,
    sender_name: ASSISTANT_NAME,
    content: text,
    timestamp: new Date().toISOString(),
    is_from_me: true,
    thread_id: threadId,
  });
}

const queue = new GroupQueue();

interface OutputHandlerContext {
  chatJid: string;
  group: any;
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
        if (!acknowledged && ctx.inboundMessageIds.length > 0) { acknowledged = true; ctx.onAcknowledge(); }
        ctx.onProgress(text);
        if (result.isProgress) handleProgressOutput(ctx, text);
        else {
          const dedupKey = text.replace(/\s+/g, ' ').trim();
          if (dedupKey === lastSentResultText) consecutiveDupSent++;
          else { consecutiveDupSent = 0; lastSentResultText = dedupKey; }
          if (consecutiveDupSent < 2) await handleResultOutput(ctx, text);
        }
      }
      ctx.resetIdleTimer();
    }
    if (result.status === 'success') queue.notifyIdle(ctx.chatJid);
    if (result.status === 'error') ctx.onError();
  };
}

async function getOrCreateToolThread(ctx: OutputHandlerContext, ch: Channel): Promise<string | undefined> {
  const existingId = progressToolCallThreadIds[ctx.chatJid];
  if (existingId) return existingId;
  if (!ch.sendMessageReturningId) return undefined;
  try {
    const anchorId = await ch.sendMessageReturningId(ctx.chatJid, '<font color="#888888"><em>🔧 Tool calls</em></font>');
    if (anchorId) {
      progressToolCallThreadIds[ctx.chatJid] = anchorId;
      threadMapLastSeen[`p:${ctx.chatJid}`] = Date.now();
    }
    return anchorId;
  } catch (err) {
    logger.warn({ chatJid: ctx.chatJid, err }, 'Failed to open tool call thread anchor');
    return undefined;
  }
}

async function sendToolCallToMainTimeline(ctx: OutputHandlerContext, ch: Channel, toolCallHtml: string): Promise<void> {
  threadMapLastSeen[`p:${ctx.chatJid}`] = Date.now();
  const threadId = await getOrCreateToolThread(ctx, ch);
  try {
    if (threadId) await ch.sendMessage(ctx.chatJid, toolCallHtml, threadId);
    else await ch.sendMessage(ctx.chatJid, toolCallHtml);
  } catch (err) {
    logger.warn({ chatJid: ctx.chatJid, err }, 'Failed to send tool call progress');
  }
}

function handleToolCallProgress(ctx: OutputHandlerContext, text: string, ch: Channel): void {
  const group = registeredGroups[ctx.chatJid];
  const groupName = group?.name ?? ctx.chatJid;
  const threadId = activeReplyThreadIds[ctx.chatJid];
  const contextMessages = threadId ? getThreadMessages(ctx.chatJid, threadId, 20) : getRecentMessages(ctx.chatJid, ASSISTANT_NAME, 10).reverse();
  const bc = toolCallBreadcrumb(text, contextMessages, groupName);
  void uploadHtml(bc.s3Key, bc.pageHtml).catch((err) => logger.warn({ err }, 'Failed to upload tool call to S3'));
  
  threadMapLastSeen[`r:${ctx.chatJid}`] = Date.now();
  const activeThread = activeReplyThreadIds[ctx.chatJid];
  if (activeThread) void ch.sendMessage(ctx.chatJid, bc.html, activeThread);
  else void sendToolCallToMainTimeline(ctx, ch, bc.html);
}

function handleProgressOutput(ctx: OutputHandlerContext, text: string): void {
  markProgress(ctx.chatJid, text);
  const isToolCall = text.includes('<details>');
  const now = Date.now();
  if (isToolCall || !lastProgressChatAt[ctx.chatJid] || now - lastProgressChatAt[ctx.chatJid] >= PROGRESS_CHAT_COOLDOWN_MS) {
    if (!isToolCall) lastProgressChatAt[ctx.chatJid] = now;
    const ch = findChannel(ctx.chatJid);
    if (ch) {
      if (isToolCall) handleToolCallProgress(ctx, text, ch);
      else void ch.sendMessage(ctx.chatJid, `<small><em>${esc(text)}</em></small>`, activeReplyThreadIds[ctx.chatJid]);
    }
  }
}

async function handleResultOutput(ctx: OutputHandlerContext, text: string): Promise<void> {
  markProgress(ctx.chatJid, text);
  ctx.onOutputSent(text);
  const ch = findChannel(ctx.chatJid);
  if (ch) {
    await matrixService.setTyping(ctx.chatJid, true);
    try {
      threadMapLastSeen[`r:${ctx.chatJid}`] = Date.now();
      const threadId = activeReplyThreadIds[ctx.chatJid];
      const sentId = ch.sendMessageReturningId ? await ch.sendMessageReturningId(ctx.chatJid, text, threadId) : await ch.sendMessage(ctx.chatJid, text, threadId);
      threadMapLastSeen[`r:${ctx.chatJid}`] = Date.now();
      storeOutgoing(ctx.chatJid, text, threadId);
      if (sentId && registeredGroups[ctx.chatJid]) updateEventIdFile(registeredGroups[ctx.chatJid].folder, 'lastSent', sentId);
    } finally { await matrixService.setTyping(ctx.chatJid, false); }
  }
}

async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group || (kill137CooldownUntil[chatJid] || 0) > Date.now()) return true;
  const channel = findChannel(chatJid);
  if (!channel) return true;

  const missed = getMessagesSince(chatJid, lastAgentTimestamp[chatJid] || '', ASSISTANT_NAME);
  if (missed.length === 0) return true;
  const filtered = missed.filter(m => !shouldIgnoreMessage(m, botMatrixUserIds));
  if (filtered.length === 0) return true;

  const actionable = filtered.filter(m => !/^!operator\b/i.test(m.content.trim()) && (!botMatrixUserIds.has(m.sender) || TRIGGER_PATTERN.test(m.content.trim())));
  if (actionable.length === 0) { updateLastAgentTimestamp(chatJid, missed[missed.length - 1].timestamp); saveState(); return true; }

  const hasTrigger = actionable.some(m => TRIGGER_PATTERN.test(m.content.trim()));
  const hasThread = actionable.some(m => m.thread_id && botParticipatesInThread(chatJid, m.thread_id));
  if (!hasTrigger && !hasThread && !isCOMainTimelineTrigger(chatJid, actionable)) {
    updateLastAgentTimestamp(chatJid, missed[missed.length - 1].timestamp); saveState(); return true;
  }

  const contextMessages = filtered.filter(m => !m.thread_id || botParticipatesInThread(chatJid, m.thread_id) || TRIGGER_PATTERN.test(m.content.trim()));
  sendTriggerAck(chatJid, contextMessages);
  setObjectiveFromMessages(chatJid, contextMessages);
  activeReplyThreadIds[chatJid] = resolveReplyThread(chatJid, contextMessages);
  
  const prompt = [group.folder === MAIN_GROUP_FOLDER ? buildMainMissionContext(chatJid) : undefined, formatMessages(contextMessages)].filter(Boolean).join('\n\n');
  const prevCursor = lastAgentTimestamp[chatJid] || '';
  updateLastAgentTimestamp(chatJid, missed[missed.length - 1].timestamp);
  saveState();

  let idleTimer: any = null;
  const resetIdleTimer = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => queue.closeStdin(chatJid), IDLE_TIMEOUT); };
  if (channel.setPresenceStatus) await channel.setPresenceStatus('online', 'processing...');
  lastActivityAt = Date.now(); idlePipActive = false;
  let hadError = false; let outputSent = false; const responses: string[] = []; let lastBody: string | undefined;
  markRunStarted(chatJid);

  const outputHandler = createOutputHandler({ chatJid, group, inboundMessageIds: contextMessages.map(m => m.id).filter(Boolean) as string[], onAcknowledge: () => {}, onOutputSent: (t) => { outputSent = true; lastBody = t; responses.push(t); }, onError: () => { hadError = true; }, onProgress: () => {}, resetIdleTimer });
  const runResult = await runAgent(group, prompt, chatJid, outputHandler);
  
  delete workThreadIds[chatJid]; delete progressToolCallThreadIds[chatJid];
  if (channel.setTyping) await channel.setTyping(chatJid, false);
  if (channel.setPresenceStatus) await channel.setPresenceStatus('online', 'idle');
  if (channel.setStatusPip) void channel.setStatusPip(chatJid, '🟢');
  if (idleTimer) clearTimeout(idleTimer);

  if (runResult.status === 'error' || hadError) {
    const rawError = runResult.error || 'error';
    await maybeAutoSwitchBrainsOnQuotaError(rawError, chatJid, async (jid, t) => { const ch = findChannel(jid); if (ch) await ch.sendMessage(jid, t); });
    markError(chatJid, rawError.slice(0, 1000));
    if (!outputSent) { await channel.sendMessage(chatJid, `Error: ${rawError.slice(0, 500)}`, activeReplyThreadIds[chatJid]); outputSent = true; }
    if (outputSent) { appendConversationLog(group.folder, missed, responses, channel.name); markRunEnded(chatJid); return true; }
    updateLastAgentTimestamp(chatJid, prevCursor); saveState(); markRunEnded(chatJid); return false;
  }
  if (lastBody) markCompletion(chatJid, lastBody);
  markRunEnded(chatJid);
  appendConversationLog(group.folder, missed, responses, channel.name);
  return true;
}

async function runAgent(group: any, prompt: string, chatJid: string, onOutput?: any): Promise<any> {
  writeAgentSnapshots(group.folder, group.folder === MAIN_GROUP_FOLDER, registeredGroups, getAvailableGroups);
  const wrappedOnOutput = wrapOnOutputForSession(sessions, group.folder, onOutput);
  try {
    const output = await runContainerAgent(group, { prompt, sessionId: sessions[group.folder], groupFolder: group.folder, chatJid, isMain: group.folder === MAIN_GROUP_FOLDER }, (p, n) => queue.registerProcess(chatJid, p, n, group.folder), wrappedOnOutput);
    if (output.newSessionId && output.status !== 'error') { sessions[group.folder] = output.newSessionId; setSession(group.folder, output.newSessionId); }
    return output;
  } catch (err) { return { status: 'error', error: String(err) }; }
}

async function handleGroupMessagesInLoop(chatJid: string, groupMessages: NewMessage[]): Promise<void> {
  const group = registeredGroups[chatJid];
  if (!group) return;
  const filtered = groupMessages.filter(m => !shouldIgnoreMessage(m, botMatrixUserIds));
  if (filtered.length === 0) return;
  const actionable = filtered.filter(m => !botMatrixUserIds.has(m.sender) || TRIGGER_PATTERN.test(m.content.trim()));
  if (actionable.length === 0) { updateLastAgentTimestamp(chatJid, groupMessages[groupMessages.length - 1].timestamp); saveState(); return; }
  if (!actionable.some(m => TRIGGER_PATTERN.test(m.content.trim())) && !isCOMainTimelineTrigger(chatJid, actionable)) {
    updateLastAgentTimestamp(chatJid, groupMessages[groupMessages.length - 1].timestamp); saveState(); return;
  }
  const allPending = getMessagesSince(chatJid, lastAgentTimestamp[chatJid] || '', ASSISTANT_NAME).filter(m => !shouldIgnoreMessage(m, botMatrixUserIds));
  const messagesToSend = allPending.length > 0 ? allPending : filtered;
  sendTriggerAck(chatJid, messagesToSend);
  setObjectiveFromMessages(chatJid, messagesToSend);
  activeReplyThreadIds[chatJid] = resolveReplyThread(chatJid, messagesToSend);
  if (queue.getGroupStatus(chatJid).active && messagesToSend.some(m => !botMatrixUserIds.has(m.sender))) {
    const inputDir = path.join(DATA_DIR, 'ipc', group.folder, 'input');
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, `message-${Date.now()}.json`), JSON.stringify({ type: 'message', text: formatMessages(messagesToSend) }));
    updateLastAgentTimestamp(chatJid, messagesToSend[messagesToSend.length - 1].timestamp); saveState();
    return;
  }
  queue.enqueueMessageCheck(chatJid);
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) return; messageLoopRunning = true; await resumeGate;
  while (true) {
    try {
      const { messages, newTimestamp } = getNewMessages(Object.keys(registeredGroups), lastTimestamp, ASSISTANT_NAME);
      if (messages.length > 0) {
        updateLastTimestamp(newTimestamp); saveState();
        const byChat = groupMessagesByChat(messages);
        for (const [chatJid, groupMessages] of byChat) await handleGroupMessagesInLoop(chatJid, groupMessages);
      }
    } catch (err) { logger.error({ err }, 'Loop error'); }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

function handleMergeRequest(payload: any): void {
  const mainJid = getMainChatJid(registeredGroups);
  if (mainJid) {
    storeMessage({ id: `system-${Date.now()}`, chat_jid: mainJid, sender: 'system', sender_name: 'System', content: `[System] Thread ${payload.threadId} merged.`, timestamp: new Date().toISOString() });
    queue.enqueueMessageCheck(mainJid);
  }
}

import { injectResumeMessage as serviceInjectResumeMessage } from './recovery-service.js';
async function injectResumeMessage(): Promise<void> {
  isResuming = true;
  await serviceInjectResumeMessage(registeredGroups, queue, processGroupMessages, RESUME_DELAY_SECONDS, resumeGateResolve!);
  isResuming = false;
}

async function main(): Promise<void> {
  await bootstrapSystem(); loadState();
  const timers: any[] = [];
  setupShutdownHandlers(timers, registeredGroups, queue, matrixRef);
  const { initialBadge } = fleetManager.determineInitialCO(registeredGroups, ASSISTANT_NAME);
  const matrix = setupMatrixChannel(initialBadge, registeredGroups, handleLifecycleMessage);
  matrixRef = matrix; if (matrix) matrixService.setMatrix(matrix);
  const localCli = setupLocalCliChannel(matrix);
  const allChannels = [localCli, matrix];
  const refresh = () => setChannels(allChannels.filter((ch: any) => ch != null && ch.isConnected()));
  if (localCli) { try { await localCli.connect(); } catch { } refresh(); }
  if (matrix) { try { await matrix.connect(); } catch { } refresh(); }
  timers.push(setInterval(() => { if (HEAP_LIMIT_MB > 0 && process.memoryUsage().heapUsed > HEAP_LIMIT_MB * 1024 * 1024) process.exit(1); }, MEMORY_CHECK_INTERVAL));
  timers.push(setInterval(() => pruneExpired(), 5 * 60 * 1000));
  timers.push(setInterval(() => { void exportHistoryToS3(DATA_DIR, ASSISTANT_NAME, registeredGroups).catch(() => {}); }, 15 * 60 * 1000));
  startSchedulerLoop({ registeredGroups: () => registeredGroups, getSessions: () => sessions, queue, runContainerAgent, onProcess: (jid, p, n, gf) => queue.registerProcess(jid, p, n, gf), sendMessage: async (jid, t) => { const ch = findChannel(jid); if (ch) { const stripped = stripInternalTags(t); if (stripped) { await ch.sendMessage(jid, stripped); storeOutgoing(jid, stripped); } } } });
  startIpcWatcher({ sendMessage: async (jid, t, tid) => { const ch = findChannel(jid); if (ch) { await ch.sendMessage(jid, t, tid); storeOutgoing(jid, t, tid); } }, sendMessageReturningId: async (jid, t, tid) => { const ch = findChannel(jid); if (ch?.sendMessageReturningId) { const id = await ch.sendMessageReturningId(jid, t, tid); storeOutgoing(jid, t, tid); return id; } storeOutgoing(jid, t, tid); return undefined; }, defaultSenderForGroup: (sg) => defaultSenderForGroup(sg, registeredGroups), sendImage: (jid, b, fn, mt, cap) => findChannel(jid)?.sendImage?.(jid, b, fn, mt, cap), sendFile: (jid, b, fn, mt, cap) => findChannel(jid)?.sendFile?.(jid, b, fn, mt, cap), registeredGroups: () => registeredGroups, registerGroup, unregisterGroup, setWorkThread: (jid, tid) => { if (tid) workThreadIds[jid] = tid; else delete workThreadIds[jid]; }, syncGroups: async () => {}, getAvailableGroups, writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj), writeLastEventId: (sg, eid) => updateEventIdFile(sg, 'lastSent', eid), onMergeRequest: handleMergeRequest });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages({ registeredGroups, lastAgentTimestamp, assistantName: ASSISTANT_NAME, enqueueCheck: (jid) => queue.enqueueMessageCheck(jid) });
  startMessageLoop(); await injectResumeMessage();
}

if (process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname) {
  main().catch((err) => { logger.error({ err }, 'Failed'); process.exit(1); });
}
