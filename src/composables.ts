/**
 * Composable utilities for the InfiniClaw orchestrator.
 * Moved from nanoclaw (upstream removed in v1.2.12).
 * These extract shared logic so InfiniClaw can extend them.
 */
import {
  deleteSession,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getRouterState,
  setRouterState,
  setSession,
} from 'nanoclaw/db.js';
import {
  ContainerOutput,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from 'nanoclaw/container-runner.js';
import type { AvailableGroup } from 'nanoclaw/container-runner.js';
import { NewMessage, RegisteredGroup } from 'nanoclaw/types.js';
import { logger } from 'nanoclaw/logger.js';

export interface BaseState {
  lastTimestamp: string;
  lastAgentTimestamp: Record<string, string>;
  sessions: Record<string, string>;
  registeredGroups: Record<string, RegisteredGroup>;
}

export function loadBaseState(): BaseState {
  const lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  let lastAgentTimestamp: Record<string, string>;
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  const sessions = getAllSessions();
  const registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
  return { lastTimestamp, lastAgentTimestamp, sessions, registeredGroups };
}

export function saveBaseState(
  lastTimestamp: string,
  lastAgentTimestamp: Record<string, string>,
): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

export function groupMessagesByChat(messages: NewMessage[]): Map<string, NewMessage[]> {
  const map = new Map<string, NewMessage[]>();
  for (const msg of messages) {
    const existing = map.get(msg.chat_jid);
    if (existing) {
      existing.push(msg);
    } else {
      map.set(msg.chat_jid, [msg]);
    }
  }
  return map;
}

export function recoverPendingMessages(opts: {
  registeredGroups: Record<string, RegisteredGroup>;
  lastAgentTimestamp: Record<string, string>;
  assistantName: string;
  enqueueCheck: (chatJid: string) => void;
}): void {
  for (const [chatJid, group] of Object.entries(opts.registeredGroups)) {
    const sinceTimestamp = opts.lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, opts.assistantName);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      opts.enqueueCheck(chatJid);
    }
  }
}

export function writeAgentSnapshots(
  groupFolder: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  getAvailableGroupsFn: () => AvailableGroup[],
): void {
  const tasks = getAllTasks();
  writeTasksSnapshot(
    groupFolder,
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
  const availableGroups = getAvailableGroupsFn();
  writeGroupsSnapshot(
    groupFolder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );
}

export function wrapOnOutputForSession(
  sessions: Record<string, string>,
  groupFolder: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): ((output: ContainerOutput) => Promise<void>) | undefined {
  if (!onOutput) return undefined;
  return async (output: ContainerOutput) => {
    if (output.isSessionError) {
      delete sessions[groupFolder];
      deleteSession(groupFolder);
    }
    if (output.newSessionId) {
      sessions[groupFolder] = output.newSessionId;
      setSession(groupFolder, output.newSessionId);
    }
    await onOutput(output);
  };
}
