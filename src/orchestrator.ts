import fs from 'fs';
import path from 'path';
import { logger } from 'nanoclaw/logger.js';
import { NewMessage, RegisteredGroup, Channel, ContainerOutput } from 'nanoclaw/types.js';
import { ASSISTANT_NAME, TRIGGER_PATTERN, IDLE_TIMEOUT, POLL_INTERVAL, DATA_DIR } from 'nanoclaw/config.js';
import { CAPTAIN_USER_ID, MAIN_GROUP_FOLDER } from './infini-config.js';
import { getMessagesSince, botParticipatesInThread, getNewMessages, storeMessage, getThreadMessages, setSession } from 'nanoclaw/db.js';
import { groupMessagesByChat, writeAgentSnapshots, wrapOnOutputForSession } from 'nanoclaw/composables.js';
import { formatMessages, formatThreadContext } from 'nanoclaw/router.js';
import { findChannel, getMainChatJid } from './channel-manager.js';
import { matrixService } from './matrix-service.js';
import { fleetManager } from './fleet-manager.ts';
import { botMatrixUserIds } from './bot-manager.js';
import { shouldIgnoreMessage } from './message-filtering.js';
import { ensureChatActivity, setObjectiveFromMessages, markRunStarted, markRunEnded, markCompletion, markError, buildMainMissionContext } from './chat-activity-service.js';
import { runContainerAgent } from './container-spawn.js';
import { appendConversationLog } from './conversation-log.js';
import { maybeAutoSwitchBrainsOnQuotaError } from './llm-service.js';
import { updateEventIdFile } from './main.js'; // Temporary export until moved

export async function processGroupMessages(
  chatJid: string,
  registeredGroups: Record<string, RegisteredGroup>,
  lastAgentTimestamp: Record<string, string>,
  saveState: () => void,
  activeReplyThreadIds: Record<string, string | undefined>,
  workThreadIds: Record<string, string>,
  threadMapLastSeen: Record<string, number>,
  queue: any,
  createOutputHandler: any,
  resolveReplyThread: any,
): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(chatJid);
  if (!channel) return true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
  if (missedMessages.length === 0) return true;

  const filteredMessages = missedMessages.filter((msg) => !shouldIgnoreMessage(msg, botMatrixUserIds));
  if (filteredMessages.length === 0) return true;

  const actionableMessages = filteredMessages.filter(m => {
    if (/^!operator\b/i.test(m.content.trim())) return false;
    if (!botMatrixUserIds.has(m.sender)) return true;
    return TRIGGER_PATTERN.test(m.content.trim());
  });
  if (actionableMessages.length === 0) {
    lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    return true;
  }

  const hasTrigger = actionableMessages.some(m => TRIGGER_PATTERN.test(m.content.trim()));
  const hasParticipatingThread = actionableMessages.some(m => m.thread_id && botParticipatesInThread(chatJid, m.thread_id));
  const isCOTrigger = fleetManager.isCOMainTimelineTrigger(chatJid, actionableMessages, ASSISTANT_NAME, botMatrixUserIds);

  if (!hasTrigger && !hasParticipatingThread && !isCOTrigger) {
    lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    return true;
  }

  const contextMessages = filteredMessages.filter(m => !m.thread_id || botParticipatesInThread(chatJid, m.thread_id) || TRIGGER_PATTERN.test(m.content.trim()));
  
  // Ack trigger
  void matrixService.setTyping(chatJid, true);
  
  setObjectiveFromMessages(chatJid, contextMessages);
  activeReplyThreadIds[chatJid] = resolveReplyThread(chatJid, contextMessages);
  threadMapLastSeen[`r:${chatJid}`] = Date.now();

  const parts: string[] = [];
  const missionContext = group.folder === MAIN_GROUP_FOLDER ? buildMainMissionContext(chatJid) : undefined;
  if (missionContext) parts.push(missionContext);
  parts.push(formatMessages(contextMessages));
  const prompt = parts.join('\n\n');

  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  markRunStarted(chatJid);
  // ... rest of logic uses callbacks passed in
  return true;
}

export function buildThreadContextBlock(chatJid: string, messages: NewMessage[]): string {
  const threadIds = new Set(messages.map(m => m.thread_id).filter(Boolean) as string[]);
  if (threadIds.size === 0) return '';
  const newMessageIds = new Set(messages.map(m => m.id).filter(Boolean) as string[]);
  let allThreadMessages: NewMessage[] = [];
  for (const tid of threadIds) {
    allThreadMessages = allThreadMessages.concat(getThreadMessages(chatJid, tid));
  }
  return formatThreadContext(allThreadMessages, newMessageIds);
}

export function injectSystemNotice(chatJid: string, content: string, queue: any): void {
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
