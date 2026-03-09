/**
 * InfiniClaw orchestrator entry point.
 * Composes upstream NanoClaw reusable pieces with InfiniClaw-specific logic.
 *
 * Upstream files (index.ts, container-runner.ts, ipc.ts) are read-only
 * dependencies — never modified by InfiniClaw.
 */
import { exec } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import './nanoclaw-patches.js';
import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
  TIMEZONE,
} from 'nanoclaw/config.js';
import {
  ASSISTANT_ROLE,
  CAPTAIN_USER_ID,
  HEAP_LIMIT_MB,
  MAIN_GROUP_FOLDER,
  MAIN_BRAIN_TURN_TIMEOUT_MS,
  MAIN_BRAIN_TOOL_LIMIT,
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
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getSession,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  updateChatName,
} from 'nanoclaw/db.js';
import {
  botParticipatesInThread,
  deleteRegisteredGroup,
  deleteSession,
  getRecentMessages,
  getThreadMessages,
  storeMessage,
  initDatabaseExt,
} from './db-ext.js';
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
} from './composables.js';
import { pruneExpired } from './allow-list.js';
import { MatrixChannel } from './channels/matrix.js';
import { findChannel, formatMessages, stripInternalTags } from 'nanoclaw/router.js';
import { formatThreadContext } from './router-ext.js';
import { collectBotMatrixUserIds } from './service.js';
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
import { statusMessage, escapeHtml } from './formatting.js';
import { ensureContainerSystemRunning } from './podman-bootstrap.js';
import { uploadContent, uploadHtml, getPresignedUrl } from './s3-sync.js';
import { errStr } from './utils.js';
import { exportHistoryToS3 } from './history-export.js';

import { GIT_VERSION } from './version.js';
import { runContainerAgent } from './container-spawn.js';
import { startIpcWatcher } from './ipc-watcher.js';
import { readBrainMode } from './ipc-commands.js';
import { getActiveBots, loadProfileEnv, resolveRoot } from './service.js';
import { loadFleet } from './ship-config.js';
import { buildTodoMessage, readTodoItems } from './todo.js';

// ── Display name helper ────────────────────────────────────────────────
const BOT_LOCATION = os.hostname().toUpperCase();
function botDisplayName(badge: string): string {
  return `${ASSISTANT_NAME} ${badge} (${BOT_LOCATION})`;
}

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
// Last non-tool-call progress text per chat — used as tool call thread anchor title
const lastProgressText: Record<string, string> = {};
const triggerAckByMessageKey: Record<string, number> = {};
// Dispatch enforcement: counts tool calls per main-brain turn; tracks whether
// branch_to_thread was called; tracks turns killed by timeout.
const turnToolCallCount: Record<string, number> = {};
const turnDispatchCalled: Record<string, boolean> = {};
const turnKilledByTimeout: Record<string, boolean> = {};
let resumeGateResolve: (() => void) | null = null;
const resumeGate = new Promise<void>((resolve) => { resumeGateResolve = resolve; });
let isResuming = false;

// ── CO roster (initialized from fleet.json at startup, updated via lifecycle messages) ──
const roomRoster: Record<string, Map<string, number>> = {};
const roomCO: Record<string, string | undefined> = {};
let matrixRef: MatrixChannel | null = null;
// Quarters room JID — in this room, every message is for the bot (no trigger needed)
let quartersJid: string | null = null;

/** Parse relay lifecycle messages to update CO roster at runtime. */
function handleLifecycleMessage(msg: { content: string; chat_jid: string; sender: string }): boolean {
  // Relay messages: "HOSTNAME: Name stopped" / "HOSTNAME: Name started (rank N)" / "HOSTNAME: Name restarted" / "HOSTNAME: Name reranked (rank N)"
  const match = msg.content.match(/^\S+: (\S+) (stopped|started|restarted|reranked)(?:\s+\(rank (\d+)\))?$/);
  if (!match) return false;
  // Only process messages from intercom accounts (relay sends via intercom)
  if (!msg.sender.includes('-intercom')) return false;

  const [, botName, action, rankStr] = match;
  const chatJid = msg.chat_jid;

  if (!roomRoster[chatJid]) roomRoster[chatJid] = new Map();

  if (action === 'stopped') {
    roomRoster[chatJid].delete(botName);
  } else if (action === 'started' || action === 'reranked') {
    const rank = rankStr ? parseInt(rankStr, 10) : 99;
    roomRoster[chatJid].set(botName, rank);
  }
  // 'restarted' = no roster change (bot stays present)

  void rerankCO(chatJid);
  return false; // don't consume — still store the message for context
}

/** Recalculate CO for a room and update display name badge. */
async function rerankCO(chatJid: string): Promise<void> {
  const roster = roomRoster[chatJid];
  if (!roster || roster.size === 0) { roomCO[chatJid] = undefined; return; }

  // Lowest rank = CO
  let coBotName: string | undefined;
  let coRank = Infinity;
  for (const [name, rank] of roster) {
    if (rank < coRank) { coBotName = name; coRank = rank; }
  }

  const previousCO = roomCO[chatJid];
  roomCO[chatJid] = coBotName;

  if (!matrixRef) return;

  if (coBotName === ASSISTANT_NAME && previousCO !== ASSISTANT_NAME) {
    // This bot was promoted to CO
    process.env.IS_CO = 'true';
    await matrixRef.setDisplayName(botDisplayName('⭐'));
  } else if (previousCO === ASSISTANT_NAME && coBotName !== ASSISTANT_NAME) {
    // This bot was demoted from CO
    process.env.IS_CO = '';
    await matrixRef.setDisplayName(botDisplayName('🟢'));
  }
}

/** Check if this bot is CO and there's an unaddressed human message on the main timeline. */
function isCOMainTimelineTrigger(chatJid: string, messages: NewMessage[]): boolean {
  if (roomCO[chatJid] !== ASSISTANT_NAME) return false;
  // Build patterns for all known bot names in this room
  const roster = roomRoster[chatJid];
  const botNamePatterns: RegExp[] = [];
  if (roster) {
    for (const name of roster.keys()) {
      botNamePatterns.push(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
    }
  }
  return messages.some(m => {
    if (botMatrixUserIds.has(m.sender)) return false; // bot message
    if (m.thread_id) return false; // thread message, not main timeline
    const content = m.content.trim();
    // Check if any bot is addressed
    const addressesBot = botNamePatterns.some(p => p.test(content));
    return !addressesBot;
  });
}

/** Resolve which thread a response should go to. Reply where the message was. */
function resolveReplyThread(
  chatJid: string,
  messages: NewMessage[],
): string | undefined {
  // Only route to a thread if a human/operator (not an intercom relay account) explicitly
  // calls out the bot in that thread. Relay notifications (⛔ !refresh, etc.) that mention
  // the bot's name must not contaminate thread routing.
  const isRoutableHuman = (sender: string) =>
    !botMatrixUserIds.has(sender) && !sender.includes('-intercom');
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.thread_id && isRoutableHuman(m.sender) && TRIGGER_PATTERN.test(m.content.trim())) {
      return m.thread_id;
    }
  }
  // No trigger in a thread — check the last message for CO/participating-thread replies.
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.thread_id && isRoutableHuman(lastMsg.sender)) return lastMsg.thread_id;
  // Main timeline message → reply on main timeline (no auto-threading)
  // workThreadIds is NOT checked here — it controls outbound IPC routing only,
  // not where we reply to incoming messages.
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

// All bot Matrix user IDs — populated at startup from secrets env files.
// Used to distinguish human vs bot messages for response routing.
let botMatrixUserIds: Set<string> = new Set();

function isThreadContext(chatJid: string): boolean {
  threadMapLastSeen[`r:${chatJid}`] = Date.now();
  return Boolean(activeReplyThreadIds[chatJid]);
}

function sendTriggerAck(chatJid: string, messages: NewMessage[]): void {
  const ch = findChannel(channels, chatJid);
  if (!ch) return;

  if (ch.setTyping) {
    void ch.setTyping(chatJid, true).catch((err) => { logger.debug({ chatJid, err }, 'Set typing failed'); });
  }

  if (!ch.sendReaction) return;
  for (const m of messages) {
    if (!m.id) continue;
    if (/^(resume|out|system|op)-/.test(m.id)) continue;
    const key = `${chatJid}:${m.id}`;
    if (triggerAckByMessageKey[key]) continue;
    triggerAckByMessageKey[key] = Date.now();
    void ch.sendReaction(chatJid, m.id, '👀').catch((err) => { logger.debug({ chatJid, msgId: m.id, err }, 'Trigger ack reaction failed'); });
  }
}

const MAX_INBOUND_CONTENT_CHARS = 100_000;
const MAX_INBOUND_ID_CHARS = 255;
const MAX_INBOUND_SENDER_CHARS = 255;
const MAX_INBOUND_THREAD_CHARS = 255;
const MAX_INBOUND_CHAT_JID_CHARS = 255;

function isValidInboundChatJid(chatJid: string): boolean {
  if (!chatJid || chatJid.length > MAX_INBOUND_CHAT_JID_CHARS) return false;
  if (chatJid.startsWith('matrix:')) {
    const roomId = chatJid.slice('matrix:'.length);
    return /^[!#][^:\s]+:[^\s]+$/.test(roomId);
  }
  return true;
}

function isValidInboundSender(sender: string): boolean {
  if (!sender || sender.length > MAX_INBOUND_SENDER_CHARS) return false;
  if (sender.startsWith('@')) return /^@[^:\s]+:[^\s]+$/.test(sender);
  return true;
}

function normalizeInboundMessage(msg: NewMessage): NewMessage | null {
  if (!isValidInboundChatJid(msg.chat_jid)) return null;
  if (!isValidInboundSender(msg.sender)) return null;
  if (!msg.id || msg.id.length > MAX_INBOUND_ID_CHARS) return null;
  if (!msg.sender_name || msg.sender_name.length > MAX_INBOUND_SENDER_CHARS) return null;
  if (!msg.timestamp || Number.isNaN(new Date(msg.timestamp).getTime())) return null;

  const content = typeof msg.content === 'string'
    ? msg.content.slice(0, MAX_INBOUND_CONTENT_CHARS)
    : '';
  const threadId = typeof msg.thread_id === 'string' && msg.thread_id.length > 0
    ? msg.thread_id.slice(0, MAX_INBOUND_THREAD_CHARS)
    : undefined;

  return {
    ...msg,
    content,
    thread_id: threadId,
  };
}

/** Build a standalone HTML page for a tool call, with surrounding conversation context. */
function generateToolCallPage(opts: {
  toolCallHtml: string;
  botName: string;
  groupName: string;
  timestamp: number;
  contextMessages: import('nanoclaw/types.js').NewMessage[];
}): string {
  const { toolCallHtml, botName, groupName, timestamp, contextMessages } = opts;
  const dateStr = new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  const msgHtml = contextMessages.map((m) => {
    const isBot = m.is_from_me || m.is_bot_message;
    const sender = esc(m.sender_name || m.sender);
    const ts = new Date(m.timestamp).toISOString().slice(11, 19);
    const content = esc(m.content || '').replace(/\n/g, '<br>');
    return `<div class="msg ${isBot ? 'bot' : 'human'}">
      <span class="meta">${sender} <span class="ts">${ts}</span></span>
      <div class="body">${content}</div>
    </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tool call - ${esc(botName)} - ${esc(groupName)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#c9d1d9;font-family:ui-monospace,monospace;font-size:13px;line-height:1.6;padding:16px}
h1{font-size:15px;color:#58a6ff;margin-bottom:4px}
.meta-bar{color:#6e7681;font-size:11px;margin-bottom:16px;border-bottom:1px solid #21262d;padding-bottom:8px}
.section-label{color:#6e7681;font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin:16px 0 8px}
.msg{padding:6px 10px;margin-bottom:4px;border-radius:4px;border-left:3px solid transparent}
.msg.human{border-left-color:#388bfd;background:#161b22}
.msg.bot{border-left-color:#3fb950;background:#0d1117}
.msg .meta{color:#6e7681;font-size:11px}
.msg .ts{color:#484f58}
.msg .body{margin-top:2px;white-space:pre-wrap;word-break:break-word}
.tool-call-block{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:12px;margin-top:8px;overflow-x:auto}
.tool-call-block details{margin-bottom:8px}
.tool-call-block summary{cursor:pointer;color:#e6edf3;font-weight:600;padding:4px 0}
.tool-call-block summary:hover{color:#58a6ff}
pre{background:#0d1117;border:1px solid #21262d;border-radius:4px;padding:10px;overflow-x:auto;font-size:12px}
code{font-family:inherit}
</style>
</head>
<body>
<h1>🔧 Tool call - ${esc(botName)}</h1>
<div class="meta-bar">${esc(groupName)} &middot; ${esc(dateStr)}</div>
${contextMessages.length > 0 ? `<div class="section-label">Recent context</div>
<div class="context">${msgHtml}</div>` : ''}
<div class="section-label">Tool call</div>
<div class="tool-call-block">${toolCallHtml}</div>
</body>
</html>`;
}

/** Compact single-line breadcrumb for a tool call. Full HTML page uploaded to S3 async. */
async function toolCallBreadcrumb(
  text: string,
  contextMessages: import('nanoclaw/types.js').NewMessage[],
  groupName: string,
): Promise<{ html: string; s3Key: string; pageHtml: string }> {
  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 7);
  const titleMatch = text.match(/🔧\s*([^<]{1,60})/);
  const title = titleMatch ? titleMatch[1].trim() : 'Tool call';
  const s3Key = `tool-calls/${ASSISTANT_NAME}/${Date.now()}-${hash}.html`;
  const url = await getPresignedUrl(s3Key);
  const hashEl = url
    ? `<a href="${url}"><code>${hash}</code></a>`
    : `<code>${hash}</code>`;
  const html = `<font color="#888888">🔧 <em>${esc(title)}</em> · ${hashEl}</font>`;
  const pageHtml = generateToolCallPage({
    toolCallHtml: text,
    botName: ASSISTANT_NAME,
    groupName,
    timestamp: Date.now(),
    contextMessages,
  });
  return { html, s3Key, pageHtml };
}

const esc = escapeHtml;

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

function getMainChatJid(): string | undefined {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === MAIN_GROUP_FOLDER) return jid;
  }
  return undefined;
}

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
    is_bot_message: true,
    thread_id: threadId,
  });
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

  // Ensure isMain is set on any group with the main folder (may be missing from older DBs)
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === MAIN_GROUP_FOLDER && !group.isMain) {
      registeredGroups[jid] = { ...group, isMain: true };
      setRegisteredGroup(jid, registeredGroups[jid]);
    }
  }

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
  if (group.folder === MAIN_GROUP_FOLDER) group = { ...group, isMain: true };
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

/** @internal - exported for testing */
export function _setBotMatrixUserIds(ids: Set<string>): void {
  botMatrixUserIds = ids;
}

/** @internal - exported for testing */
export function _resolveReplyThread(
  chatJid: string,
  messages: NewMessage[],
): string | undefined {
  return resolveReplyThread(chatJid, messages);
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
          void handleProgressOutput(ctx, text);
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

/** Format a raw tool name for display (strips MCP prefixes, underscores → spaces). */
function formatToolLabel(raw: string): string {
  return raw.replace(/^mcp__\w+?__/, '').replace(/_/g, ' ');
}

async function handleProgressOutput(ctx: OutputHandlerContext, text: string): Promise<void> {
  // Handle TITLE-only progress events emitted by agent-runner (bot's text alongside tool calls)
  if (text.startsWith('\x00TITLE:')) {
    const title = text.slice(7).replace(/<[^>]+>/g, '').trim().slice(0, 120);
    if (title) lastProgressText[ctx.chatJid] = title;
    return;
  }
  markProgress(ctx.chatJid, text);
  const isToolCall = text.includes('<details>');
  if (isToolCall) {
    // Track whether this is a dispatch call
    if (text.includes('branch_to_thread')) turnDispatchCalled[ctx.chatJid] = true;
    // Enforce dispatch limit on main brain
    const isMainBrain = registeredGroups[ctx.chatJid]?.folder === MAIN_GROUP_FOLDER;
    if (isMainBrain && !turnDispatchCalled[ctx.chatJid]) {
      turnToolCallCount[ctx.chatJid] = (turnToolCallCount[ctx.chatJid] ?? 0) + 1;
      if (MAIN_BRAIN_TOOL_LIMIT > 0 && turnToolCallCount[ctx.chatJid] >= MAIN_BRAIN_TOOL_LIMIT) {
        const group = registeredGroups[ctx.chatJid];
        if (group) {
          writeMessageToActiveContainerIpc(ctx.chatJid, group,
            `⚠️ DISPATCH LIMIT: You have made ${turnToolCallCount[ctx.chatJid]} inline tool calls without calling branch_to_thread. Call branch_to_thread NOW and stop. Main brain must not do heavy work inline.`);
        }
      }
    }
  }
  let toolCallHtml = '';
  if (isToolCall) {
    const group = registeredGroups[ctx.chatJid];
    const groupName = group?.name ?? ctx.chatJid;
    const threadId = activeReplyThreadIds[ctx.chatJid];
    const contextMessages = threadId
      ? getThreadMessages(ctx.chatJid, threadId, 20)
      : getRecentMessages(ctx.chatJid, ASSISTANT_NAME, 10).reverse();
    const bc = await toolCallBreadcrumb(text, contextMessages, groupName);
    toolCallHtml = bc.html;
    void uploadHtml(bc.s3Key, bc.pageHtml).catch((err) => {
      logger.warn({ err }, 'Failed to upload tool call to S3');
    });
  }
  const now = Date.now();
  const inThread = Boolean(progressToolCallThreadIds[ctx.chatJid] ?? activeReplyThreadIds[ctx.chatJid]);
  if (isToolCall || inThread || !lastProgressChatAt[ctx.chatJid] || now - lastProgressChatAt[ctx.chatJid] >= PROGRESS_CHAT_COOLDOWN_MS) {
    if (!isToolCall && !inThread) lastProgressChatAt[ctx.chatJid] = now;
    const ch = findChannel(channels, ctx.chatJid);
    if (ch) {
      if (isToolCall) {
        threadMapLastSeen[`r:${ctx.chatJid}`] = Date.now();
        const activeThread = activeReplyThreadIds[ctx.chatJid];
        if (activeThread) {
          // Already in a thread — send <details> collapsible in-thread (desktop renders it; mobile shows inline but off main timeline)
          void ch.sendMessage(ctx.chatJid, toolCallHtml, activeThread).then(() => {
                      }).catch((err) => {
            logger.warn({ chatJid: ctx.chatJid, err }, 'Failed to send tool call progress to thread');
          });
        } else {
          // Main timeline — route tool calls to a dedicated per-turn thread
          const sendToToolThread = (threadId: string) => {
            void ch.sendMessage(ctx.chatJid, toolCallHtml, threadId).then(() => {
            }).catch((err) => {
              logger.warn({ chatJid: ctx.chatJid, err }, 'Failed to send tool call to dedicated thread');
            });
          };
          threadMapLastSeen[`p:${ctx.chatJid}`] = Date.now();
          if (progressToolCallThreadIds[ctx.chatJid]) {
            sendToToolThread(progressToolCallThreadIds[ctx.chatJid]!);
          } else if (ch.sendMessageReturningId) {
            // Open a new thread with an anchor message, then post tool call into it
            const _toolTitleMatch = text.match(/🔧\s*([^<]{1,60})/);
            const _toolCallLabel = _toolTitleMatch ? formatToolLabel(_toolTitleMatch[1].trim()) : 'Tool call';
            // Prefer the last text the bot wrote, then currentObjective, then raw tool name
            const _toolAnchor = lastProgressText[ctx.chatJid]
              || getChatActivity(ctx.chatJid)?.currentObjective?.slice(0, 80)
              || _toolCallLabel;
            const _anchorMsg = _toolAnchor !== _toolCallLabel
              ? `<font color="#888888">🔧 <b>${esc(_toolAnchor)}</b><br/><em>${esc(_toolCallLabel)}</em></font>`
              : `<font color="#888888">🔧 <em>${esc(_toolAnchor)}</em></font>`;
            void ch.sendMessageReturningId(ctx.chatJid, _anchorMsg).then((anchorId) => {
              if (anchorId) {
                progressToolCallThreadIds[ctx.chatJid] = anchorId;
                threadMapLastSeen[`p:${ctx.chatJid}`] = Date.now();
                sendToToolThread(anchorId);
              } else {
                // Fallback: send inline if we couldn't get an anchor ID
                void ch.sendMessage(ctx.chatJid, toolCallHtml).catch((err) => { logger.warn({ chatJid: ctx.chatJid, err }, 'Fallback tool call send failed'); });
              }
            }).catch((err) => {
              logger.warn({ chatJid: ctx.chatJid, err }, 'Failed to open tool call thread anchor');
            });
          } else {
            // Channel doesn't support returning IDs — send inline as fallback
            void ch.sendMessage(ctx.chatJid, toolCallHtml).catch((err) => { logger.warn({ chatJid: ctx.chatJid, err }, 'Inline tool call send failed'); });
          }
        }
      } else {
        // Capture this as potential tool call thread anchor title
        const stripped = text.replace(/<[^>]+>/g, '').trim().slice(0, 80);
        if (stripped) lastProgressText[ctx.chatJid] = stripped;
        const formatted = `<small><em>${esc(text)}</em></small>`;
        // Route discussion into the tool call thread if one is open; otherwise to reply thread
        const textThread = progressToolCallThreadIds[ctx.chatJid] ?? activeReplyThreadIds[ctx.chatJid];
        threadMapLastSeen[`r:${ctx.chatJid}`] = Date.now();
        void ch.sendMessage(ctx.chatJid, formatted, textThread).then(() => {
          threadMapLastSeen[`r:${ctx.chatJid}`] = Date.now();
        }).catch((err) => {
          logger.warn({ chatJid: ctx.chatJid, err }, 'Failed to send progress to chat');
        });
      }
    }
  }
}

async function handleResultOutput(ctx: OutputHandlerContext, text: string): Promise<void> {
  markProgress(ctx.chatJid, text);
  // Set state before channel send to preserve original behavior if send throws
  ctx.onOutputSent(text);
  const ch = findChannel(channels, ctx.chatJid);
  if (ch) {
    if (ch.setTyping) await ch.setTyping(ctx.chatJid, true);
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
      if (ch.setTyping) await ch.setTyping(ctx.chatJid, false);
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

  const channel = findChannel(channels, chatJid);
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

  // In quarters, every message is for the bot
  const isQuarters = quartersJid !== null && chatJid === quartersJid;
  // Need explicit callout, participating thread, CO main timeline duty, or quarters
  if (!isQuarters && !hasTrigger && !hasParticipatingThread && !isCOTrigger) {
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
  // BUG-16: auto-set work thread when incoming message is in a thread, so bot's
  // send_message MCP calls also route there without requiring an explicit set_thread call.
  if (activeReplyThreadIds[chatJid]) {
    workThreadIds[chatJid] = activeReplyThreadIds[chatJid]!;
    threadMapLastSeen[`w:${chatJid}`] = Date.now();
  }
  logger.info(
    { group: group.name, replyThreadId: activeReplyThreadIds[chatJid], msgCount: contextMessages.length },
    'Thread routing resolved',
  );

  const basePrompt = formatMessages(contextMessages, TIMEZONE);
  const threadContext = buildThreadContextBlock(chatJid, contextMessages);
  const missionContext =
    isMainGroup ? buildMainMissionContext(chatJid) : undefined;
  const prevKilled = turnKilledByTimeout[chatJid];
  if (prevKilled) delete turnKilledByTimeout[chatJid];
  const triageInstruction = prevKilled
    ? '⚠️ DISPATCH REQUIRED: Your previous turn was killed — it ran too long without calling `branch_to_thread`. This turn: acknowledge the task and call `branch_to_thread` immediately. No inline tool calls.'
    : `Use \`branch_to_thread\` for any task requiring more than ${MAIN_BRAIN_TOOL_LIMIT} tool calls. Main brain must stay responsive.`;
  const activeThread = activeReplyThreadIds[chatJid];
  const threadNote = activeThread
    ? `The incoming message is in Matrix thread \`${activeThread}\`. Your response will be sent there automatically. Use this ID with \`set_thread\` if you need to send intermediate messages in-thread.`
    : undefined;
  const parts: string[] = [];
  if (missionContext) parts.push(missionContext);
  if (isMainGroup) parts.push(triageInstruction);
  if (threadNote) parts.push(threadNote);
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
  // Reset per-turn dispatch counters
  turnToolCallCount[chatJid] = 0;
  turnDispatchCalled[chatJid] = false;


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
  delete lastProgressText[chatJid];
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
      const ch = findChannel(channels, jid);
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

  // Main-brain turn timeout: kill the process if it runs too long without dispatching.
  let turnKillTimer: ReturnType<typeof setTimeout> | null = null;
  let killProc: (() => void) | null = null;
  if (isMain && MAIN_BRAIN_TURN_TIMEOUT_MS > 0) {
    turnKillTimer = setTimeout(() => {
      if (killProc) {
        logger.warn({ chatJid, timeoutMs: MAIN_BRAIN_TURN_TIMEOUT_MS }, 'main brain turn timeout — killing process');
        killProc();
        turnKilledByTimeout[chatJid] = true;
      }
    }, MAIN_BRAIN_TURN_TIMEOUT_MS);
  }

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
      (proc, containerName) => {
        killProc = () => {
          exec(`podman stop "${containerName}"`, { timeout: 15000 }, (err) => {
            if (err) {
              logger.warn({ containerName, err }, 'Graceful podman stop failed, force killing');
              proc.kill('SIGKILL');
            }
          });
        };
        queue.registerProcess(chatJid, proc, containerName, group.folder);
      },
      wrappedOnOutput,
    );
    if (turnKillTimer) clearTimeout(turnKillTimer);

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
    if (turnKillTimer) clearTimeout(turnKillTimer);
    logger.error({ group: group.name, err }, 'Agent error');
    return { status: 'error', error: errStr(err) };
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

  // In quarters, every message is for the bot
  const isQuarters = quartersJid !== null && chatJid === quartersJid;
  // Need explicit callout, participating thread, CO main timeline duty, or quarters
  if (!isQuarters && !hasTrigger && !hasParticipatingThread && !isCOTrigger) {
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
  const rawFormatted = formatMessages(messagesToSend, TIMEZONE);

  activeReplyThreadIds[chatJid] = resolveReplyThread(chatJid, messagesToSend);
  // BUG-16: auto-set work thread when piped message is in a thread.
  if (activeReplyThreadIds[chatJid]) {
    workThreadIds[chatJid] = activeReplyThreadIds[chatJid]!;
    threadMapLastSeen[`w:${chatJid}`] = Date.now();
  }
  const pipedActiveThread = activeReplyThreadIds[chatJid];
  const pipedThreadNote = pipedActiveThread
    ? `The incoming message is in Matrix thread \`${pipedActiveThread}\`. Your response will be sent there automatically. Use this ID with \`set_thread\` if you need to send intermediate messages in-thread.`
    : undefined;
  const formattedParts = [pipedThreadNote, threadCtx, rawFormatted].filter(Boolean);
  const formatted = formattedParts.join('\n\n');
  threadMapLastSeen[`r:${chatJid}`] = Date.now();

  const groupStatus = queue.getGroupStatus(chatJid);
  if (groupStatus.active) {
    // Keep active-container IPC as a high-priority lane for captain/operator messages.
    // Bot-to-bot traffic should queue normally to avoid starvation/loop churn.
    const isQuartersRoom = quartersJid !== null && chatJid === quartersJid;
    const shouldPrioritizeToActiveContainer = isQuartersRoom || messagesToSend.some((m) => {
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

  const ch = findChannel(channels, chatJid);
  if (ch?.setTyping) void ch.setTyping(chatJid, true).catch((err) => { logger.debug({ chatJid, err }, 'Set typing failed'); });
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
  const mainJid = getMainChatJid();
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
  const mainJid = getMainChatJid();

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

  // Send updated todo list to main room
  if (mainJid) {
    const items = readTodoItems(MAIN_GROUP_FOLDER);
    if (items.length > 0) {
      const ch = findChannel(channels, mainJid);
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
  // Resume message is already queued via enqueueMessageCheck above.
  // The container starts via queue; new messages are piped to it via IPC.
}

// ── Session cleanup ─────────────────────────────────────────────────────

/** Delete stale JSONL files in a directory: keep the newest, delete older ones over sizeThreshold. */
function pruneJsonlDir(dir: string, sizeThreshold: number): number {
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs, size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => b.mtime - a.mtime);
  let pruned = 0;
  for (const f of files.slice(1)) {
    if (f.size > sizeThreshold) {
      fs.unlinkSync(path.join(dir, f.name));
      pruned++;
    }
  }
  return pruned;
}

/** Delete stale Claude session JSONL files across all project dirs (>200KB, not the most recent). */
function pruneOldSessions(): void {
  try {
    const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(claudeProjects)) return;
    let pruned = 0;
    for (const proj of fs.readdirSync(claudeProjects)) {
      const projDir = path.join(claudeProjects, proj);
      if (!fs.statSync(projDir).isDirectory()) continue;
      // Top-level JSONL files
      pruned += pruneJsonlDir(projDir, 200_000);
      // archive subdir (contains moved-away old sessions)
      pruned += pruneJsonlDir(path.join(projDir, 'archive'), 0);
    }
    if (pruned > 0) logger.info({ pruned }, 'Pruned old session JSONL files');
  } catch (err) {
    logger.warn({ err }, 'pruneOldSessions failed');
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
  initDatabaseExt();
  logger.info('Database initialized');
  pruneOldSessions();

  // Validate config and warn about missing values
  const configWarnings = validateConfig();
  for (const w of configWarnings) logger.warn(w);
  loadState();

  // Populate bot Matrix user IDs for human-vs-bot message filtering
  try {
    botMatrixUserIds = collectBotMatrixUserIds();
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
      const ch = findChannel(channels, jid);
      if (ch?.setStatusPip) {
        try { await ch.setStatusPip(jid, '🔴'); } catch { /* best-effort */ }
      }
    }
    for (const ch of channels) {
      if (ch.setPresenceStatus) await ch.setPresenceStatus('offline', 'shutting down...');
    }
    if (matrixRef) {
      try { await matrixRef.setDisplayName(botDisplayName('🔴')); } catch { /* best-effort */ }
    }
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
    // Set quarters JID for this bot (if it has one)
    const myBotId = Object.keys(fleet).find(id => {
      const env = (() => { try { return loadProfileEnv(root, id); } catch { return null; } })();
      return env?.ASSISTANT_NAME === ASSISTANT_NAME;
    });
    if (myBotId && fleet[myBotId]?.quartersRoom) {
      quartersJid = `matrix:${fleet[myBotId].quartersRoom}`;
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

  // Build channels array
  const allChannels: (Channel | null)[] = [matrix];
  const refreshConnectedChannels = () => {
    channels = allChannels.filter((ch): ch is Channel => ch != null && ch.isConnected());
  };

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
    // TODO: Keep merge_request routing here while IPC task parsing lives in src/ipc-watcher.ts.
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
    getWorkThread: (chatJid: string) => workThreadIds[chatJid],
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
      const ch = findChannel(channels, jid);
      if (ch?.setStatusPip) {
        void ch.setStatusPip(jid, '💤').catch((err) => { logger.debug({ jid, err }, 'Idle pip set failed'); });
      }
    }
    logger.info({ thresholdMs: IDLE_PIP_THRESHOLD_MS }, 'Bot idle — pip set to 💤');
  }, IDLE_PIP_CHECK_MS));

  // Set presence on startup (boot announcement is handled by the relay/intercom)
  const presenceTimer = setInterval(async () => {
    const mainJid = getMainChatJid();
    if (!mainJid) return;
    const ch = findChannel(channels, mainJid);
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
