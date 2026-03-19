/**
 * Ship configuration.
 * Reads fleet.json from the secrets repo (~/.config/infiniclaw/secrets/bots/fleet.json)
 * to determine which bots run on this ship, S3 settings, and per-ship options.
 * secretsPath is by convention ~/.config/infiniclaw/secrets.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { errStr, isRecord, readJson, writeJson } from './utils.js';

// Lazy import to break circular dependency: ship-config ↔ s3-sync
async function s3Helpers() {
  return import('./s3-sync.js');
}

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export type BotStatus = 'onduty' | 'quarters' | 'sleep' | 'transit' | 'retrospective' | 'dream' | 'ready';
export type TriggerType = 'always' | 'callout' | 'never';

export interface BotEntry {
  role: string;
  rank: number;
  ship: string | null;
  status: BotStatus;
  triggerType?: TriggerType;
  title?: string;
  quartersRoom?: string;
  activeBrainModel?: string;
  /** Unix ms when the bot last went onduty — used for duty cycle timer. */
  ondutyAt?: number;
}

export interface ShipConfig {
  bots: string[];
  secretsPath: string;
  s3?: S3Config;
}

const SECRETS_PATH = path.join(os.homedir(), '.config', 'infiniclaw', 'secrets');
const FLEET_PATH = path.join(SECRETS_PATH, 'bots', process.env['INFINICLAW_FLEET'] || 'fleet.json');
const SHIPS_PATH = path.join(SECRETS_PATH, 'operator', 'ships.json');
/** Bot names must start with alphanumeric, then alphanumeric/dot/dash/underscore. */
export const SAFE_BOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Statuses that mean the bot should be running on its assigned ship. */
export const RUNNING_STATUSES: readonly BotStatus[] = ['onduty', 'quarters', 'retrospective', 'ready'] as const;

/** Default triggerType for a given status (used when triggerType is not explicitly set). */
export function defaultTriggerType(status: BotStatus): TriggerType {
  if (status === 'onduty') return 'callout';
  if (status === 'quarters') return 'always';
  if (status === 'retrospective') return 'always';
  if (status === 'ready') return 'always';
  return 'never';
}

/** Normalize legacy status names to current values. */
function migrateStatus(s: string): string {
  if (s === 'active') return 'onduty';
  if (s === 'dismissed') return 'quarters';
  if (s === 'lounge') return 'quarters';
  if (s === 'sleeping') return 'sleep';
  return s;
}

let cached: ShipConfig | null = null;

/**
 * Module-level cache of S3-merged fleet state.
 * Populated by loadFleetAsync() at startup, updated by writeFleetAsync().
 * When set, loadFleet() returns this instead of disk-only data,
 * making S3 the effective source of truth for all callers.
 */
let s3FleetCache: Record<string, BotEntry> | null = null;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isValidBotName(name: string): boolean {
  return SAFE_BOT_NAME.test(name) && name !== '.' && name !== '..';
}

export function loadShipConfig(): ShipConfig {
  if (cached) return cached;

  if (!fs.existsSync(FLEET_PATH)) {
    throw new Error(
      `Missing fleet config: ${FLEET_PATH}\n` +
      'Clone the secrets repo to ~/.config/infiniclaw/secrets',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(FLEET_PATH, 'utf-8'));
  } catch (err) {
    throw new Error(`fleet.json: invalid JSON: ${errStr(err)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error('fleet.json: top-level JSON must be an object');
  }
  const raw = parsed;

  // Resolve bots assigned to this ship
  const hostname = os.hostname();
  if (!isRecord(raw.bots)) {
    throw new Error('fleet.json: "bots" must be an object');
  }
  const bots: string[] = [];
  for (const [name, entry] of Object.entries(raw.bots)) {
    if (!isRecord(entry)) continue;
    if (!isValidBotName(name)) {
      throw new Error(`fleet.json: invalid bot name "${name}"`);
    }
    // Normalize legacy status names before checking
    const status = migrateStatus(entry.status as string);
    if (entry.ship === hostname && (RUNNING_STATUSES as readonly string[]).includes(status)) {
      bots.push(name);
    }
  }

  const config: ShipConfig = {
    bots,
    secretsPath: SECRETS_PATH,
  };

  // S3 config
  if (raw.s3) {
    if (!isRecord(raw.s3)) {
      throw new Error('fleet.json: "s3" must be an object');
    }
    const s3 = raw.s3;
    if (!isNonEmptyString(s3.endpoint) || !isNonEmptyString(s3.bucket) ||
        !isNonEmptyString(s3.accessKey) || !isNonEmptyString(s3.secretKey)) {
      throw new Error('fleet.json: "s3" requires endpoint, bucket, accessKey, secretKey');
    }
    config.s3 = {
      endpoint: s3.endpoint.trim(),
      bucket: s3.bucket.trim(),
      accessKey: s3.accessKey.trim(),
      secretKey: s3.secretKey.trim(),
    };
  }

  cached = config;
  return config;
}

/** Path to the bots subdirectory inside secretsPath. */
export function botsPath(): string {
  return path.join(loadShipConfig().secretsPath, 'bots');
}

/** Load the full fleet config (all bots, not just this ship's).
 * Returns S3-merged cache when available (set by loadFleetAsync at startup).
 * Falls back to disk-only when S3 cache hasn't been populated yet. */
export function loadFleet(): Record<string, BotEntry> {
  if (s3FleetCache) return s3FleetCache;
  return loadFleetFromDisk();
}

/** Load fleet from disk only (fleet.json). Bypasses S3 cache.
 * Use when you need fresh disk state (e.g. after git pull of fleet.json). */
export function loadFleetFromDisk(): Record<string, BotEntry> {
  const raw = readJson<Record<string, unknown>>(FLEET_PATH);
  const bots: Record<string, BotEntry> = (raw.bots as Record<string, BotEntry>) || {};
  // Migrate legacy statuses
  for (const entry of Object.values(bots)) {
    if (!entry.status && 'active' in entry) {
      entry.status = (entry as any).active ? 'onduty' : 'quarters';
      delete (entry as any).active;
    }
    entry.status = migrateStatus(entry.status as string) as BotStatus;
  }
  return bots;
}

/** Write updated fleet config back to disk. */
export function writeFleet(fleet: Record<string, BotEntry>): void {
  const raw = readJson<Record<string, unknown>>(FLEET_PATH);
  raw.bots = fleet;
  writeJson(FLEET_PATH, raw);
}

/**
 * Load fleet state: disk fleet.json (static) → overlay ALL fields from S3.
 * S3 is the authoritative source for complete bot state (static + runtime).
 * Bots found in S3 but not on disk are included (S3 is source of truth for remote ships).
 * Falls back to disk-only if S3 is unavailable.
 * Populates the module-level s3FleetCache so subsequent loadFleet() calls see S3 data.
 */
export async function loadFleetAsync(): Promise<Record<string, BotEntry>> {
  const fleet = loadFleetFromDisk();
  try {
    const { listKeys, downloadJson } = await s3Helpers();
    const keys = await listKeys('fleet-state/');
    for (const key of keys) {
      const shipState = await downloadJson<{ ts?: number; bots?: Record<string, Partial<BotEntry>> }>(key);
      if (!shipState?.bots) continue;
      for (const [bot, s3Entry] of Object.entries(shipState.bots)) {
        if (fleet[bot]) {
          // Overlay all S3 fields — S3 is authoritative for complete bot state
          Object.assign(fleet[bot], s3Entry);
        } else {
          // Bot exists on another ship (S3 only) — include it
          fleet[bot] = s3Entry as BotEntry;
        }
      }
    }
  } catch { /* S3 unavailable — disk-only fallback */ }
  // Cache the S3-merged result so loadFleet() returns it synchronously
  s3FleetCache = fleet;
  return fleet;
}

/**
 * Write fleet state: disk first (synchronous cache), then S3 upload (async).
 * Disk-first ensures loadFleet() always sees the latest state immediately.
 * Updates the S3 fleet cache so all callers see the new state.
 * Uploads complete bot state to S3 (all fields) for bots on this ship.
 */
export async function writeFleetAsync(fleet: Record<string, BotEntry>): Promise<void> {
  // Disk first — synchronous so disk-only fallback is fresh
  writeFleet(fleet);
  // Update in-memory cache — all loadFleet() callers see the new state immediately
  s3FleetCache = fleet;
  // S3 second — upload this ship's complete bot state
  const hostname = os.hostname();
  const shipName = findShipByHostname(hostname)?.[0] ?? hostname;
  const shipBots: Record<string, BotEntry> = {};
  for (const [bot, entry] of Object.entries(fleet)) {
    if (entry.ship !== hostname) continue;
    shipBots[bot] = entry;
  }
  try {
    const { uploadJson } = await s3Helpers();
    await uploadJson(`fleet-state/${shipName}.json`, { ts: Date.now(), bots: shipBots });
  } catch { /* S3 write failed — disk was already written above */ }
}

export interface ShipEntry {
  hostname: string;
  emoji?: string;
  type?: string;          // e.g. "cruiser"
  typeEmoji?: string;     // e.g. "🛳️"
  ip: string | null;
  os: string;
  user: string | null;
  commissioned: boolean;
  rank: number;
  spaceId?: string;
  loungeId?: string;
  quartersSpaceId?: string;
  operatorRelay?: boolean; // whether @ messages are forwarded to this ship's operator tmux
}

/** Load all ships from operator/ships.json. */
export function loadShips(): Record<string, ShipEntry> {
  return readJson<Record<string, ShipEntry>>(SHIPS_PATH);
}

/** Write updated ships config back to disk. */
export function writeShips(ships: Record<string, ShipEntry>): void {
  writeJson(SHIPS_PATH, ships);
}

/** Load ships, returning empty object on error. */
export function safeLoadShips(): Record<string, ShipEntry> {
  try { return loadShips(); } catch { return {}; }
}

/** Find ship entry by hostname. Returns [name, entry] or undefined. */
export function findShipByHostname(hostname?: string): [string, ShipEntry] | undefined {
  const h = hostname ?? os.hostname();
  const ships = safeLoadShips();
  for (const [name, entry] of Object.entries(ships)) {
    if (entry.hostname === h) return [name, entry];
  }
  return undefined;
}

/** Get this ship's entry, looking up by hostname. */
export function thisShip(): ShipEntry | undefined {
  return findShipByHostname()?.[1];
}

/** Get this ship's name (key in ships.json). Falls back to hostname. */
export function thisShipName(): string {
  return findShipByHostname()?.[0] ?? os.hostname();
}

/** Check if this ship is commissioned. */
export function isShipCommissioned(): boolean {
  return thisShip()?.commissioned !== false;
}

/** Role definitions: duty room and icon. Single source of truth for role→room→icon. */
export const ROLE_ROOMS: Record<string, { room: string; icon: string }> = {
  navigator: { room: 'bridge',       icon: '🌉' },
  engineer:  { room: 'engineering',  icon: '⚙️' },
  architect: { room: 'astrometrics', icon: '🔭' },
  normie:    { room: 'lounge',       icon: '🦋' },
};

/**
 * Short display tag: "🦁⭐ Herc" with status pip.
 * pip overrides the auto-derived status ('' commissioned, 💤 decommissioned).
 */
export function shipTag(hostname?: string, pip?: string): string {
  const found = findShipByHostname(hostname);
  if (!found) return hostname ?? os.hostname();
  const [name, entry] = found;
  const statusPip = pip ?? (entry.commissioned !== false ? '◉' : '💤');
  return entry.emoji ? `${entry.emoji}${statusPip} ${name}` : `${statusPip} ${name}`;
}

/**
 * Returns true if the given role has no duty-room access — i.e. its `rw` list
 * in the fleet.json `roles` section is absent or empty.  Bots with such roles
 * (e.g. normie) must never join duty rooms; they are quarters-only.
 */
export function isQuartersOnlyRole(role: string): boolean {
  try {
    const raw = readJson<Record<string, unknown>>(FLEET_PATH);
    const roleConfig = (raw.roles as Record<string, { rw?: string[] }> | undefined)?.[role];
    return !roleConfig?.rw || roleConfig.rw.length === 0;
  } catch {
    return false; // on error, don't block
  }
}

/** Clear cached config (for testing or reload). */
export function clearShipConfigCache(): void {
  cached = null;
  s3FleetCache = null;
}
