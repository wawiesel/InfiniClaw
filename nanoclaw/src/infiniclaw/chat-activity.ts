/**
 * InfiniClaw chat activity tracking.
 * Tracks objectives, progress, completions, errors per group.
 * Persists state to the router_state DB table.
 */
import { TRIGGER_PATTERN } from '../config.js';
import { getRouterState, setRouterState } from '../db.js';
import type { NewMessage } from '../types.js';

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

const chatActivity: Record<string, ChatActivity> = {};
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
  if (typeof record.currentObjectiveAt === 'number') out.currentObjectiveAt = record.currentObjectiveAt;
  if (typeof record.lastProgress === 'string') out.lastProgress = record.lastProgress;
  if (typeof record.lastProgressAt === 'number') out.lastProgressAt = record.lastProgressAt;
  if (typeof record.lastCompletion === 'string') out.lastCompletion = record.lastCompletion;
  if (typeof record.lastCompletionAt === 'number') out.lastCompletionAt = record.lastCompletionAt;
  if (typeof record.lastError === 'string') out.lastError = record.lastError;
  if (typeof record.lastErrorAt === 'number') out.lastErrorAt = record.lastErrorAt;
  if (Array.isArray(record.recentUserContext)) {
    out.recentUserContext = record.recentUserContext
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim())
      .slice(-6);
  }
  return out;
}

function persistChatActivity(chatJid: string): void {
  const activity = chatActivity[chatJid];
  if (!activity) return;
  try {
    setRouterState(chatActivityStateKey(chatJid), JSON.stringify(activity));
  } catch {
    // Non-critical
  }
}

export function ensureChatActivity(chatJid: string): ChatActivity {
  if (!chatActivity[chatJid]) {
    const persisted = getRouterState(chatActivityStateKey(chatJid));
    if (persisted) {
      try {
        chatActivity[chatJid] = sanitizeActivity(JSON.parse(persisted));
      } catch {
        chatActivity[chatJid] = {};
      }
    } else {
      chatActivity[chatJid] = {};
    }
  }
  return chatActivity[chatJid];
}

export function getChatActivity(chatJid: string): ChatActivity | undefined {
  return chatActivity[chatJid];
}

function compactMessage(text: string, maxLen = 220): string | undefined {
  let compact = text.trim();
  if (!compact) return undefined;
  if (TRIGGER_PATTERN.test(compact)) {
    compact = compact.replace(TRIGGER_PATTERN, '').trim();
  }
  compact = compact.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
}

function setCurrentObjective(chatJid: string, objective: string): void {
  const compact = compactMessage(objective, 180);
  if (!compact) return;
  const activity = ensureChatActivity(chatJid);
  activity.currentObjective = compact;
  activity.currentObjectiveAt = Date.now();
  persistChatActivity(chatJid);
}

function recordUserContext(chatJid: string, text: string): void {
  const compact = compactMessage(text, 220);
  if (!compact) return;
  const activity = ensureChatActivity(chatJid);
  const existing = activity.recentUserContext || [];
  const next = [...existing.filter((v) => v !== compact), compact].slice(-6);
  activity.recentUserContext = next;
  persistChatActivity(chatJid);
}

export function setObjectiveFromMessages(chatJid: string, messages: NewMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i].content.trim();
    if (!content) continue;
    recordUserContext(chatJid, content);
    setCurrentObjective(chatJid, content);
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
