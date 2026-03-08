import { Channel } from 'nanoclaw/types.js';
import { findChannel as baseFindChannel } from 'nanoclaw/router.js';
import { RegisteredGroup } from 'nanoclaw/types.js';
import { MAIN_GROUP_FOLDER } from './infini-config.js';

export let channels: Channel[] = [];

export function setChannels(ch: Channel[]): void {
  channels = ch;
}

export function findChannel(chatJid: string): Channel | undefined {
  return baseFindChannel(channels, chatJid);
}

export function getMainChatJid(registeredGroups: Record<string, RegisteredGroup>): string | undefined {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === MAIN_GROUP_FOLDER) return jid;
  }
  return undefined;
}
