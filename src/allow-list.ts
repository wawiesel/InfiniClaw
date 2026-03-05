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
  const expanded = p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
  // Resolve .. and . components to prevent path traversal
  return path.resolve(expanded);
}

// Dotfile paths that are explicitly safe for bot mounts
const DOTFILE_ALLOWLIST = new Set(['.wks', '.config']);

function hasDotfileSegment(p: string): boolean {
  return p.split(path.sep).some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..' && !DOTFILE_ALLOWLIST.has(seg));
}

export function loadAllowList(): AllowList {
  try {
    if (fs.existsSync(ALLOW_LIST_PATH)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(ALLOW_LIST_PATH, 'utf-8'));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'mounts' in parsed &&
        typeof parsed.mounts === 'object' &&
        parsed.mounts !== null &&
        !Array.isArray(parsed.mounts)
      ) {
        // Deep-validate each bot's entry array
        const mounts = parsed.mounts as Record<string, unknown>;
        const valid = Object.values(mounts).every(entries => {
          if (!Array.isArray(entries)) return false;
          return entries.every((e: unknown) =>
            typeof e === 'object' && e !== null &&
            'path' in e && typeof (e as Record<string, unknown>).path === 'string' &&
            'expiresAt' in e && (
              (e as Record<string, unknown>).expiresAt === null ||
              typeof (e as Record<string, unknown>).expiresAt === 'string'
            )
          );
        });
        if (!valid) {
          logger.warn('Invalid allow-list entry schema, using empty default');
        } else {
          return parsed as AllowList;
        }
      } else {
        logger.warn('Invalid allow-list schema, using empty default');
      }
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
  // Resolve symlinks to check the real path, not just the link
  let real: string;
  try {
    real = fs.realpathSync(expanded);
  } catch {
    throw new Error(`Path does not exist: ${expanded}`);
  }
  if (hasDotfileSegment(real)) {
    throw new Error(`Dotfile paths not allowed (symlink target): ${real}`);
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

export function mountsForBot(bot: string): VolumeMount[] {
  const list = loadAllowList();
  const entries = list.mounts[bot] || [];
  const now = Date.now();
  const mounts: VolumeMount[] = [];
  const usedBasenames = new Set<string>();

  for (const entry of entries) {
    if (entry.expiresAt) {
      const t = new Date(entry.expiresAt).getTime();
      // Treat invalid (NaN) expiry dates as expired — consistent with pruneExpired
      if (isNaN(t) || t <= now) continue;
    }

    const expanded = expandTilde(entry.path);
    if (hasDotfileSegment(expanded)) continue;

    // Resolve symlinks to prevent symlink-based path escapes
    let real: string;
    try {
      real = fs.realpathSync(expanded);
    } catch {
      continue; // path doesn't exist or is unresolvable
    }
    if (hasDotfileSegment(real)) continue;

    const basename = path.basename(real);
    if (!basename) continue; // guard against root or empty-basename paths

    let mountName = basename;
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
