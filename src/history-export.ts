/**
 * history-export.ts — periodic S3 export of conversation history
 *
 * Writes JSONL to: history/{room-slug}/{YYYY-MM-DD}/{HH-MM-SS}.jsonl
 * Each line is a JSON message record. Operators and bots read via the
 * history-mcp-server using the same S3 credentials.
 */

import path from 'path';
import { getMessagesSince } from 'nanoclaw/db.js';
import { logger } from 'nanoclaw/logger.js';
import { readJson, writeJson } from './utils.js';
import { uploadContent } from './s3-sync.js';

interface RegisteredGroup {
  name: string;
  folder: string;
}

interface ExportState {
  lastExportedAt: Record<string, string>; // chatJid -> ISO timestamp
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function loadState(stateFile: string): ExportState {
  return readJson<ExportState>(stateFile, { lastExportedAt: {} });
}

function saveState(stateFile: string, state: ExportState): void {
  try {
    writeJson(stateFile, state);
  } catch { /* best effort */ }
}

/**
 * Export new messages for all registered groups to S3.
 * No-op if S3 is not configured.
 * @param dataDir  - bot's DATA_DIR (for persisting export state)
 * @param botName  - ASSISTANT_NAME (used to filter internal bot messages)
 * @param groups   - registeredGroups map (jid -> {name, folder})
 */
export async function exportHistoryToS3(
  dataDir: string,
  botName: string,
  groups: Record<string, RegisteredGroup>,
): Promise<void> {
  const stateFile = path.join(dataDir, 'history-export-state.json');
  const state = loadState(stateFile);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);             // YYYY-MM-DD
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '-'); // HH-MM-SS

  let exported = 0;
  for (const [jid, group] of Object.entries(groups)) {
    const since = state.lastExportedAt[jid]
      ?? new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

    const messages = getMessagesSince(jid, since, botName);
    if (messages.length === 0) continue;

    const lines = messages.map((m) =>
      JSON.stringify({
        id: m.id,
        room: group.name,
        sender: m.sender_name || m.sender,
        content: m.content,
        ts: m.timestamp,
        ...(m.thread_id ? { thread_id: m.thread_id } : {}),
      }),
    );

    const key = `history/${slugify(group.name)}/${dateStr}/${timeStr}.jsonl`;
    try {
      await uploadContent(key, lines.join('\n'));
      state.lastExportedAt[jid] = now.toISOString();
      exported += messages.length;
    } catch (err) {
      logger.warn({ err, jid, key }, 'history-export: S3 upload failed');
    }
  }

  if (exported > 0) {
    logger.info({ exported }, 'history-export: uploaded messages to S3');
  }
  saveState(stateFile, state);
}
