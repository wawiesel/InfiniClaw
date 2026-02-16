/**
 * Cross-bot message routing.
 *
 * Config-driven: all functions are no-ops when CROSS_BOT_ROOM_JID is unset.
 * This module is fork-only — upstream nanoclaw does not have it.
 */
import {
  ASSISTANT_NAME,
  CROSS_BOT_PATTERN,
  CROSS_BOT_ROOM_JID,
  IGNORE_PATTERNS,
  IGNORE_SENDERS,
} from './config.js';
import { logger } from './logger.js';
import { Channel, NewMessage } from './types.js';

// ─── Message filtering ──────────────────────────────────────────

/** Returns true if the message text is addressed to another bot's trigger. */
export function isIgnoredTrigger(text: string): boolean {
  if (IGNORE_PATTERNS.length === 0) return false;
  const trimmed = text.trim();
  return IGNORE_PATTERNS.some((p) => p.test(trimmed));
}

/** Returns true if the message should be silently dropped (other bot's output or trigger). */
export function shouldIgnoreMessage(msg: NewMessage): boolean {
  if (IGNORE_SENDERS.size > 0 && IGNORE_SENDERS.has(msg.sender)) {
    return true;
  }
  if (isIgnoredTrigger(msg.content.trim())) {
    return true;
  }
  return false;
}

// ─── Cross-bot room guard ───────────────────────────────────────

/** Returns true if the JID is the cross-bot relay room (should not be auto-registered). */
export function isCrossBotRoom(jid: string): boolean {
  return !!CROSS_BOT_ROOM_JID && jid === CROSS_BOT_ROOM_JID;
}

// ─── Outbound forwarding ────────────────────────────────────────

/**
 * Check if outbound bot text matches the cross-bot pattern and forward it.
 * This enables bot-to-bot communication: when a bot says "@OtherBot <msg>",
 * the host forwards it to the other bot's room.
 */
export async function maybeCrossBotForward(
  chatJid: string,
  text: string,
  findChannel: (jid: string) => Channel | undefined,
  getGroupName: (jid: string) => string | undefined,
): Promise<void> {
  if (!CROSS_BOT_PATTERN || !CROSS_BOT_ROOM_JID) return;
  // Use non-anchored pattern — bot output may have preamble before the @mention
  const unanchored = new RegExp(
    CROSS_BOT_PATTERN.source.replace(/^\^/, ''),
    CROSS_BOT_PATTERN.flags,
  );
  if (!unanchored.test(text)) return;
  const ch = findChannel(CROSS_BOT_ROOM_JID);
  if (!ch) return;
  const sourceName = getGroupName(chatJid) || chatJid;
  const forwarded = `[From ${sourceName}] ${ASSISTANT_NAME}: ${text}`;
  try {
    await ch.sendMessage(CROSS_BOT_ROOM_JID, forwarded);
    logger.info({ chatJid, target: CROSS_BOT_ROOM_JID }, 'Forwarded cross-bot outbound message');
  } catch (err) {
    logger.warn({ chatJid, err }, 'Failed to forward cross-bot outbound message');
  }
}

// ─── Inbound forwarding ─────────────────────────────────────────

/**
 * Forward inbound messages addressed to another bot to the cross-bot room.
 * Returns the messages that should NOT be forwarded (i.e. for this bot).
 */
export async function forwardCrossBotMessages(
  chatJid: string,
  messages: NewMessage[],
  groupName: string,
  findChannel: (jid: string) => Channel | undefined,
): Promise<NewMessage[]> {
  if (!CROSS_BOT_PATTERN || !CROSS_BOT_ROOM_JID) return messages;

  const forOtherBot = messages.filter((m) => CROSS_BOT_PATTERN!.test(m.content.trim()));
  if (forOtherBot.length === 0) return messages;

  const ch = findChannel(CROSS_BOT_ROOM_JID);
  if (ch) {
    for (const msg of forOtherBot) {
      const forwarded = `[From ${groupName}] ${msg.sender_name}: ${msg.content}`;
      try {
        await ch.sendMessage(CROSS_BOT_ROOM_JID, forwarded);
      } catch (err) {
        logger.warn({ chatJid, err }, 'Failed to forward cross-bot message');
      }
    }
    logger.info(
      { chatJid, target: CROSS_BOT_ROOM_JID, count: forOtherBot.length },
      'Forwarded cross-bot messages',
    );
  }

  // Remove forwarded messages from the set to process locally
  const forwardedIds = new Set(forOtherBot.map((m) => m.id));
  return messages.filter((m) => !forwardedIds.has(m.id));
}
