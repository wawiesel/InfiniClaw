import { getRouterState, setRouterState, loadBaseState, saveBaseState, deleteSession, setRegisteredGroup, deleteRegisteredGroup } from 'nanoclaw/db.js';
import { mainLlm, setMainLlm, resolveConfiguredMainModel, normalizeMainLlm } from './llm-service.js';
import { MAIN_GROUP_FOLDER } from './infini-config.js';
import { logger } from 'nanoclaw/logger.js';

export let lastTimestamp = '';
export let lastAgentTimestamp: Record<string, string> = {};
export let sessions: Record<string, string> = {};
export let registeredGroups: Record<string, any> = {};

export function loadState(): void {
  const state = loadBaseState();
  lastTimestamp = state.lastTimestamp;
  lastAgentTimestamp = state.lastAgentTimestamp;
  sessions = state.sessions;
  registeredGroups = state.registeredGroups;

  const configuredMainModel = resolveConfiguredMainModel();
  const storedMainModel = normalizeMainLlm(getRouterState('main_model'));
  if (configuredMainModel) {
    const pinnedChanged = storedMainModel && configuredMainModel !== storedMainModel;
    setMainLlm(configuredMainModel);
    setRouterState('main_model', mainLlm);

    if (pinnedChanged && sessions[MAIN_GROUP_FOLDER]) {
      deleteSession(MAIN_GROUP_FOLDER);
      delete sessions[MAIN_GROUP_FOLDER];
      logger.info({ fromModel: storedMainModel, toModel: configuredMainModel }, 'Pinned MAIN model changed; cleared main session');
    }
  } else if (storedMainModel) {
    setMainLlm(storedMainModel);
  }
}

export function saveState(): void {
  saveBaseState(lastTimestamp, lastAgentTimestamp);
  setRouterState('main_model', mainLlm);
}

export function updateLastTimestamp(ts: string): void {
  lastTimestamp = ts;
}

import path from 'path';
import fs from 'fs';
import { DATA_DIR } from 'nanoclaw/config.js';

export function registerGroup(jid: string, group: any): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}

export function unregisterGroup(jid: string): void {
  const group = registeredGroups[jid];
  delete registeredGroups[jid];
  deleteRegisteredGroup(jid);
  logger.info({ jid, folder: group?.folder }, 'Group unregistered');
}

import { getAllChats } from 'nanoclaw/db.js';

export function getAvailableGroups(): any[] {
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

export function updateLastAgentTimestamp(chatJid: string, ts: string): void {
  lastAgentTimestamp[chatJid] = ts;
}

export function _setRegisteredGroups(groups: Record<string, any>): void {
  registeredGroups = groups;
}
