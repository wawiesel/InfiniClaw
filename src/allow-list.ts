/**
 * Per-bot mount allow-list.
 * Single source of truth: ~/.config/infiniclaw/allow-list.json
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from 'nanoclaw/logger.js';

interface AllowEntry {
  path: string;
  expiresAt: string | null;
}

interface AllowList {
  mounts: Record<string, AllowEntry[]>;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

const CONFIG_DIR = path.join(os.homedir(), '.config', 'infiniclaw');
const ALLOW_LIST_PATH = path.join(CONFIG_DIR, 'allow-list.json');

function expandTilde(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Dotfile paths that are explicitly safe for bot mounts
const DOTFILE_ALLOWLIST = new Set(['.wks', '.config']);

function hasDotfileSegment(p: string): boolean {
  return p.split(path.sep).some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..' && !DOTFILE_ALLOWLIST.has(seg));
}

export function loadAllowList(): AllowList {
  try {
    if (fs.existsSync(ALLOW_LIST_PATH)) {
      return JSON.parse(fs.readFileSync(ALLOW_LIST_PATH, 'utf-8'));
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load allow-list');
  }
  return { mounts: {} };
}

function saveAllowList(list: AllowList): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${ALLOW_LIST_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, ALLOW_LIST_PATH);
}

export function grantMount(bot: string, rawPath: string, durationMinutes?: number): void {
  const expanded = expandTilde(rawPath);
  if (hasDotfileSegment(expanded)) {
    throw new Error(`Dotfile paths not allowed: ${rawPath}`);
  }
  if (!fs.existsSync(expanded)) {
    throw new Error(`Path does not exist: ${expanded}`);
  }

  const list = loadAllowList();
  if (!list.mounts[bot]) list.mounts[bot] = [];

  // Remove existing entry for this path
  list.mounts[bot] = list.mounts[bot].filter(e => expandTilde(e.path) !== expanded);

  const expiresAt = durationMinutes
    ? new Date(Date.now() + durationMinutes * 60 * 1000).toISOString()
    : null;

  list.mounts[bot].push({ path: rawPath, expiresAt });
  saveAllowList(list);
  logger.info({ bot, path: rawPath, expiresAt }, 'Mount granted');
}

export function revokeMount(bot: string, rawPath: string): boolean {
  const expanded = expandTilde(rawPath);
  const list = loadAllowList();
  const entries = list.mounts[bot];
  if (!entries) return false;

  const before = entries.length;
  list.mounts[bot] = entries.filter(e => expandTilde(e.path) !== expanded);
  if (list.mounts[bot].length === before) return false;

  saveAllowList(list);
  logger.info({ bot, path: rawPath }, 'Mount revoked');
  return true;
}

export function pruneExpired(): number {
  const list = loadAllowList();
  const now = Date.now();
  let pruned = 0;

  for (const bot of Object.keys(list.mounts)) {
    const before = list.mounts[bot].length;
    list.mounts[bot] = list.mounts[bot].filter(e => {
      if (!e.expiresAt) return true;
      return new Date(e.expiresAt).getTime() > now;
    });
    pruned += before - list.mounts[bot].length;
  }

  if (pruned > 0) {
    saveAllowList(list);
  }
  return pruned;
}

export function mountsForBot(bot: string): VolumeMount[] {
  const list = loadAllowList();
  const entries = list.mounts[bot] || [];
  const now = Date.now();
  const mounts: VolumeMount[] = [];
  const usedBasenames = new Set<string>();

  for (const entry of entries) {
    if (entry.expiresAt && new Date(entry.expiresAt).getTime() <= now) continue;

    const expanded = expandTilde(entry.path);
    if (hasDotfileSegment(expanded)) continue;
    if (!fs.existsSync(expanded)) continue;

    let basename = path.basename(expanded);
    if (usedBasenames.has(basename)) {
      basename = `${basename}-${usedBasenames.size}`;
    }
    usedBasenames.add(basename);

    mounts.push({
      hostPath: expanded,
      containerPath: `/workspace/extra/${basename}`,
      readonly: false,
    });
  }

  return mounts;
}
