import { MatrixChannel } from './channels/matrix.js';
import { LocalCliChannel } from './channels/local-cli.js';
import { logger } from 'nanoclaw/logger.js';
import { botDisplayName } from './bot-manager.js';
import { normalizeInboundMessage } from './message-filtering.js';
import { storeMessage, storeChatMetadata } from 'nanoclaw/db.js';
import { updateEventIdFile } from './main.js'; // Temp export
import { MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN, MATRIX_USERNAME, MATRIX_PASSWORD, LOCAL_CHANNEL_ENABLED, LOCAL_MIRROR_MATRIX_JID } from 'nanoclaw/config.js';

export function setupMatrixChannel(initialBadge: string, registeredGroups: Record<string, any>, handleLifecycleMessage: any): MatrixChannel | null {
  if (MATRIX_HOMESERVER && (MATRIX_ACCESS_TOKEN || (MATRIX_USERNAME && MATRIX_PASSWORD))) {
    return new MatrixChannel({
      displayName: botDisplayName(initialBadge),
      onMessage: (_chatJid, msg) => {
        const safeMsg = normalizeInboundMessage(msg);
        if (!safeMsg) return;
        if (safeMsg.content.trim().startsWith('!')) return;
        handleLifecycleMessage(safeMsg);
        storeMessage(safeMsg);
        if (safeMsg.id && safeMsg.id.startsWith('$')) {
          const group = registeredGroups[safeMsg.chat_jid];
          if (group) updateEventIdFile(group.folder, 'lastReceived', safeMsg.id);
        }
      },
      onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
      registeredGroups: () => registeredGroups,
    });
  }
  return null;
}

export function setupLocalCliChannel(matrix: MatrixChannel | null): LocalCliChannel | null {
  if (LOCAL_CHANNEL_ENABLED) {
    return new LocalCliChannel({
      onMessage: (_chatJid, msg) => {
        const safeMsg = normalizeInboundMessage(msg);
        if (!safeMsg || safeMsg.content.trim().startsWith('!')) return;
        storeMessage(safeMsg);
      },
      onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
      mirrorToMatrix: LOCAL_MIRROR_MATRIX_JID ? async (text: string) => {
        if (!matrix || !matrix.isConnected()) return;
        await matrix.sendMessage(LOCAL_MIRROR_MATRIX_JID, text);
      } : undefined,
    });
  }
  return null;
}
