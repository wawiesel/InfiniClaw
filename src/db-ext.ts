/**
 * InfiniClaw database extensions.
 *
 * Opens a second connection to the same SQLite DB that nanoclaw manages.
 * Provides thread-aware queries and functions upstream removed in v1.2.12.
 * WAL mode ensures reads never block and writes are serialized by SQLite.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { STORE_DIR, ASSISTANT_NAME } from 'nanoclaw/config.js';
import type { NewMessage } from 'nanoclaw/types.js';

let extDb: Database.Database;

/** Call after nanoclaw's initDatabase(). Adds thread_id column if missing. */
export function initDatabaseExt(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  extDb = new Database(dbPath);
  extDb.pragma('journal_mode = WAL');
  // Migration: add thread_id column (idempotent)
  try {
    extDb.exec('ALTER TABLE messages ADD COLUMN thread_id TEXT');
  } catch {
    // Column already exists
  }
}

/**
 * Store a message with thread_id support.
 * Replaces nanoclaw's storeMessage which doesn't include thread_id.
 */
export function storeMessage(msg: NewMessage): void {
  extDb
    .prepare(
      `INSERT OR REPLACE INTO messages
       (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      msg.id,
      msg.chat_jid,
      msg.sender,
      msg.sender_name,
      msg.content,
      msg.timestamp,
      msg.is_from_me ? 1 : 0,
      msg.is_bot_message ? 1 : 0,
      msg.thread_id ?? null,
    );
}

export function botParticipatesInThread(chatJid: string, threadId: string): boolean {
  const row = extDb
    .prepare(
      'SELECT 1 FROM messages WHERE chat_jid = ? AND thread_id = ? AND is_from_me = 1 LIMIT 1',
    )
    .get(chatJid, threadId);
  return !!row;
}

export function getRecentMessages(
  chatJid: string,
  botPrefix: string,
  limit = 25,
): NewMessage[] {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  return extDb
    .prepare(
      `SELECT id, chat_jid, sender, sender_name, content, timestamp, thread_id
       FROM messages
       WHERE chat_jid = ? AND content NOT LIKE ?
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(chatJid, `${botPrefix}:%`, safeLimit) as NewMessage[];
}

export function getThreadMessages(
  chatJid: string,
  threadId: string,
  limit = 20,
): NewMessage[] {
  return extDb
    .prepare(
      `SELECT id, chat_jid, sender, sender_name, content, timestamp, thread_id
       FROM messages WHERE chat_jid = ? AND (thread_id = ? OR id = ?)
       ORDER BY timestamp ASC LIMIT ?`,
    )
    .all(chatJid, threadId, threadId, Math.min(limit, 50)) as NewMessage[];
}

export function deleteSession(groupFolder: string): void {
  extDb.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function deleteRegisteredGroup(jid: string): void {
  extDb.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
}
