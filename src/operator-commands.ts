import fs from 'fs';
import path from 'path';
import { parseEnvFile } from 'nanoclaw/env-utils.js';
import { ASSISTANT_NAME, CAPTAIN_USER_ID, DATA_DIR } from 'nanoclaw/config.js';
import { getAllRegisteredGroups, getSession } from 'nanoclaw/db.js';
import { logger } from 'nanoclaw/logger.js';
import { grantMount, revokeMount } from './allow-list.js';
import type { MatrixChannel } from './channels/matrix.js';

export function getCaptainUserId(): string {
    const profileEnvPath = path.join(
        process.env.INFINICLAW_ROOT || path.resolve(process.cwd(), '..', '..', '..'),
        'bots', 'profiles', 'engineer', 'env'
    );
    try {
        if (fs.existsSync(profileEnvPath)) {
            const vars = parseEnvFile(profileEnvPath);
            if (vars.CAPTAIN_USER_ID) return vars.CAPTAIN_USER_ID.trim();
        }
    } catch { /* best effort */ }
    return CAPTAIN_USER_ID;
}

export function handleOperatorCommand(
    msg: { sender: string; content: string; chat_jid: string },
    matrix: MatrixChannel | null,
    notifyBot?: (chatJid: string, content: string) => void,
): boolean {
    const captainUserId = getCaptainUserId();

    if (msg.content.trim() === '!todo') {
        void (async () => {
            try {
                const text = buildTodoMessage(msg.chat_jid);
                if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, text);
            } catch (err) {
                logger.error({ err }, '!todo failed');
                if (matrix?.isConnected()) await matrix.sendMessage(msg.chat_jid, `⛔ !todo failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        })();
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
                await matrix.sendMessage(msg.chat_jid, `⛔ Unauthorized: only the Captain can run mount or system commands.`);
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
                    await matrix.sendMessage(msg.chat_jid, notice);
                }
                notifyBot?.(msg.chat_jid, notice);
            } catch (err) {
                if (matrix?.isConnected()) {
                    await matrix.sendMessage(msg.chat_jid, `⛔ !allow failed: ${err instanceof Error ? err.message : String(err)}`);
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
            const removed = revokeMount(process.env.PERSONA_NAME!, hostPath);
            if (matrix?.isConnected()) {
                await matrix.sendMessage(msg.chat_jid, removed ? `✅ Mount revoked: ${hostPath}` : `ℹ️ No mount found for: ${hostPath}`);
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
