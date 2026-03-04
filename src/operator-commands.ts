import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseEnvFile } from 'nanoclaw/env-utils.js';
import { ASSISTANT_NAME, DATA_DIR } from 'nanoclaw/config.js';
import { CAPTAIN_USER_ID } from './infini-config.js';
import { getAllRegisteredGroups, getSession } from 'nanoclaw/db.js';
import { logger } from 'nanoclaw/logger.js';
import { grantMount, revokeMount } from './allow-list.js';
import { loadMachineConfig } from './machine-config.js';
import type { MatrixChannel } from './channels/matrix.js';

export function getCaptainUserId(): string {
    // CAPTAIN_USER_ID is already loaded from the current bot's env at startup
    return CAPTAIN_USER_ID;
}

export function handleOperatorCommand(
    msg: { sender: string; content: string; chat_jid: string; thread_id?: string },
    matrix: MatrixChannel | null,
    notifyBot?: (chatJid: string, content: string) => void,
): boolean {
    const captainUserId = getCaptainUserId();

    if (msg.content.trim() === '!todo') {
        void (async () => {
            try {
                const text = buildTodoMessage(msg.chat_jid);
                if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, text, msg.thread_id);
            } catch (err) {
                logger.error({ err }, '!todo failed');
                if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, `⛔ !todo failed: ${err instanceof Error ? err.message : String(err)}`, msg.thread_id);
            }
        })();
        return true;
    }

    if (msg.content.startsWith('!operator')) {
        const text = msg.content.replace(/^!operator\s*/, '').trim();
        handleOperatorTmux(text, msg.chat_jid, msg.thread_id, matrix);
        return true;
    }

    if (!msg.content.startsWith('!allow') &&
        !msg.content.startsWith('!deny')) {
        return false;
    }

    logger.info({ sender: msg.sender, captainUserId, content: msg.content.slice(0, 50) }, 'handleOperatorCommand');

    if (!captainUserId || msg.sender !== captainUserId) {
        void (async () => {
            if (matrix?.isConnected()) {
                await matrix.sendMessage(msg.chat_jid, `⛔ Unauthorized: only the Captain can run mount or system commands.`, msg.thread_id);
            }
        })();
        return true;
    }

    const grant = msg.content.match(/^!allow\s+(\S+)(?:\s+(\d+))?/);
    if (grant) {
        const [, hostPath, mins] = grant;
        const duration = parseInt(mins ?? '30', 10);
        logger.info({ hostPath, duration }, '!allow command');
        void (async () => {
            try {
                grantMount(process.env.PERSONA_NAME!, hostPath, duration);
                const expiry = new Date(Date.now() + duration * 60 * 1000).toLocaleTimeString();
                const notice = `✅ Mount granted: ${hostPath} (read-write, expires ~${expiry})\nRestart required to pick up new mount.`;
                if (matrix?.isConnected()) {
                    await matrix.sendMessage(msg.chat_jid, notice, msg.thread_id);
                }
                notifyBot?.(msg.chat_jid, notice);
            } catch (err) {
                if (matrix?.isConnected()) {
                    await matrix.sendMessage(msg.chat_jid, `⛔ !allow failed: ${err instanceof Error ? err.message : String(err)}`, msg.thread_id);
                }
            }
        })();
        return true;
    }

    const revoke = msg.content.match(/^!deny\s+(\S+)/);
    if (revoke) {
        const hostPath = revoke[1];
        logger.info({ hostPath }, '!deny command');
        void (async () => {
            try {
                const removed = revokeMount(process.env.PERSONA_NAME!, hostPath);
                if (matrix?.isConnected()) {
                    await matrix.sendMessage(msg.chat_jid, removed ? `✅ Mount revoked: ${hostPath}` : `ℹ️ No mount found for: ${hostPath}`, msg.thread_id);
                }
            } catch (err) {
                if (matrix?.isConnected()) {
                    await matrix.sendMessage(msg.chat_jid, `⛔ !deny failed: ${err instanceof Error ? err.message : String(err)}`, msg.thread_id);
                }
            }
        })();
        return true;
    }

    return false;
}

// ── !todo helpers ──────────────────────────────────────────────────

interface TodoItem {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm?: string;
}

const STATUS_ICON: Record<string, string> = {
    in_progress: '🔧',
    pending: '⏳',
    completed: '✅',
};

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
        return parsed.filter((t: unknown) =>
            t && typeof t === 'object' && 'content' in t && 'status' in t
        ) as TodoItem[];
    } catch {
        return [];
    }
}

interface StatusSnapshot {
    groups?: Array<{
        folder: string;
        active?: boolean;
        currentObjective?: string;
        lastProgress?: string;
    }>;
}

function readStatus(folder: string): { active: boolean; currentObjective?: string; lastProgress?: string } {
    const statusPath = path.join(DATA_DIR, 'ipc', folder, 'status.json');
    try {
        const raw = fs.readFileSync(statusPath, 'utf-8');
        const snap: StatusSnapshot = JSON.parse(raw);
        const group = snap.groups?.find(g => g.folder === folder);
        return {
            active: group?.active ?? false,
            currentObjective: group?.currentObjective,
            lastProgress: group?.lastProgress,
        };
    } catch {
        return { active: false };
    }
}

export function buildTodoMessage(chatJid: string): string {
    // Look up which room folder this JID maps to
    const groups = getAllRegisteredGroups();
    const group = groups[chatJid];
    if (!group) return `📋 ${ASSISTANT_NAME}\n\nRoom not registered.`;

    const folder = group.folder;
    const items = readTodoItems(folder);
    const status = readStatus(folder);

    const lines: string[] = [`📋 ${ASSISTANT_NAME} — ${group.name}\n`];

    if (items.length === 0) {
        lines.push('No active tasks.');
    } else {
        for (const item of items) {
            const icon = STATUS_ICON[item.status] ?? '·';
            lines.push(`${icon} ${item.content}`);
        }
    }

    lines.push('');
    if (status.active) {
        const objective = status.lastProgress || status.currentObjective;
        lines.push(`Currently: ${objective ? objective.slice(0, 200) : 'working'}`);
    } else {
        lines.push('Currently: idle');
    }

    return lines.join('\n');
}

// ── !operator tmux handler ──────────────────────────────────────────

const OPERATOR_SESSION = 'operator';

function tmuxSessionExists(): boolean {
    try {
        execFileSync('tmux', ['has-session', '-t', OPERATOR_SESSION], { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

function startOperatorSession(): string {
    const secretsPath = loadMachineConfig().secretsPath;
    const result = execFileSync('tmux', [
        'new-session', '-d', '-s', OPERATOR_SESSION, '-c', secretsPath,
        'claude',
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    logger.info({ secretsPath }, 'Started operator tmux session');
    return result;
}

function sendToOperator(text: string): void {
    execFileSync('tmux', ['send-keys', '-t', OPERATOR_SESSION, text, 'Enter'], { stdio: 'pipe' });
}

function handleOperatorTmux(
    text: string,
    chatJid: string,
    threadId: string | undefined,
    matrix: MatrixChannel | null,
): void {
    void (async () => {
        try {
            const existed = tmuxSessionExists();
            if (!existed) {
                startOperatorSession();
                // Give Claude Code a moment to initialize
                await new Promise(r => setTimeout(r, 3000));
            }
            if (text) {
                sendToOperator(text);
            }
            const hostname = os.hostname();
            const status = existed ? 'sent to running operator' : 'started new operator session';
            const reply = text
                ? `🔧 ${hostname}: ${status} — "${text.slice(0, 100)}"`
                : `🔧 ${hostname}: ${status}`;
            if (matrix?.isConnected()) await matrix.sendMessage(chatJid, reply, threadId);
        } catch (err) {
            logger.error({ err }, '!operator failed');
            if (matrix?.isConnected()) {
                await matrix.sendMessage(chatJid, `⛔ !operator failed: ${err instanceof Error ? err.message : String(err)}`, threadId);
            }
        }
    })();
}
