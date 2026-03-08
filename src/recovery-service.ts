import { logger } from 'nanoclaw/logger.js';
import { ASSISTANT_NAME, TRIGGER_PATTERN, MAIN_GROUP_FOLDER } from './infini-config.js';
import { updateChatName, getRecentMessages, storeMessage } from 'nanoclaw/db.js';
import { readTodoItems, buildTodoMessage } from './todo-service.js';
import { getMainChatJid, findChannel } from './channel-manager.js';

export async function injectResumeMessage(
  registeredGroups: Record<string, any>,
  queue: any,
  processGroupMessages: (jid: string) => Promise<boolean>,
  resumeDelaySeconds: number,
  resumeGateResolve: () => void,
): Promise<void> {
  const mainJid = getMainChatJid(registeredGroups);

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    updateChatName(chatJid, group.name);

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

  if (mainJid) await processGroupMessages(mainJid);

  if (mainJid) {
    const items = readTodoItems(MAIN_GROUP_FOLDER);
    if (items.length > 0) {
      const ch = findChannel(mainJid);
      if (ch) await ch.sendMessage(mainJid, buildTodoMessage(mainJid));
    }
  }

  if (resumeDelaySeconds > 0) {
    logger.info({ delaySeconds: resumeDelaySeconds }, 'Resume delay before processing messages');
    await new Promise((r) => setTimeout(r, resumeDelaySeconds * 1000));
  }

  resumeGateResolve();
  logger.info('Resume complete, message loop unblocked');
}
