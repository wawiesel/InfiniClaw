/**
 * Intercom relay — sends messages to Matrix rooms via per-room intercom accounts.
 * Used for cross-room bot-to-bot messaging.
 */
import { logger } from 'nanoclaw/logger.js';
import { loadIntercomConfig, matrixLogin, matrixLogout, matrixSend } from './matrix-api.js';

/** Strip 'matrix:' prefix from a JID to get the raw Matrix room ID. */
function jidToRoomId(jid: string): string {
  return jid.startsWith('matrix:') ? jid.slice('matrix:'.length) : jid;
}

/**
 * Send a message to a Matrix room via the room's intercom account.
 * Returns true on success.
 */
export async function sendViaIntercom(targetJid: string, text: string): Promise<boolean> {
  const roomId = jidToRoomId(targetJid);
  const config = loadIntercomConfig();
  if (!config) {
    logger.warn({ targetJid, roomId }, 'No intercom config found');
    return false;
  }

  // Find the intercom room entry matching this room ID
  let roomEntry: { username: string; password: string } | null = null;
  for (const room of Object.values(config.rooms)) {
    if (room.roomId === roomId) { roomEntry = room; break; }
  }
  if (!roomEntry) {
    logger.warn({ targetJid, roomId }, 'No intercom account found for target room');
    return false;
  }

  const { homeserver } = config;

  try {
    const { accessToken } = await matrixLogin(homeserver, roomEntry.username, roomEntry.password);

    const eventId = await matrixSend({
      homeserver,
      token: accessToken,
      roomId,
      text,
      plain: true,
    });

    // Logout best-effort
    matrixLogout(homeserver, accessToken);

    if (!eventId) {
      logger.error({ intercom: roomEntry.username }, 'Intercom send failed');
      return false;
    }

    logger.info({ targetJid, intercom: roomEntry.username }, 'Cross-room message sent via intercom');
    return true;
  } catch (err) {
    logger.error({ err, targetJid }, 'Intercom relay error');
    return false;
  }
}
