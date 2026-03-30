/**
 * Token usage log — per-bot, per-provider, per-model token tracking.
 *
 * Each bot's usage is stored as JSONL in S3 at `tokens/{bot}.jsonl`.
 * Entries are appended on each container turn completion.
 * Metrics reads this file to compute per-model breakdowns and time-series.
 */
import { logger } from 'nanoclaw/logger.js';

// Lazy S3 import to break circular deps
let s3: typeof import('./s3-sync.js') | null = null;
async function getS3() {
  if (!s3) s3 = await import('./s3-sync.js');
  return s3;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface TokenUsageEntry {
  provider: string;       // 'anthropic' | 'ollama' | 'openai'
  model: string;          // 'claude-sonnet-4-6' | 'qwen3:14b'
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;   // cache_creation + cache_read
  timestamp: string;      // ISO
  bot: string;
  group?: string;         // 'bazaar' | 'engineering' | 'main'
}

// ── S3 Read/Write ────────────────────────────────────────────────────────────

function s3Key(bot: string): string {
  return `tokens/${bot}.jsonl`;
}

/** Append a token usage entry to the bot's log in S3. */
export async function appendTokenUsage(entry: TokenUsageEntry): Promise<void> {
  try {
    const s3mod = await getS3();
    const key = s3Key(entry.bot);

    // Read existing content, append new line
    let existing = '';
    try {
      const client = s3mod.getClient();
      if (client) {
        const { GetObjectCommand } = await import('@aws-sdk/client-s3');
        const resp = await client.client.send(new GetObjectCommand({ Bucket: client.bucket, Key: key }));
        existing = await resp.Body?.transformToString() ?? '';
      }
    } catch { /* file doesn't exist yet — start fresh */ }

    const line = JSON.stringify(entry);
    const content = existing ? `${existing.trimEnd()}\n${line}\n` : `${line}\n`;
    await s3mod.uploadContent(key, content);
  } catch (err) {
    logger.warn({ err, bot: entry.bot }, 'token-log: failed to append');
  }
}

/** Read all token usage entries for a bot within a time window. */
export async function readTokenUsage(bot: string, windowMs: number): Promise<TokenUsageEntry[]> {
  try {
    const s3mod = await getS3();
    const client = s3mod.getClient();
    if (!client) return [];

    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const resp = await client.client.send(new GetObjectCommand({ Bucket: client.bucket, Key: s3Key(bot) }));
    const content = await resp.Body?.transformToString() ?? '';

    const cutoff = Date.now() - windowMs;
    const entries: TokenUsageEntry[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as TokenUsageEntry;
        if (new Date(entry.timestamp).getTime() >= cutoff) {
          entries.push(entry);
        }
      } catch { /* skip bad lines */ }
    }
    return entries;
  } catch {
    return [];
  }
}

/** Aggregate token usage by model for a bot within a time window. */
export async function aggregateByModel(bot: string, windowMs: number): Promise<Record<string, { input: number; output: number; cache: number; total: number }>> {
  const entries = await readTokenUsage(bot, windowMs);
  const result: Record<string, { input: number; output: number; cache: number; total: number }> = {};
  for (const e of entries) {
    const key = `${e.provider}/${e.model}`;
    if (!result[key]) result[key] = { input: 0, output: 0, cache: 0, total: 0 };
    result[key].input += e.input_tokens;
    result[key].output += e.output_tokens;
    result[key].cache += e.cache_tokens;
    result[key].total += e.input_tokens + e.output_tokens + e.cache_tokens;
  }
  return result;
}

/** Get hourly token counts for a bot (last N hours). Returns array of { hour: ISO, tokens: number }. */
export async function hourlyTokens(bot: string, hours: number): Promise<{ hour: string; tokens: number }[]> {
  const entries = await readTokenUsage(bot, hours * 3600_000);
  const buckets = new Map<string, number>();

  for (const e of entries) {
    const d = new Date(e.timestamp);
    const hourKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}:00Z`;
    buckets.set(hourKey, (buckets.get(hourKey) ?? 0) + e.input_tokens + e.output_tokens + e.cache_tokens);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, tokens]) => ({ hour, tokens }));
}
