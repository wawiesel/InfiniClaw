/**
 * Intercom relay — sends messages to Matrix rooms via per-room intercom accounts.
 * Used for cross-room bot-to-bot messaging.
 */
import fs from 'fs';
import path from 'path';
import { logger } from 'nanoclaw/logger.js';
import { loadMachineConfig } from './machine-config.js';
let cachedConfig = null;
function loadIntercomConfig() {
    if (cachedConfig)
        return cachedConfig;
    try {
        const secretsPath = loadMachineConfig().secretsPath;
        const configPath = path.join(secretsPath, 'operator', 'intercom.json');
        if (!fs.existsSync(configPath))
            return null;
        cachedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return cachedConfig;
    }
    catch {
        return null;
    }
}
/** Find the intercom room config for a given Matrix room ID. */
function findIntercomForRoom(matrixRoomId) {
    const config = loadIntercomConfig();
    if (!config)
        return null;
    for (const [name, room] of Object.entries(config.rooms)) {
        if (room.roomId === matrixRoomId) {
            return { name, room, homeserver: config.homeserver };
        }
    }
    return null;
}
/** Strip 'matrix:' prefix from a JID to get the raw Matrix room ID. */
function jidToRoomId(jid) {
    return jid.startsWith('matrix:') ? jid.slice('matrix:'.length) : jid;
}
/**
 * Send a message to a Matrix room via the room's intercom account.
 * Returns true on success.
 */
export async function sendViaIntercom(targetJid, text) {
    const roomId = jidToRoomId(targetJid);
    const intercom = findIntercomForRoom(roomId);
    if (!intercom) {
        logger.warn({ targetJid, roomId }, 'No intercom account found for target room');
        return false;
    }
    const { homeserver, room } = intercom;
    try {
        // Login
        const loginResp = await fetch(`${homeserver}/_matrix/client/v3/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'm.login.password',
                user: room.username,
                password: room.password,
            }),
        });
        if (!loginResp.ok) {
            logger.error({ status: loginResp.status, intercom: room.username }, 'Intercom login failed');
            return false;
        }
        const { access_token } = (await loginResp.json());
        // Send message
        const txnId = `xroom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const encodedRoom = encodeURIComponent(roomId);
        const sendResp = await fetch(`${homeserver}/_matrix/client/v3/rooms/${encodedRoom}/send/m.room.message/${txnId}`, {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${access_token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ msgtype: 'm.text', body: text }),
        });
        // Logout (best effort)
        fetch(`${homeserver}/_matrix/client/v3/logout`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
            body: '{}',
        }).catch(() => { });
        if (!sendResp.ok) {
            logger.error({ status: sendResp.status, intercom: room.username }, 'Intercom send failed');
            return false;
        }
        logger.info({ targetJid, intercom: room.username }, 'Cross-room message sent via intercom');
        return true;
    }
    catch (err) {
        logger.error({ err, targetJid }, 'Intercom relay error');
        return false;
    }
}
//# sourceMappingURL=intercom-relay.js.map