/**
 * Per-bot mount allow-list.
 * Single source of truth: ~/.config/infiniclaw/allow-list.json
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
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
const PATHS_PATH = path.join(CONFIG_DIR, 'paths.json');
const FLEET_PATH = path.join(CONFIG_DIR, 'secrets', 'bots', 'fleet.json');

function expandTilde(p: string): string {
  const expanded = p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
  // Resolve .. and . components to prevent path traversal
  return path.resolve(expanded);
}

// Dotfile paths that are explicitly safe for bot mounts
const DOTFILE_ALLOWLIST = new Set(['.wks', '.config']);

function hasDotfileSegment(p: string): boolean {
  return p.split(path.sep).some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..' && !DOTFILE_ALLOWLIST.has(seg));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeBotName(bot: string): string {
  const normalized = bot.trim();
  if (!normalized) throw new Error('Bot name cannot be empty');
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) throw new Error(`Invalid bot name: ${bot}`);
  return normalized;
}

function normalizeHostPath(rawPath: string, options?: { requireExists?: boolean }): string {
  const requireExists = options?.requireExists ?? true;
  const expanded = expandTilde(rawPath.trim());
  if (hasDotfileSegment(expanded)) {
    throw new Error(`Dotfile paths not allowed: ${rawPath}`);
  }

  const resolved = path.resolve(expanded);
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    if (requireExists) throw new Error(`Path does not exist: ${resolved}`);
  }
  if (hasDotfileSegment(real)) {
    throw new Error(`Dotfile paths not allowed (symlink target): ${real}`);
  }
  if (real === path.parse(real).root) {
    throw new Error(`Mounting filesystem root is not allowed: ${rawPath}`);
  }
  return real;
}

function safeMountName(realHostPath: string): string {
  const base = path.basename(realHostPath);
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (clean && clean !== '.' && clean !== '..') return clean;
  return `mount-${createHash('sha256').update(realHostPath).digest('hex').slice(0, 12)}`;
}

function normalizeAllowList(parsed: unknown): AllowList {
  if (!isObject(parsed) || !isObject(parsed.mounts)) return { mounts: {} };
  const mounts: Record<string, AllowEntry[]> = {};
  for (const [bot, entries] of Object.entries(parsed.mounts)) {
    if (!Array.isArray(entries)) continue;
    mounts[bot] = entries
      .filter((e): e is Record<string, unknown> => isObject(e))
      .map((e) => {
        const p = typeof e.path === 'string' ? e.path : '';
        if (!p) return null;
        const expiresAt = e.expiresAt === null || typeof e.expiresAt === 'string' ? e.expiresAt : null;
        return { path: p, expiresAt };
      })
      .filter((e): e is AllowEntry => e !== null);
  }
  return { mounts };
}

export function loadAllowList(): AllowList {
  try {
    if (fs.existsSync(ALLOW_LIST_PATH)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(ALLOW_LIST_PATH, 'utf-8'));
      const normalized = normalizeAllowList(parsed);
      if (!isObject(parsed) || !isObject(parsed.mounts)) logger.warn('Invalid allow-list schema, using empty default');
      return normalized;
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
  const normalizedBot = normalizeBotName(bot);
  const real = normalizeHostPath(rawPath, { requireExists: true });

  const list = loadAllowList();
  if (!list.mounts[normalizedBot]) list.mounts[normalizedBot] = [];

  // Remove existing entry for this path
  list.mounts[normalizedBot] = list.mounts[normalizedBot].filter((e) => {
    try {
      return normalizeHostPath(e.path, { requireExists: false }) !== real;
    } catch {
      return false;
    }
  });

  const expiresAt = durationMinutes
    ? new Date(Date.now() + durationMinutes * 60 * 1000).toISOString()
    : null;

  list.mounts[normalizedBot].push({ path: real, expiresAt });
  saveAllowList(list);
  logger.info({ bot: normalizedBot, path: real, expiresAt }, 'Mount granted');
}

export function revokeMount(bot: string, rawPath: string): boolean {
  const normalizedBot = normalizeBotName(bot);
  const real = normalizeHostPath(rawPath, { requireExists: false });
  const list = loadAllowList();
  const entries = list.mounts[normalizedBot];
  if (!entries) return false;

  const before = entries.length;
  list.mounts[normalizedBot] = entries.filter((e) => {
    try {
      return normalizeHostPath(e.path, { requireExists: false }) !== real;
    } catch {
      return false;
    }
  });
  if (list.mounts[normalizedBot].length === before) return false;

  saveAllowList(list);
  logger.info({ bot: normalizedBot, path: real }, 'Mount revoked');
  return true;
}

/** Remove all mounts for a bot (e.g. after transport away). */
export function removeBotMounts(bot: string): void {
  const normalizedBot = normalizeBotName(bot);
  const list = loadAllowList();
  if (!list.mounts[normalizedBot]) return;
  delete list.mounts[normalizedBot];
  saveAllowList(list);
  logger.info({ bot: normalizedBot }, 'All mounts removed');
}

export function pruneExpired(): number {
  const list = loadAllowList();
  const now = Date.now();
  let pruned = 0;

  for (const bot of Object.keys(list.mounts)) {
    const before = list.mounts[bot].length;
    list.mounts[bot] = list.mounts[bot].filter(e => {
      if (!e.expiresAt) return true;
      const t = new Date(e.expiresAt).getTime();
      // Treat invalid (NaN) expiry dates as expired and prune them
      return !isNaN(t) && t > now;
    });
    pruned += before - list.mounts[bot].length;
  }

  if (pruned > 0) {
    saveAllowList(list);
  }
  return pruned;
}

/** Load paths.json (per-machine logical name → local path). */
function loadPaths(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(PATHS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

/** Get role-based rw paths for a bot from fleet.json roles + paths.json. */
function roleMounts(bot: string): AllowEntry[] {
  try {
    const fleet = JSON.parse(fs.readFileSync(FLEET_PATH, 'utf-8'));
    const botEntry = fleet.bots?.[bot];
    if (!botEntry?.role) return [];
    const roleConfig = fleet.roles?.[botEntry.role];
    if (!roleConfig?.rw) return [];
    const paths = loadPaths();
    return roleConfig.rw
      .map((name: string) => paths[name])
      .filter((p: string | undefined): p is string => !!p)
      .map((p: string) => ({ path: p, expiresAt: null }));
  } catch {
    return [];
  }
}

export function mountsForBot(bot: string): VolumeMount[] {
  const normalizedBot = normalizeBotName(bot);
  const list = loadAllowList();
  // Merge role-based mounts with per-bot overrides
  const roleEntries = roleMounts(normalizedBot);
  const botEntries = list.mounts[normalizedBot] || [];
  const allEntries = [...roleEntries, ...botEntries];
  const now = Date.now();
  const mounts: VolumeMount[] = [];
  const usedBasenames = new Set<string>();
  const seenPaths = new Set<string>();

  for (const entry of allEntries) {
    if (entry.expiresAt) {
      const t = new Date(entry.expiresAt).getTime();
      if (isNaN(t) || t <= now) continue;
    }

    let real: string;
    try {
      real = normalizeHostPath(entry.path);
    } catch {
      continue;
    }

    if (seenPaths.has(real)) continue;
    seenPaths.add(real);

    let mountName = safeMountName(real);
    if (usedBasenames.has(mountName)) {
      let n = 2;
      while (usedBasenames.has(`${mountName}-${n}`)) n++;
      mountName = `${mountName}-${n}`;
    }
    usedBasenames.add(mountName);

    mounts.push({
      hostPath: real,
      containerPath: `/workspace/extra/${mountName}`,
      readonly: false,
    });
  }

  return mounts;
}
