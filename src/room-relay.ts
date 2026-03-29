/**
 * Cross-room relay — sends messages to Matrix rooms via the operator account.
 * Used for cross-room bot-to-bot messaging ({{send}} signal).
 */
import fs from 'fs';
import path from 'path';

import { logger } from 'nanoclaw/logger.js';
import { matrixSend } from './matrix-api.js';
import { loadShipConfig } from './ship-config.js';

/** Strip 'matrix:' prefix from a JID to get the raw Matrix room ID. */
function jidToRoomId(jid: string): string {
  return jid.startsWith('matrix:') ? jid.slice('matrix:'.length) : jid;
}

/**
 * Send a message to a Matrix room via the operator account.
 * Returns true on success.
 */
export async function sendViaIntercom(targetJid: string, text: string): Promise<boolean> {
  const roomId = jidToRoomId(targetJid);
  try {
    const opFile = path.join(loadShipConfig().secretsPath, 'operator', 'operator-matrix.json');
    const opConf = JSON.parse(fs.readFileSync(opFile, 'utf-8'));
    if (!opConf.homeserver || !opConf.accessToken) {
      logger.warn({ targetJid, roomId }, 'No operator config for cross-room send');
      return false;
    }
    const eventId = await matrixSend({ homeserver: opConf.homeserver, token: opConf.accessToken, roomId, text, plain: true });
    if (!eventId) {
      logger.error({ targetJid }, 'Cross-room send via operator failed');
      return false;
    }
    logger.info({ targetJid }, 'Cross-room message sent via operator account');
    return true;
  } catch (err) {
    logger.error({ err, targetJid }, 'Cross-room send error');
    return false;
  }
}
