import fs from 'fs';
import os from 'os';
import path from 'path';
import { ASSISTANT_NAME, DATA_DIR } from 'nanoclaw/config.js';
import { CAPTAIN_USER_ID } from './infini-config.js';
import { getAllRegisteredGroups, getSession } from 'nanoclaw/db.js';
import { logger } from 'nanoclaw/logger.js';
import { grantMount, revokeMount } from './allow-list.js';
import { loadMachineConfig } from './machine-config.js';
import type { MatrixChannel } from './channels/matrix.js';

// ── Helpers ────────────────────────────────────────────────────────

const MY_NAME = ASSISTANT_NAME.toLowerCase();
const PERSONA = process.env.PERSONA_NAME || ASSISTANT_NAME.toLowerCase();
let cachedIntercomSenders: Set<string> | null = null;

interface IntercomConfig {
    homeserver?: unknown;
    rooms?: Record<string, { username?: unknown }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function resolveIntercomSender(username: string, homeserver: string): string | null {
    const trimmed = username.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('@')) {
        return /^@[^:\s]+:[^\s]+$/.test(trimmed) ? trimmed : null;
    }
    if (!/^[^:\s@]+$/.test(trimmed)) return null;
    try {
        const domain = new URL(homeserver).host;
        return domain ? `@${trimmed}:${domain}` : null;
    } catch {
        return null;
    }
}

function getAuthorizedIntercomSenders(): Set<string> {
    if (cachedIntercomSenders) return cachedIntercomSenders;
    const senders = new Set<string>();
    try {
        const configPath = path.join(loadMachineConfig().secretsPath, 'operator', 'intercom.json');
        if (!fs.existsSync(configPath)) {
            cachedIntercomSenders = senders;
            return senders;
        }
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as IntercomConfig;
        if (!isObject(parsed) || typeof parsed.homeserver !== 'string' || !isObject(parsed.rooms)) {
            cachedIntercomSenders = senders;
            return senders;
        }
        for (const room of Object.values(parsed.rooms)) {
            if (!isObject(room) || typeof room.username !== 'string') continue;
            const sender = resolveIntercomSender(room.username, parsed.homeserver);
            if (sender) senders.add(sender);
        }
    } catch (err) {
        logger.warn({ err }, 'Failed to load intercom authorization config');
    }
    cachedIntercomSenders = senders;
    return senders;
}


export function getCaptainUserId(): string {
    return CAPTAIN_USER_ID;
}

function isAuthorized(sender: string): boolean {
    return (CAPTAIN_USER_ID && sender === CAPTAIN_USER_ID) || getAuthorizedIntercomSenders().has(sender);
}

/** Parse "!cmd [target]" — returns target (lowercased) or undefined. */
function parseTarget(cmd: string, prefix: string): { matched: boolean; target?: string; forMe: boolean } {
    if (cmd !== prefix && !cmd.startsWith(prefix + ' ')) return { matched: false, forMe: false };
    const target = cmd.slice(prefix.length).trim().toLowerCase() || undefined;
    return { matched: true, target, forMe: !target || target === MY_NAME };
}

function reply(matrix: MatrixChannel | null, chatJid: string, text: string, threadId?: string): void {
    void (async () => {
        try {
            if (matrix?.isConnected()) await matrix.sendMessage(chatJid, text, threadId);
        } catch (err) {
            logger.warn({ chatJid, err }, 'operator-commands reply failed');
        }
    })();
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

    // !dismiss, !join, !restart — handled by the relay process.
    if (cmd.startsWith('!dismiss') || cmd.startsWith('!join') || cmd.startsWith('!restart')) {
        return true; // consumed, no-op — relay handles it
    }

    // !operator — handled by the relay process.
    if (cmd.startsWith('!operator')) {
        return true; // consumed, no-op — relay handles it
    }

    // !allow <bot> <path> [minutes] — authorized only
    const grant = cmd.match(/^!allow\s+(\S+)\s+(\S+)(?:\s+(\d+))?$/);
    if (grant) {
        if (!isAuthorized(msg.sender)) return true;
        const [, botName, hostPath, mins] = grant;
        if (botName.toLowerCase() !== MY_NAME) return true;
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
            } catch (err) {
                reply(matrix, msg.chat_jid, `⛔ !allow failed: ${err instanceof Error ? err.message : String(err)}`, msg.thread_id);
            }
        })();
        return true;
    }

    // !deny <bot> <path> — authorized only
    const revoke = cmd.match(/^!deny\s+(\S+)\s+(\S+)$/);
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

    // ! (bare) — print operator command help
    if (cmd === '!') {
        const help = [
            '📟 Operator commands:',
            '  !todo [bot]               — show bot\'s active tasks',
            '  !fleet                    — full fleet + machine status',
            '  !fleet room               — bots in this room only',
            '  !dismiss <bot>            — stop a bot',
            '  !join <bot>               — start a bot',
            '  !restart <bot>            — restart a bot',
            '  !transport <bot> <machine> — move bot to another machine',
            '  !promote <bot>            — raise rank within role',
            '  !demote <bot>             — lower rank within role',
            '  !activate                 — activate this machine',
            '  !deactivate               — stop all bots, keep relay',
            '  !allow <bot> <path> [min] — grant rw mount (authorized)',
            '  !deny <bot> <path>        — revoke rw mount (authorized)',
            '  !operator <cmd>           — send to operator tmux',
            '  !health                   — fleet health summary',
            '  !                         — this help',
        ].join('\n');
        reply(matrix, msg.chat_jid, help, msg.thread_id);
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
