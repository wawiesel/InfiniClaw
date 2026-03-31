/**
 * Token usage SQLite store.
 * 15 fundamental fields per turn (R1). One row per LLM turn.
 * INSERT on turn start (R2), UPDATE on turn end.
 * Dashboard server owns the single tokens.db file.
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface UsageRow {
  bot: string;
  session_id: string;
  turn_id: string;
  model: string;
  provider: string;
  t_start: string;
  t_end: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  input_price_per_token: number;
  output_price_per_token: number;
  cache_write_price_per_token: number;
  cache_read_price_per_token: number;
  context_tokens: number;  // end-of-turn context window usage (from last API call, not summed)
}

let db: Database.Database | null = null;

export function openTokenDb(dbDir: string): Database.Database {
  if (db) return db;
  fs.mkdirSync(dbDir, { recursive: true });
  db = new Database(path.join(dbDir, 'tokens.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      bot TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      t_start TEXT NOT NULL,
      t_end TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      input_price_per_token REAL NOT NULL DEFAULT 0,
      output_price_per_token REAL NOT NULL DEFAULT 0,
      cache_write_price_per_token REAL NOT NULL DEFAULT 0,
      cache_read_price_per_token REAL NOT NULL DEFAULT 0,
      context_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (turn_id)
    );
    CREATE INDEX IF NOT EXISTS idx_bot_time ON usage(bot, t_start);
  `);
  // Migration: add context_tokens column if missing
  try { db.exec('ALTER TABLE usage ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
  return db;
}

/** INSERT a turn start. Tokens=0, t_end=null. Returns true if inserted. */
export function insertTurnStart(row: Pick<UsageRow, 'bot' | 'session_id' | 'turn_id' | 'model' | 'provider' | 't_start' | 'input_price_per_token' | 'output_price_per_token' | 'cache_write_price_per_token' | 'cache_read_price_per_token'>): boolean {
  if (!db) return false;
  try {
    db.prepare(`
      INSERT OR IGNORE INTO usage (bot, session_id, turn_id, model, provider, t_start, input_price_per_token, output_price_per_token, cache_write_price_per_token, cache_read_price_per_token)
      VALUES (@bot, @session_id, @turn_id, @model, @provider, @t_start, @input_price_per_token, @output_price_per_token, @cache_write_price_per_token, @cache_read_price_per_token)
    `).run(row);
    return true;
  } catch { return false; }
}

/** UPDATE a turn end. Fill in actual tokens and t_end. Returns true if updated. */
export function completeTurn(turn_id: string, data: { t_end: string; input_tokens: number; output_tokens: number; cache_write_tokens: number; cache_read_tokens: number; context_tokens?: number }): boolean {
  if (!db) return false;
  const result = db.prepare(`
    UPDATE usage SET t_end = @t_end, input_tokens = @input_tokens, output_tokens = @output_tokens,
      cache_write_tokens = @cache_write_tokens, cache_read_tokens = @cache_read_tokens, context_tokens = @context_tokens
    WHERE turn_id = @turn_id
  `).run({ ...data, context_tokens: data.context_tokens ?? 0, turn_id });
  return result.changes > 0;
}

/** Batch insert completed turns (for relay bulk flush). One transaction. */
export function insertCompletedTurns(rows: UsageRow[]): number {
  if (!db || rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO usage (bot, session_id, turn_id, model, provider, t_start, t_end,
      input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
      input_price_per_token, output_price_per_token, cache_write_price_per_token, cache_read_price_per_token,
      context_tokens)
    VALUES (@bot, @session_id, @turn_id, @model, @provider, @t_start, @t_end,
      @input_tokens, @output_tokens, @cache_write_tokens, @cache_read_tokens,
      @input_price_per_token, @output_price_per_token, @cache_write_price_per_token, @cache_read_price_per_token,
      @context_tokens)
  `);
  const tx = db.transaction((rows: UsageRow[]) => {
    let n = 0;
    for (const r of rows) { stmt.run(r); n++; }
    return n;
  });
  return tx(rows);
}

/** Query completed turns for a bot, ordered by t_start. */
export function queryUsage(bot: string, since?: string): UsageRow[] {
  if (!db) return [];
  if (since) {
    return db.prepare('SELECT * FROM usage WHERE bot = ? AND t_start >= ? AND t_end IS NOT NULL ORDER BY t_start').all(bot, since) as UsageRow[];
  }
  return db.prepare('SELECT * FROM usage WHERE bot = ? AND t_end IS NOT NULL ORDER BY t_start').all(bot) as UsageRow[];
}

/** Query all completed turns, ordered by t_start. */
export function queryAllUsage(since?: string): UsageRow[] {
  if (!db) return [];
  if (since) {
    return db.prepare('SELECT * FROM usage WHERE t_start >= ? AND t_end IS NOT NULL ORDER BY t_start').all(since) as UsageRow[];
  }
  return db.prepare('SELECT * FROM usage WHERE t_end IS NOT NULL ORDER BY t_start').all() as UsageRow[];
}

/** Query in-progress turns (t_end IS NULL). */
export function queryInProgress(): UsageRow[] {
  if (!db) return [];
  return db.prepare('SELECT * FROM usage WHERE t_end IS NULL ORDER BY t_start').all() as UsageRow[];
}
