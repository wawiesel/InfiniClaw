import { NewMessage } from 'nanoclaw/types.js';

export function shouldIgnoreMessage(msg: NewMessage, botMatrixUserIds: Set<string>): boolean {
  if (msg.is_from_me) return true;
  if (botMatrixUserIds.has(msg.sender)) return true;
  // Ignore status updates
  if (msg.content.startsWith('<font color="#888888">')) return true;
  return false;
}

const MAX_INBOUND_CONTENT_CHARS = 100_000;
const MAX_INBOUND_ID_CHARS = 255;
const MAX_INBOUND_SENDER_CHARS = 255;
const MAX_INBOUND_THREAD_CHARS = 255;
const MAX_INBOUND_CHAT_JID_CHARS = 255;

export function isValidInboundChatJid(chatJid: string): boolean {
  if (!chatJid || chatJid.length > MAX_INBOUND_CHAT_JID_CHARS) return false;
  if (chatJid.startsWith('matrix:')) {
    const roomId = chatJid.slice('matrix:'.length);
    return /^[!#][^:\s]+:[^\s]+$/.test(roomId);
  }
  return true;
}

export function isValidInboundSender(sender: string): boolean {
  if (!sender || sender.length > MAX_INBOUND_SENDER_CHARS) return false;
  if (sender.startsWith('@')) return /^@[^:\s]+:[^\s]+$/.test(sender);
  return true;
}

export function normalizeInboundMessage(msg: NewMessage): NewMessage | null {
  if (!isValidInboundChatJid(msg.chat_jid)) return null;
  if (!isValidInboundSender(msg.sender)) return null;
  if (!msg.id || msg.id.length > MAX_INBOUND_ID_CHARS) return null;
  if (!msg.sender_name || msg.sender_name.length > MAX_INBOUND_SENDER_CHARS) return null;
  if (!msg.timestamp || Number.isNaN(new Date(msg.timestamp).getTime())) return null;

  const content = typeof msg.content === 'string'
    ? msg.content.slice(0, MAX_INBOUND_CONTENT_CHARS)
    : '';
  const threadId = typeof msg.thread_id === 'string' && msg.thread_id.length > 0
    ? msg.thread_id.slice(0, MAX_INBOUND_THREAD_CHARS)
    : undefined;

  return {
    ...msg,
    content,
    thread_id: threadId,
  };
}
