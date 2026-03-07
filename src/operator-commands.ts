import { ASSISTANT_NAME } from 'nanoclaw/config.js';
import { logger } from 'nanoclaw/logger.js';
import type { MatrixChannel } from './channels/matrix.js';

const MY_NAME = ASSISTANT_NAME.toLowerCase();

// ── Main handler ───────────────────────────────────────────────────

/**
 * Bot-side operator command handler.
 * All ! commands are consumed (return true) so the bot doesn't treat them
 * as conversation. Actual responses go through the relay via intercom.
 */
export function handleOperatorCommand(
    msg: { sender: string; content: string; chat_jid: string; thread_id?: string },
    _matrix: MatrixChannel | null,
    _notifyBot?: (chatJid: string, content: string) => void,
): boolean {
    const cmd = msg.content.trim();
    if (!cmd.startsWith('!')) return false;

    logger.info({ cmd, sender: msg.sender, myName: MY_NAME }, 'operator command received — consumed (relay handles response)');
    return true; // consumed — relay responds via intercom
}

export function getCaptainUserId(): string {
    // Kept for backwards compat — relay reads from secrets/captain now
    return process.env.CAPTAIN_USER_ID || '';
}
