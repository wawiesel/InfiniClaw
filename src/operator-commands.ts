import fs from 'fs';
import path from 'path';
import { parseEnvLine } from 'nanoclaw/env-utils.js';
import { CAPTAIN_USER_ID } from 'nanoclaw/config.js';
import { logger } from 'nanoclaw/logger.js';
import { grantTemporaryMount, revokeMount } from 'nanoclaw/mount-security.js';
import type { MatrixChannel } from './channels/matrix.js';

export function getCaptainUserId(): string {
    const profileEnvPath = path.join(
        process.env.INFINICLAW_ROOT || path.resolve(process.cwd(), '..', '..', '..'),
        'bots', 'profiles', 'engineer', 'env'
    );

    if (fs.existsSync(profileEnvPath)) {
        for (const line of fs.readFileSync(profileEnvPath, 'utf-8').split('\n')) {
            const parsed = parseEnvLine(line);
            if (parsed?.[0] === 'CAPTAIN_USER_ID') return parsed[1].trim();
        }
    }
    return CAPTAIN_USER_ID;
}

export function handleOperatorCommand(
    msg: { sender: string; content: string; chat_jid: string },
    matrix: MatrixChannel | null
): boolean {
    const captainUserId = getCaptainUserId();

    if (!msg.content.startsWith('!grant-mount') &&
        !msg.content.startsWith('!revoke-mount') &&
        !msg.content.startsWith('!restart-wksm')) {
        return false;
    }

    logger.info({ sender: msg.sender, captainUserId, content: msg.content.slice(0, 50) }, 'handleOperatorCommand');

    if (!captainUserId || msg.sender !== captainUserId) {
        void (async () => {
            if (matrix?.isConnected()) {
                await matrix.sendMessage(msg.chat_jid, `⛔ Unauthorized: only the Captain can run mount or system commands.`);
            }
        })();
        return true;
    }

    const grant = msg.content.match(/^!grant-mount\s+(\S+)(?:\s+(\d+))?/);
    if (grant) {
        const [, hostPath, mins] = grant;
        const duration = parseInt(mins ?? '30', 10);
        logger.info({ hostPath, duration }, 'grant-mount command');
        void (async () => {
            try {
                grantTemporaryMount(hostPath, true, duration, undefined, process.env.PERSONA_NAME);
                const expiry = new Date(Date.now() + duration * 60 * 1000).toLocaleTimeString();
                if (matrix?.isConnected()) {
                    await matrix.sendMessage(msg.chat_jid, `✅ Mount granted: ${hostPath} (read-write, expires ~${expiry})\nRestart required to pick up new mount.`);
                }
            } catch (err) {
                if (matrix?.isConnected()) {
                    await matrix.sendMessage(msg.chat_jid, `⛔ grant-mount failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        })();
        return true;
    }

    const revoke = msg.content.match(/^!revoke-mount\s+(\S+)/);
    if (revoke) {
        const hostPath = revoke[1];
        logger.info({ hostPath }, 'revoke-mount command');
        void (async () => {
            const removed = revokeMount(hostPath);
            if (matrix?.isConnected()) {
                await matrix.sendMessage(msg.chat_jid, removed ? `✅ Mount revoked: ${hostPath}` : `ℹ️ No mount found for: ${hostPath}`);
            }
        })();
        return true;
    }

    if (msg.content.trim() === '!restart-wksm') {
        logger.info('restart-wksm command');
        void (async () => {
            try {
                if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, '🔄 Restarting wksm...');
                const { execSync } = await import('child_process');
                const home = process.env.HOME || '/Users/ww5';
                const wksc = `${home}/2025-WKS/main/venv/bin/wksc`;

                const killOut = execSync(`/usr/sbin/lsof -ti:8765 | xargs kill -9 2>&1 || echo "no process on 8765"`, { shell: '/bin/bash' }).toString().trim();
                if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, `kill: ${killOut}`);
                await new Promise(r => setTimeout(r, 2000));

                const startOut = execSync(`${wksc} mcp proxy start 2>&1`, { shell: '/bin/bash' }).toString().trim();
                if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, `start: ${startOut}`);
                await new Promise(r => setTimeout(r, 2000));

                const health = execSync('curl -s http://localhost:8765/health', { shell: '/bin/bash' }).toString().trim();
                if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, `health: ${health}`);
            } catch (err) {
                if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, `⛔ restart-wksm failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        })();
        return true;
    }

    return false;
}
