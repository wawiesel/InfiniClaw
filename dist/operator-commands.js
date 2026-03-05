import fs from 'fs';
import os from 'os';
import path from 'path';
import { ASSISTANT_NAME, DATA_DIR } from 'nanoclaw/config.js';
import { CAPTAIN_USER_ID } from './infini-config.js';
import { getAllRegisteredGroups, getSession } from 'nanoclaw/db.js';
import { logger } from 'nanoclaw/logger.js';
import { grantMount, revokeMount } from './allow-list.js';
import { loadMachineConfig } from './machine-config.js';
// ── Helpers ────────────────────────────────────────────────────────
const MY_NAME = ASSISTANT_NAME.toLowerCase();
const PERSONA = process.env.PERSONA_NAME || ASSISTANT_NAME.toLowerCase();
export function getCaptainUserId() {
    return CAPTAIN_USER_ID;
}
function isAuthorized(sender) {
    return (CAPTAIN_USER_ID && sender === CAPTAIN_USER_ID) || /-intercom:/.test(sender);
}
/** Parse "!cmd [target]" — returns target (lowercased) or undefined. */
function parseTarget(cmd, prefix) {
    if (cmd !== prefix && !cmd.startsWith(prefix + ' '))
        return { matched: false, forMe: false };
    const target = cmd.slice(prefix.length).trim().toLowerCase() || undefined;
    return { matched: true, target, forMe: !target || target === MY_NAME };
}
function reply(matrix, chatJid, text, threadId) {
    void (async () => {
        try {
            if (matrix?.isConnected())
                await matrix.sendMessage(chatJid, text, threadId);
        }
        catch (err) {
            logger.warn({ chatJid, err }, 'operator-commands reply failed');
        }
    })();
}
// ── Main handler ───────────────────────────────────────────────────
export function handleOperatorCommand(msg, matrix, notifyBot) {
    const cmd = msg.content.trim();
    if (cmd.startsWith('!')) {
        logger.info({ cmd, sender: msg.sender, myName: MY_NAME }, 'operator command received');
    }
    // !todo [bot]
    const todo = parseTarget(cmd, '!todo');
    if (todo.matched) {
        if (!todo.forMe)
            return true;
        try {
            reply(matrix, msg.chat_jid, buildTodoMessage(msg.chat_jid), msg.thread_id);
        }
        catch (err) {
            logger.error({ err }, '!todo failed');
        }
        return true;
    }
    // !dismiss, !join, !restart — handled by the supervisor process.
    // Bots no longer manage their own lifecycle. The supervisor watches
    // Matrix via intercom accounts and calls service.ts directly.
    if (cmd.startsWith('!dismiss') || cmd.startsWith('!join') || cmd.startsWith('!restart')) {
        return true; // consumed, no-op — supervisor handles it
    }
    // !roster — list bots on this machine
    if (cmd === '!roster') {
        reply(matrix, msg.chat_jid, `📋 ${os.hostname()}: ${loadMachineConfig().bots.join(', ')}`, msg.thread_id);
        return true;
    }
    // !operator — handled by the supervisor process.
    if (cmd.startsWith('!operator')) {
        return true; // consumed, no-op — supervisor handles it
    }
    // !allow <bot> <path> [minutes] — authorized only
    const grant = cmd.match(/^!allow\s+(\S+)\s+(\S+)(?:\s+(\d+))?/);
    if (grant) {
        if (!isAuthorized(msg.sender))
            return true;
        const [, botName, hostPath, mins] = grant;
        if (botName.toLowerCase() !== MY_NAME)
            return true;
        const defaultDuration = 30;
        const parsedDuration = parseInt(mins ?? String(defaultDuration), 10);
        let duration = parsedDuration <= 0 ? defaultDuration : parsedDuration;
        if (duration > 1440) {
            logger.warn({ requestedMinutes: parsedDuration, cappedMinutes: 1440, sender: msg.sender, hostPath }, '!allow duration capped to 24 hours');
            duration = 1440;
        }
        void (async () => {
            try {
                grantMount(PERSONA, hostPath, duration);
                const expiry = new Date(Date.now() + duration * 60 * 1000).toLocaleTimeString();
                const notice = `✅ Mount granted: ${hostPath} (read-write, expires ~${expiry})\nRestart required to pick up new mount.`;
                reply(matrix, msg.chat_jid, notice, msg.thread_id);
                notifyBot?.(msg.chat_jid, notice);
            }
            catch (err) {
                reply(matrix, msg.chat_jid, `⛔ !allow failed: ${err instanceof Error ? err.message : String(err)}`, msg.thread_id);
            }
        })();
        return true;
    }
    // !deny <bot> <path> — authorized only
    const revoke = cmd.match(/^!deny\s+(\S+)\s+(\S+)/);
    if (revoke) {
        if (!isAuthorized(msg.sender))
            return true;
        const [, botName, hostPath] = revoke;
        if (botName.toLowerCase() !== MY_NAME)
            return true;
        void (async () => {
            try {
                const removed = revokeMount(PERSONA, hostPath);
                reply(matrix, msg.chat_jid, removed ? `✅ Mount revoked: ${hostPath}` : `ℹ️ No mount found for: ${hostPath}`, msg.thread_id);
            }
            catch (err) {
                reply(matrix, msg.chat_jid, `⛔ !deny failed: ${err instanceof Error ? err.message : String(err)}`, msg.thread_id);
            }
        })();
        return true;
    }
    return false;
}
const STATUS_ICON = { in_progress: '🔧', pending: '⏳', completed: '✅' };
export function readTodoItems(folder) {
    const todosDir = path.join(DATA_DIR, 'sessions', folder, '.claude', 'todos');
    if (!fs.existsSync(todosDir))
        return [];
    const sessionId = getSession(folder);
    if (!sessionId)
        return [];
    const sessionFile = path.join(todosDir, `${sessionId}-agent-${sessionId}.json`);
    if (!fs.existsSync(sessionFile))
        return [];
    try {
        const raw = fs.readFileSync(sessionFile, 'utf-8').trim();
        if (!raw || raw === '[]')
            return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((t) => t && typeof t === 'object' && 'content' in t && 'status' in t);
    }
    catch {
        return [];
    }
}
export function buildTodoMessage(chatJid) {
    const groups = getAllRegisteredGroups();
    const group = groups[chatJid];
    if (!group)
        return `📋 ${ASSISTANT_NAME}\n\nRoom not registered.`;
    const items = readTodoItems(group.folder);
    const lines = [`📋 ${ASSISTANT_NAME} — ${group.name}\n`];
    if (items.length === 0) {
        lines.push('No active tasks.');
    }
    else {
        for (const item of items)
            lines.push(`${STATUS_ICON[item.status] ?? '·'} ${item.content}`);
    }
    lines.push('');
    const statusPath = path.join(DATA_DIR, 'ipc', group.folder, 'status.json');
    try {
        const snap = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
        const g = snap.groups?.find((s) => s.folder === group.folder);
        const objective = g?.lastProgress || g?.currentObjective;
        lines.push(g?.active ? `Currently: ${objective ? objective.slice(0, 200) : 'working'}` : 'Currently: idle');
    }
    catch {
        lines.push('Currently: idle');
    }
    return lines.join('\n');
}
//# sourceMappingURL=operator-commands.js.map