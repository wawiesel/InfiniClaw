import crypto from 'crypto';
import { logger } from 'nanoclaw/logger.js';
import { NewMessage } from 'nanoclaw/types.js';
import { getPublicS3Url } from './s3-sync.js';
import { ASSISTANT_NAME, TRIGGER_PATTERN } from 'nanoclaw/config.js';
import { getRouterState, setRouterState } from 'nanoclaw/db.js';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface ChatActivity {
  runStartedAt?: number;
  currentObjective?: string;
  currentObjectiveAt?: number;
  recentUserContext?: string[];
  lastProgress?: string;
  lastProgressAt?: number;
  lastCompletion?: string;
  lastCompletionAt?: number;
  lastError?: string;
  lastErrorAt?: number;
}

const chatActivity = new Map<string, ChatActivity>();
const CHAT_ACTIVITY_STATE_PREFIX = 'chat_activity:';

function chatActivityStateKey(chatJid: string): string {
  return `${CHAT_ACTIVITY_STATE_PREFIX}${encodeURIComponent(chatJid)}`;
}

function sanitizeActivity(raw: unknown): ChatActivity {
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as Record<string, unknown>;
  const out: ChatActivity = {};
  if (typeof record.runStartedAt === 'number') out.runStartedAt = record.runStartedAt;
  if (typeof record.currentObjective === 'string') out.currentObjective = record.currentObjective;
  if (Array.isArray(record.recentUserContext)) out.recentUserContext = record.recentUserContext.filter((v): v is string => typeof v === 'string').slice(-6);
  return out;
}

function persistChatActivity(chatJid: string): void {
  const activity = chatActivity.get(chatJid);
  if (activity) try { setRouterState(chatActivityStateKey(chatJid), JSON.stringify(activity)); } catch { }
}

export function ensureChatActivity(chatJid: string): ChatActivity {
  let existing = chatActivity.get(chatJid);
  if (!existing) {
    const persisted = getRouterState(chatActivityStateKey(chatJid));
    existing = persisted ? sanitizeActivity(JSON.parse(persisted)) : {};
    chatActivity.set(chatJid, existing);
  }
  return existing;
}

function compactMessage(text: string, maxLen = 220): string | undefined {
  let compact = text.trim().replace(TRIGGER_PATTERN, '').replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
}

export function setObjectiveFromMessages(chatJid: string, messages: NewMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    if (typeof content !== 'string') continue;
    const compactObj = compactMessage(content, 180);
    if (!compactObj) continue;
    const activity = ensureChatActivity(chatJid);
    activity.currentObjective = compactObj;
    activity.currentObjectiveAt = Date.now();
    persistChatActivity(chatJid);
    return;
  }
}

export function markRunStarted(chatJid: string): void {
  const activity = ensureChatActivity(chatJid);
  activity.runStartedAt = Date.now();
  persistChatActivity(chatJid);
}

export function markRunEnded(chatJid: string): void {
  const activity = ensureChatActivity(chatJid);
  activity.runStartedAt = undefined;
  persistChatActivity(chatJid);
}

export function markProgress(chatJid: string, progress: string): void {
  const compact = compactMessage(progress);
  if (!compact) return;
  const activity = ensureChatActivity(chatJid);
  activity.lastProgress = compact;
  activity.lastProgressAt = Date.now();
  persistChatActivity(chatJid);
}

export function markCompletion(chatJid: string, completion: string): void {
  const compact = compactMessage(completion);
  if (!compact) return;
  const activity = ensureChatActivity(chatJid);
  activity.lastCompletion = compact;
  activity.lastCompletionAt = Date.now();
  persistChatActivity(chatJid);
}

export function markError(chatJid: string, error: string): void {
  const compact = compactMessage(error);
  if (!compact) return;
  const activity = ensureChatActivity(chatJid);
  activity.lastError = compact;
  activity.lastErrorAt = Date.now();
  persistChatActivity(chatJid);
}

export function buildMainMissionContext(chatJid: string): string | undefined {
  const activity = ensureChatActivity(chatJid);
  const lines: string[] = [];
  if (activity.currentObjective) lines.push(`Current objective: ${activity.currentObjective}`);
  if (activity.lastCompletion) lines.push(`Last completion: ${activity.lastCompletion}`);
  if (lines.length === 0) return undefined;
  return ['[Persistent mission context]', ...lines].join('\n');
}

/** Build a standalone HTML page for a tool call, with surrounding conversation context. */
export function generateToolCallPage(opts: {
  toolCallHtml: string;
  botName: string;
  groupName: string;
  timestamp: number;
  contextMessages: NewMessage[];
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
export function toolCallBreadcrumb(
  text: string,
  contextMessages: NewMessage[],
  groupName: string,
): { html: string; s3Key: string; pageHtml: string } {
  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 7);
  const titleMatch = text.match(/🔧\s*([^<]{1,60})/);
  const title = titleMatch ? titleMatch[1].trim() : 'Tool call';
  const s3Key = `tool-calls/${ASSISTANT_NAME}/${Date.now()}-${hash}.html`;
  const url = getPublicS3Url(s3Key);
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
