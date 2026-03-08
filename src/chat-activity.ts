/**
 * InfiniClaw chat activity tracking.
 * Tracks objectives, progress, completions, errors per group.
 * Persists state to the router_state DB table.
 */
import { TRIGGER_PATTERN } from 'nanoclaw/config.js';
import { getRouterState, setRouterState } from 'nanoclaw/db.js';
import type { NewMessage } from 'nanoclaw/types.js';

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
  if (typeof record.runStartedAt === 'number' && Number.isFinite(record.runStartedAt)) out.runStartedAt = record.runStartedAt;
  if (typeof record.currentObjective === 'string') out.currentObjective = record.currentObjective;
  if (typeof record.currentObjectiveAt === 'number' && Number.isFinite(record.currentObjectiveAt)) out.currentObjectiveAt = record.currentObjectiveAt;
  if (typeof record.lastProgress === 'string') out.lastProgress = record.lastProgress;
  if (typeof record.lastProgressAt === 'number' && Number.isFinite(record.lastProgressAt)) out.lastProgressAt = record.lastProgressAt;
  if (typeof record.lastCompletion === 'string') out.lastCompletion = record.lastCompletion;
  if (typeof record.lastCompletionAt === 'number' && Number.isFinite(record.lastCompletionAt)) out.lastCompletionAt = record.lastCompletionAt;
  if (typeof record.lastError === 'string') out.lastError = record.lastError;
  if (typeof record.lastErrorAt === 'number' && Number.isFinite(record.lastErrorAt)) out.lastErrorAt = record.lastErrorAt;
  if (Array.isArray(record.recentUserContext)) {
    out.recentUserContext = record.recentUserContext
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim())
      .slice(-6);
  }
  return out;
}

function persistChatActivity(chatJid: string): void {
  const activity = chatActivity.get(chatJid);
  if (!activity) return;
  try {
    setRouterState(chatActivityStateKey(chatJid), JSON.stringify(activity));
  } catch {
    // Non-critical
  }
}

export function ensureChatActivity(chatJid: string): ChatActivity {
  const existing = chatActivity.get(chatJid);
  if (!existing) {
    const persisted = getRouterState(chatActivityStateKey(chatJid));
    if (persisted) {
      try {
        chatActivity.set(chatJid, sanitizeActivity(JSON.parse(persisted)));
      } catch {
        chatActivity.set(chatJid, {});
      }
    } else {
      chatActivity.set(chatJid, {});
    }
  }
  return chatActivity.get(chatJid) as ChatActivity;
}

export function getChatActivity(chatJid: string): ChatActivity | undefined {
  return chatActivity.get(chatJid);
}

function compactMessage(text: string, maxLen = 220): string | undefined {
  let compact = text.trim();
  if (!compact) return undefined;
  compact = compact.replace(TRIGGER_PATTERN, '').trim();
  compact = compact.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
}

function recordUserContext(activity: ChatActivity, text: string): void {
  const compact = compactMessage(text, 220);
  if (!compact) return;
  const existing = activity.recentUserContext || [];
  activity.recentUserContext = [...existing.filter((v) => v !== compact), compact].slice(-6);
}

export function setObjectiveFromMessages(chatJid: string, messages: NewMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const rawContent = messages[i]?.content;
    if (typeof rawContent !== 'string') continue;
    const content = rawContent.trim();
    if (!content) continue;
    const compactObj = compactMessage(content, 180);
    if (!compactObj) continue;
    const activity = ensureChatActivity(chatJid);
    recordUserContext(activity, content);
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

function markField(
  chatJid: string,
  text: string,
  field: 'lastProgress' | 'lastCompletion' | 'lastError',
  atField: 'lastProgressAt' | 'lastCompletionAt' | 'lastErrorAt',
): void {
  const compact = compactMessage(text);
  if (!compact) return;
  const activity = ensureChatActivity(chatJid);
  activity[field] = compact;
  activity[atField] = Date.now();
  persistChatActivity(chatJid);
}

export function markProgress(chatJid: string, progress: string): void {
  markField(chatJid, progress, 'lastProgress', 'lastProgressAt');
}

export function markCompletion(chatJid: string, completion: string): void {
  markField(chatJid, completion, 'lastCompletion', 'lastCompletionAt');
}

export function markError(chatJid: string, error: string): void {
  markField(chatJid, error, 'lastError', 'lastErrorAt');
}

export function buildMainMissionContext(chatJid: string): string | undefined {
  const activity = ensureChatActivity(chatJid);
  const lines: string[] = [];

  if (activity.currentObjective) {
    lines.push(`Current objective: ${activity.currentObjective}`);
  }
  if (activity.recentUserContext && activity.recentUserContext.length > 0) {
    lines.push('Recent user context:');
    for (const item of activity.recentUserContext.slice(-4)) {
      lines.push(`- ${item}`);
    }
  }
  if (activity.lastCompletion) {
    lines.push(`Last completion: ${activity.lastCompletion}`);
  }
  if (activity.lastError) {
    lines.push(`Last error: ${activity.lastError}`);
  }

  if (lines.length === 0) return undefined;
  return [
    '[Persistent mission context - carry this forward unless user changes priorities]',
    ...lines,
  ].join('\n');
}
