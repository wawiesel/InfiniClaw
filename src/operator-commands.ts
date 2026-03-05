import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ASSISTANT_NAME, DATA_DIR } from 'nanoclaw/config.js';
import { CAPTAIN_USER_ID } from './infini-config.js';
import { getAllRegisteredGroups, getSession } from 'nanoclaw/db.js';
import { logger } from 'nanoclaw/logger.js';
import { grantMount, revokeMount } from './allow-list.js';
import { loadMachineConfig } from './machine-config.js';
import { stopContainersByPrefix } from 'nanoclaw/podman-utils.js';
import type { MatrixChannel } from './channels/matrix.js';

// ── Helpers ────────────────────────────────────────────────────────

const MY_NAME = ASSISTANT_NAME.toLowerCase();
const PERSONA = process.env.PERSONA_NAME || ASSISTANT_NAME.toLowerCase();

function sendIntercom(room: string, message: string): void {
    const script = path.join(loadMachineConfig().secretsPath, 'operator', 'intercom-send.sh');
    execSync(`bash "${script}" "${room}" "${message}"`, { stdio: 'pipe', timeout: 15000 });
}

export function getCaptainUserId(): string {
    return CAPTAIN_USER_ID;
}

function isAuthorized(sender: string): boolean {
    return (CAPTAIN_USER_ID && sender === CAPTAIN_USER_ID) || /-intercom:/.test(sender);
}

/** Parse "!cmd [target]" — returns target (lowercased) or undefined. */
function parseTarget(cmd: string, prefix: string): { matched: boolean; target?: string; forMe: boolean } {
    if (cmd !== prefix && !cmd.startsWith(prefix + ' ')) return { matched: false, forMe: false };
    const target = cmd.slice(prefix.length).trim().toLowerCase() || undefined;
    return { matched: true, target, forMe: !target || target === MY_NAME };
}

function reply(matrix: MatrixChannel | null, chatJid: string, text: string, threadId?: string): void {
    void (async () => {
        if (matrix?.isConnected()) await matrix.sendMessage(chatJid, text, threadId);
    })();
}

// ── Dormant mode ──────────────────────────────────────────────────

let dismissed = false;

export function isDismissed(): boolean {
    return dismissed;
}

// ── Main handler ───────────────────────────────────────────────────

export function handleOperatorCommand(
    msg: { sender: string; content: string; chat_jid: string; thread_id?: string },
    matrix: MatrixChannel | null,
    notifyBot?: (chatJid: string, content: string) => void,
): boolean {
    const cmd = msg.content.trim();

    if (cmd.startsWith('!')) {
        logger.info({ cmd, sender: msg.sender, myName: MY_NAME }, 'operator command received');
    }

    // !todo [bot]
    const todo = parseTarget(cmd, '!todo');
    if (todo.matched) {
        if (!todo.forMe) return true;
        try {
            reply(matrix, msg.chat_jid, buildTodoMessage(msg.chat_jid), msg.thread_id);
        } catch (err) {
            logger.error({ err }, '!todo failed');
        }
        return true;
    }

    // !dismiss [bot] — enter dormant mode
    const dismiss = parseTarget(cmd, '!dismiss');
    if (dismiss.matched) {
        if (!dismiss.forMe) return true;
        dismissed = true;
        logger.info('Entering dormant mode');
        stopContainersByPrefix(`nanoclaw-${PERSONA}-`);
        void (async () => {
            const room = (process.env.MAIN_GROUP_NAME || '').toLowerCase();
            try { sendIntercom(room, `${ASSISTANT_NAME} has left`); } catch { /* */ }
            if (matrix?.isConnected()) await matrix.setDisplayName(`${ASSISTANT_NAME} 🔴`);
        })();
        return true;
    }

    // !join [bot] — exit dormant mode
    const join = parseTarget(cmd, '!join');
    if (join.matched) {
        if (!join.forMe) return true;
        dismissed = false;
        logger.info('Exiting dormant mode');
        void (async () => {
            const room = (process.env.MAIN_GROUP_NAME || '').toLowerCase();
            try { sendIntercom(room, `${ASSISTANT_NAME} has joined`); } catch { /* */ }
            if (matrix?.isConnected()) await matrix.setDisplayName(`${ASSISTANT_NAME} 🟢`);
        })();
        return true;
    }

    // !restart [bot] — exit process, launchd brings it back with fresh container
    const restart = parseTarget(cmd, '!restart');
    if (restart.matched) {
        if (!restart.forMe) return true;
        logger.info('Restarting via process exit (launchd KeepAlive)');
        void (async () => {
            const room = (process.env.MAIN_GROUP_NAME || '').toLowerCase();
            try { sendIntercom(room, `${ASSISTANT_NAME} is restarting`); } catch { /* */ }
            if (matrix?.isConnected()) await matrix.setDisplayName(`${ASSISTANT_NAME} 🔄`);
            // Give intercom/display name a moment to send
            await new Promise(r => setTimeout(r, 1000));
            process.exit(0);
        })();
        return true;
    }

    // !roster — list bots on this machine
    if (cmd === '!roster') {
        reply(matrix, msg.chat_jid, `📋 ${os.hostname()}: ${loadMachineConfig().bots.join(', ')}`, msg.thread_id);
        return true;
    }

    // !operator — authorized only
    if (cmd.startsWith('!operator')) {
        if (!isAuthorized(msg.sender)) return false;
        handleOperatorTmux(cmd.replace(/^!operator\s*/, '').trim(), msg.chat_jid, msg.thread_id, matrix);
        return true;
    }

    // !allow <bot> <path> [minutes] — authorized only
    const grant = cmd.match(/^!allow\s+(\S+)\s+(\S+)(?:\s+(\d+))?/);
    if (grant) {
        if (!isAuthorized(msg.sender)) return true;
        const [, botName, hostPath, mins] = grant;
        if (botName.toLowerCase() !== MY_NAME) return true;
        const duration = parseInt(mins ?? '30', 10);
        void (async () => {
            try {
                grantMount(PERSONA, hostPath, duration);
                const expiry = new Date(Date.now() + duration * 60 * 1000).toLocaleTimeString();
                const notice = `✅ Mount granted: ${hostPath} (read-write, expires ~${expiry})\nRestart required to pick up new mount.`;
                reply(matrix, msg.chat_jid, notice, msg.thread_id);
                notifyBot?.(msg.chat_jid, notice);
            } catch (err) {
                reply(matrix, msg.chat_jid, `⛔ !allow failed: ${err instanceof Error ? err.message : String(err)}`, msg.thread_id);
            }
        })();
        return true;
    }

    // !deny <bot> <path> — authorized only
    const revoke = cmd.match(/^!deny\s+(\S+)\s+(\S+)/);
    if (revoke) {
        if (!isAuthorized(msg.sender)) return true;
        const [, botName, hostPath] = revoke;
        if (botName.toLowerCase() !== MY_NAME) return true;
        void (async () => {
            try {
                const removed = revokeMount(PERSONA, hostPath);
                reply(matrix, msg.chat_jid, removed ? `✅ Mount revoked: ${hostPath}` : `ℹ️ No mount found for: ${hostPath}`, msg.thread_id);
            } catch (err) {
                reply(matrix, msg.chat_jid, `⛔ !deny failed: ${err instanceof Error ? err.message : String(err)}`, msg.thread_id);
            }
        })();
        return true;
    }

    return false;
}

// ── !todo helpers ──────────────────────────────────────────────────

interface TodoItem { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }
const STATUS_ICON: Record<string, string> = { in_progress: '🔧', pending: '⏳', completed: '✅' };

export function readTodoItems(folder: string): TodoItem[] {
    const todosDir = path.join(DATA_DIR, 'sessions', folder, '.claude', 'todos');
    if (!fs.existsSync(todosDir)) return [];
    const sessionId = getSession(folder);
    if (!sessionId) return [];
    const sessionFile = path.join(todosDir, `${sessionId}-agent-${sessionId}.json`);
    if (!fs.existsSync(sessionFile)) return [];
    try {
        const raw = fs.readFileSync(sessionFile, 'utf-8').trim();
        if (!raw || raw === '[]') return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((t: unknown) => t && typeof t === 'object' && 'content' in t && 'status' in t) as TodoItem[];
    } catch { return []; }
}

export function buildTodoMessage(chatJid: string): string {
    const groups = getAllRegisteredGroups();
    const group = groups[chatJid];
    if (!group) return `📋 ${ASSISTANT_NAME}\n\nRoom not registered.`;
    const items = readTodoItems(group.folder);
    const lines: string[] = [`📋 ${ASSISTANT_NAME} — ${group.name}\n`];
    if (items.length === 0) {
        lines.push('No active tasks.');
    } else {
        for (const item of items) lines.push(`${STATUS_ICON[item.status] ?? '·'} ${item.content}`);
    }
    lines.push('');
    const statusPath = path.join(DATA_DIR, 'ipc', group.folder, 'status.json');
    try {
        const snap = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
        const g = snap.groups?.find((s: { folder: string }) => s.folder === group.folder);
        const objective = g?.lastProgress || g?.currentObjective;
        lines.push(g?.active ? `Currently: ${objective ? objective.slice(0, 200) : 'working'}` : 'Currently: idle');
    } catch { lines.push('Currently: idle'); }
    return lines.join('\n');
}

// ── !operator tmux handler ─────────────────────────────────────────

const OPERATOR_SESSION = 'operator';

function handleOperatorTmux(text: string, chatJid: string, threadId: string | undefined, matrix: MatrixChannel | null): void {
    void (async () => {
        try {
            let existed = true;
            try { execFileSync('tmux', ['has-session', '-t', OPERATOR_SESSION], { stdio: 'pipe' }); } catch { existed = false; }
            if (!existed) {
                execFileSync('tmux', ['new-session', '-d', '-s', OPERATOR_SESSION, '-c', loadMachineConfig().secretsPath, 'claude'], { stdio: ['pipe', 'pipe', 'pipe'] });
                await new Promise(r => setTimeout(r, 3000));
            }
            if (text) execFileSync('tmux', ['send-keys', '-t', OPERATOR_SESSION, text, 'Enter'], { stdio: 'pipe' });
            const status = existed ? 'sent to running operator' : 'started new operator session';
            const msg = text ? `🔧 ${os.hostname()}: ${status} — "${text.slice(0, 100)}"` : `🔧 ${os.hostname()}: ${status}`;
            reply(matrix, chatJid, msg, threadId);
        } catch (err) {
            logger.error({ err }, '!operator failed');
            reply(matrix, chatJid, `⛔ !operator failed: ${err instanceof Error ? err.message : String(err)}`, threadId);
        }
    })();
}
