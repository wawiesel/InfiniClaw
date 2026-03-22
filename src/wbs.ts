/**
 * Work Breakdown Structure (WBS) — relay-side utilities.
 *
 * Primary storage: S3 at infiniclaw/wbs/wbs-{room}.json.
 * Local cache: _runtime/data/wbs-{room}.json (for container MCP tool reads).
 *
 * The relay manages assignment, reabsorption, and dependency unblocking.
 * The Chief bot manages content (triage, prioritisation, rebalancing).
 *
 * See docs/design/12-co.md § Work Breakdown Structure.
 */

import fs from 'fs';
import path from 'path';
import { downloadJson, uploadJson } from './s3-sync.js';
import { logger } from 'nanoclaw/logger.js';

export type WbsStatus = 'backlog' | 'ready' | 'in_progress' | 'done';

export interface WbsItem {
  id: string;
  title: string;
  source?: string;            // GitHub issue, PR, or Captain order reference
  depends_on: string[];       // IDs of items that must be done first
  assigned_to: string | null; // bot name, or null = unassigned
  status: WbsStatus;
  priority: number;           // lower = higher priority
  gitea_issue?: number;       // Gitea issue number auto-created on in_progress
}

export interface WbsFile {
  items: WbsItem[];
}

// ── S3 key + local cache path ────────────────────────────────────────────────

function safeName(room: string): string {
  return room.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function s3Key(room: string): string {
  return `infiniclaw/wbs/wbs-${safeName(room)}.json`;
}

function localPath(dataDir: string, room: string): string {
  return path.join(dataDir, `wbs-${safeName(room)}.json`);
}

// ── Read: S3 first, local fallback ───────────────────────────────────────────

export async function readWbs(dataDir: string, room: string): Promise<WbsFile> {
  // Try S3 first
  try {
    const data = await downloadJson<WbsFile>(s3Key(room));
    if (data && Array.isArray(data.items)) {
      // Update local cache for container reads
      writeLocalCache(dataDir, room, data);
      return data;
    }
  } catch (err) {
    logger.warn({ err, room }, 'WBS: S3 read failed, falling back to local');
  }

  // Fall back to local file
  const p = localPath(dataDir, room);
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (parsed && Array.isArray(parsed.items)) {
      return { items: parsed.items as WbsItem[] };
    }
  } catch { /* file missing or malformed — start fresh */ }
  return { items: [] };
}

// ── Write: S3 + local cache ──────────────────────────────────────────────────

export async function writeWbs(dataDir: string, room: string, wbs: WbsFile): Promise<void> {
  // Write to local cache first (sync, always works)
  writeLocalCache(dataDir, room, wbs);

  // Write to S3 (async, best-effort)
  try {
    await uploadJson(s3Key(room), wbs);
  } catch (err) {
    logger.error({ err, room }, 'WBS: S3 write failed — local cache is authoritative');
  }
}

function writeLocalCache(dataDir: string, room: string, wbs: WbsFile): void {
  const p = localPath(dataDir, room);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(wbs, null, 2) + '\n');
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** Items currently assigned to a bot. */
export function itemsForBot(wbs: WbsFile, bot: string): WbsItem[] {
  return wbs.items.filter((i) => i.assigned_to === bot && i.status !== 'done');
}

/** Highest-priority ready item with no unmet dependencies, not yet assigned. */
export function nextReadyItem(wbs: WbsFile): WbsItem | undefined {
  const doneIds = new Set(wbs.items.filter((i) => i.status === 'done').map((i) => i.id));
  return wbs.items
    .filter(
      (i) =>
        i.status === 'ready' &&
        i.assigned_to === null &&
        i.depends_on.every((dep) => doneIds.has(dep)),
    )
    .sort((a, b) => a.priority - b.priority)[0];
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Assign a specific item to a bot (marks it in_progress).
 * Returns true if the item was found and assigned, false otherwise.
 */
export function assignItem(wbs: WbsFile, itemId: string, bot: string): boolean {
  const item = wbs.items.find((i) => i.id === itemId);
  if (!item || item.status === 'done') return false;
  item.assigned_to = bot;
  item.status = 'in_progress';
  return true;
}

/**
 * Reabsorb all items assigned to a bot — reset to ready/unassigned.
 * Called when a bot goes off duty (sleep, dismiss, timeout).
 * Returns the count of items reabsorbed.
 */
export function reabsorbItems(wbs: WbsFile, bot: string): number {
  let count = 0;
  for (const item of wbs.items) {
    if (item.assigned_to === bot && item.status !== 'done') {
      item.assigned_to = null;
      item.status = 'ready';
      count++;
    }
  }
  return count;
}

/**
 * Mark an item done and unblock any dependent items.
 * Returns the IDs of items that were unblocked (transitioned backlog → ready).
 */
export function completeItem(wbs: WbsFile, itemId: string): string[] {
  const item = wbs.items.find((i) => i.id === itemId);
  if (!item) return [];
  item.status = 'done';
  item.assigned_to = null;

  const doneIds = new Set(wbs.items.filter((i) => i.status === 'done').map((i) => i.id));
  const unblocked: string[] = [];
  for (const candidate of wbs.items) {
    if (
      candidate.status === 'backlog' &&
      candidate.depends_on.every((dep) => doneIds.has(dep))
    ) {
      candidate.status = 'ready';
      unblocked.push(candidate.id);
    }
  }
  return unblocked;
}

/**
 * Auto-assign the highest-priority ready item to a bot.
 * Used by the heartbeat loop for idle bots.
 * Returns the assigned item, or undefined if nothing available.
 */
export function autoAssign(wbs: WbsFile, bot: string): WbsItem | undefined {
  const item = nextReadyItem(wbs);
  if (!item) return undefined;
  assignItem(wbs, item.id, bot);
  return item;
}

/**
 * Build an initial todo-list representation of a bot's assigned items.
 * Returns an array of { content, status, activeForm } suitable for TodoWrite.
 */
export function wbsToTodos(
  items: WbsItem[],
): Array<{ content: string; status: string; activeForm: string }> {
  return items.map((item) => ({
    content: item.title,
    status: item.status === 'in_progress' ? 'in_progress' : 'pending',
    activeForm: `Working on: ${item.title}`,
  }));
}
