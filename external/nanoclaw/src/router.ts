import { Channel, NewMessage } from './types.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map(
    (m) =>
      `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

// [InfiniClaw] formatThreadContext removed upstream in v1.2.2
export function formatThreadContext(threadMessages: NewMessage[], newMessageIds: Set<string>): string {
  const contextOnly = threadMessages.filter(m => m.id && !newMessageIds.has(m.id));
  if (contextOnly.length === 0) return '';
  const lines = contextOnly.map(m => {
    const content = m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content;
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(content)}</message>`;
  });
  return `<thread_context>\n${lines.join('\n')}\n</thread_context>`;
}
