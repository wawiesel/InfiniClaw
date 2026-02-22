/**
 * Composable utilities for downstream consumers.
 * These functions extract shared logic from the NanoClaw orchestrator so
 * downstream projects (e.g. InfiniClaw) can import and extend them instead
 * of forking entire files.
 */
import {
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getRouterState,
  setRouterState,
  setSession,
} from './db.js';
import {
  ContainerOutput,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import type { AvailableGroup } from './container-runner.js';
import { NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

/**
 * Base state returned by loadBaseState.
 * Downstream consumers extend with their own state (e.g. brain mode).
 */
export interface BaseState {
  lastTimestamp: string;
  lastAgentTimestamp: Record<string, string>;
  sessions: Record<string, string>;
  registeredGroups: Record<string, RegisteredGroup>;
}

/**
 * Load common state from the database.
 * Returns values rather than mutating module-level state, so downstream
 * consumers can extend with their own state loading.
 */
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

/**
 * Save common state to the database.
 * Downstream consumers call this then save their own extended state.
 */
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

/**
 * Group messages by chat JID.
 * Used in the message loop to deduplicate by group.
 */
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

/**
 * Check for unprocessed messages in registered groups and enqueue them.
 * Handles crash recovery between advancing lastTimestamp and processing.
 */
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

/**
 * Write tasks and groups snapshots before an agent run.
 * Both NanoClaw and downstream consumers do this before every container invocation.
 */
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

/**
 * Wrap an onOutput callback to track session ID updates from streamed results.
 * The sessions object is mutated directly so the caller sees updates.
 */
export function wrapOnOutputForSession(
  sessions: Record<string, string>,
  groupFolder: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): ((output: ContainerOutput) => Promise<void>) | undefined {
  if (!onOutput) return undefined;
  return async (output: ContainerOutput) => {
    if (output.newSessionId) {
      sessions[groupFolder] = output.newSessionId;
      setSession(groupFolder, output.newSessionId);
    }
    await onOutput(output);
  };
}
