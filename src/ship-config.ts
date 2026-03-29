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
export interface BotEntry {
  role: string;
  rank: number;
  ship: string | null;
  status: BotStatus;
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
 * S3 is the authoritative source; disk is read-only bootstrap/cache.
 * loadFleet() throws if this is null (loadFleetAsync not yet called).
 */
let s3FleetCache: Record<string, BotEntry> | null = null;

/**
 * Module-level cache of fleet roles (role → { rw? }) seeded from disk fleet.json
 * during loadFleetAsync() bootstrap. Runtime reads use this cache instead of disk.
 */
let s3RolesCache: Record<string, { rw?: string[] }> | null = null;

/**
 * Module-level cache of S3-loaded ships.
 * Populated by loadShipsAsync() at startup, updated by writeShipsAsync().
 * When set, loadShips() returns this instead of disk-only data.
 */
let s3ShipsCache: Record<string, ShipEntry> | null = null;

// ── S3 key helpers ─────────────────────────────────────────────────────────────

/**
 * Derive fleet identifier from INFINICLAW_FLEET env var.
 * fleet.json → "infiniclaw00", fleet01.json → "infiniclaw01", etc.
 * Exported so relay.ts can use it for fleet-namespaced S3 keys.
 */
export function fleetId(): string {
  const fleet = process.env['INFINICLAW_FLEET'] || 'fleet.json';
  const m = fleet.match(/^fleet(\d+)\.json$/);
  if (m) return `infiniclaw${m[1].padStart(2, '0')}`;
  return 'infiniclaw00';
}

/** S3 key for the full fleet config (all bots, S3-authoritative). */
export function fleetConfigKey(): string {
  return `fleet-config/${fleetId()}.json`;
}

/** S3 key for the ships registry (S3-authoritative). */
export const SHIPS_S3_KEY = 'fleet-config/ships.json';

/** S3 key for system aliases (hostname → display name). */
export const SYSTEM_ALIASES_S3_KEY = 'fleet-config/system-aliases.json';

// ── System aliases (hostname → display name, S3-authoritative) ──

let systemAliasCache: Record<string, string> | null = null;

/**
 * Load system aliases from S3. Maps hostname → display name
 * (e.g. "HERACLES" → "Hercules", "mac139160" → "Hermes").
 * Writes /tmp/infiniclaw-system-name for bash scripts (operator/matrix).
 */
export async function loadSystemAliasesAsync(): Promise<Record<string, string>> {
  try {
    const { downloadJson } = await s3Helpers();
    const data = await downloadJson<{ ts?: number; aliases: Record<string, string> }>(SYSTEM_ALIASES_S3_KEY);
    if (data?.aliases) {
      systemAliasCache = data.aliases;
      // Write cache file for bash scripts
      const name = systemAliasCache[os.hostname()] ?? os.hostname();
      fs.writeFileSync('/tmp/infiniclaw-system-name', name);
      return systemAliasCache;
    }
  } catch { /* S3 unavailable */ }
  return systemAliasCache ?? {};
}

/** Get the display name for a system by hostname. Falls back to raw hostname. */
export function systemName(hostname?: string): string {
  const h = hostname ?? os.hostname();
  return systemAliasCache?.[h] ?? h;
}

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
 * Returns the S3-authoritative cache (set by loadFleetAsync at startup).
 * Throws if loadFleetAsync() has not been called — disk fallback is bootstrap only. */
export function loadFleet(): Record<string, BotEntry> {
  if (!s3FleetCache) {
    return loadFleetFromDisk();
  }
  return s3FleetCache;
}

/**
 * Get the fleet roles map (role → { rw? }) from the bootstrap cache.
 * Populated by loadFleetAsync() from disk fleet.json on startup.
 * Returns null if loadFleetAsync() has not been called yet.
 */
export function getFleetRoles(): Record<string, { rw?: string[] }> | null {
  return s3RolesCache;
}

/** Load fleet from disk only (fleet.json). Bypasses S3 cache.
 * Use when you need fresh disk state (e.g. after git pull of fleet.json). */
export function loadFleetFromDisk(): Record<string, BotEntry> {
  const raw = readJson<Record<string, unknown>>(FLEET_PATH, {});
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
 * Load fleet state: disk fleet.json → fleet-config S3 key (static+runtime) → per-ship keys (runtime).
 *
 * Priority (highest wins):
 *   1. Per-ship fleet-state keys (runtime state, most current per ship)
 *   2. fleet-config/{fleetId}.json (full fleet, S3-authoritative for all bots)
 *   3. Disk fleet.json (bootstrap fallback)
 *
 * On first run (no S3 fleet-config key), uploads disk fleet.json to S3 for migration.
 * Falls back to disk-only if S3 is unavailable.
 * Populates s3FleetCache so subsequent loadFleet() calls see S3 data.
 */
export async function loadFleetAsync(): Promise<Record<string, BotEntry>> {
  const fleet = loadFleetFromDisk();
  // Seed roles cache from disk during bootstrap (single read for runtime use)
  try {
    const raw = readJson<Record<string, unknown>>(FLEET_PATH);
    if (isRecord(raw.roles)) {
      s3RolesCache = raw.roles as Record<string, { rw?: string[] }>;
    }
  } catch { /* roles cache left null — isQuartersOnlyRole falls back to false */ }
  try {
    const { listKeys, downloadJson, uploadJson } = await s3Helpers();

    // 1. Overlay fleet-config key (full fleet, S3-authoritative)
    const fleetCfg = await downloadJson<{ ts?: number; bots?: Record<string, Partial<BotEntry>> }>(fleetConfigKey());
    if (fleetCfg?.bots) {
      for (const [bot, s3Entry] of Object.entries(fleetCfg.bots)) {
        if (fleet[bot]) {
          Object.assign(fleet[bot], s3Entry);
        } else {
          fleet[bot] = s3Entry as BotEntry;
        }
      }
    } else {
      // First run: seed S3 from disk (migration)
      await uploadJson(fleetConfigKey(), { ts: Date.now(), bots: fleet });
    }

    // 2. Overlay per-ship fleet-state keys (runtime state, more current than fleet-config)
    const keys = await listKeys('fleet-state/');
    for (const key of keys) {
      const shipState = await downloadJson<{ ts?: number; bots?: Record<string, Partial<BotEntry>> }>(key);
      if (!shipState?.bots) continue;
      for (const [bot, s3Entry] of Object.entries(shipState.bots)) {
        if (fleet[bot]) {
          Object.assign(fleet[bot], s3Entry);
        } else {
          fleet[bot] = s3Entry as BotEntry;
        }
      }
    }
  } catch { /* S3 unavailable — disk-only fallback */ }
  s3FleetCache = fleet;
  return fleet;
}

/**
 * Write fleet state: S3-first (authoritative), disk as write-through cache.
 * In-memory cache is updated immediately so loadFleet() sees the new state.
 *
 * Writes two S3 keys:
 *   - fleet-config/{fleetId}.json — full fleet (all bots), S3-authoritative
 *   - fleet-state/{ship}.json     — this ship's bots only, for fleet-report protocol
 * Disk fleet.json is updated as a cache after S3 (best-effort).
 */
export async function writeFleetAsync(fleet: Record<string, BotEntry>): Promise<void> {
  // Update in-memory cache immediately — loadFleet() callers see the new state at once
  s3FleetCache = fleet;
  // S3 first — authoritative source for all fleet state
  const hostname = os.hostname();
  const shipName = findShipByHostname(hostname)?.[0] ?? hostname;
  const shipBots: Record<string, BotEntry> = {};
  for (const [bot, entry] of Object.entries(fleet)) {
    if (entry.ship !== hostname) continue;
    shipBots[bot] = entry;
  }
  try {
    const { uploadJson } = await s3Helpers();
    // Full fleet config — S3 as authoritative source for all bots
    await uploadJson(fleetConfigKey(), { ts: Date.now(), bots: fleet });
    // Per-ship runtime state — for fleet-report polling protocol
    await uploadJson(`fleet-state/${shipName}.json`, { ts: Date.now(), bots: shipBots });
  } catch { /* S3 write failed — disk cache update still attempted below */ }
  // Disk is write-through cache — update after S3 (best-effort)
  try { writeFleet(fleet); } catch { /* disk write failed — S3 is authoritative */ }
}

export interface ShipEntry {
  name?: string;            // full display name, e.g. "Poseidon"
  hostname: string;
  emoji?: string;
  type?: string;          // e.g. "cruiser"
  typeEmoji?: string;     // e.g. "🛳️"
  ip: string | null;
  os: string;
  user: string | null;
  commissioned: boolean;
  rank: number;
  fleet?: string;         // fleet instance, e.g. "infiniclaw00", "infiniclaw01" (default: infiniclaw00)
  spaceId?: string;
  loungeId?: string;
  quartersSpaceId?: string;
  operatorRelay?: boolean; // whether @ messages are forwarded to this ship's operator tmux
}

/**
 * Load ships: returns S3 cache when available (set by loadShipsAsync at startup),
 * falls back to disk operator/ships.json.
 */
export function loadShips(): Record<string, ShipEntry> {
  if (s3ShipsCache) return s3ShipsCache;
  return readJson<Record<string, ShipEntry>>(SHIPS_PATH);
}

/**
 * Load ships from S3 (authoritative) with disk fallback.
 * S3 key: fleet-config/ships.json — { ts, ships: {...} }.
 * On first run (no S3 key), uploads disk ships.json to S3 for migration.
 * Populates s3ShipsCache so subsequent loadShips() calls see S3 data.
 */
export async function loadShipsAsync(): Promise<Record<string, ShipEntry>> {
  let disk: Record<string, ShipEntry>;
  try {
    disk = readJson<Record<string, ShipEntry>>(SHIPS_PATH);
  } catch {
    disk = {};
  }
  try {
    const { downloadJson, uploadJson } = await s3Helpers();
    const s3Data = await downloadJson<{ ts?: number; ships?: Record<string, ShipEntry> }>(SHIPS_S3_KEY);
    if (s3Data?.ships && Object.keys(s3Data.ships).length > 0) {
      // S3 is authoritative — update disk cache and return S3 data
      writeJson(SHIPS_PATH, s3Data.ships);
      s3ShipsCache = s3Data.ships;
      return s3Data.ships;
    } else {
      // First run: seed S3 from disk (migration)
      await uploadJson(SHIPS_S3_KEY, { ts: Date.now(), ships: disk });
    }
  } catch { /* S3 unavailable — disk-only fallback */ }
  s3ShipsCache = disk;
  return disk;
}

/**
 * Write ships: disk first (sync), then S3 (async).
 * Updates s3ShipsCache immediately so loadShips() sees the new data.
 */
export async function writeShipsAsync(ships: Record<string, ShipEntry>): Promise<void> {
  writeJson(SHIPS_PATH, ships);
  s3ShipsCache = ships;
  try {
    const { uploadJson } = await s3Helpers();
    await uploadJson(SHIPS_S3_KEY, { ts: Date.now(), ships });
  } catch { /* S3 write failed — disk was already written */ }
}

/**
 * Write ships to disk only (synchronous).
 * Updates s3ShipsCache so loadShips() returns the new data immediately.
 * Prefer writeShipsAsync() when in an async context.
 */
export function writeShips(ships: Record<string, ShipEntry>): void {
  writeJson(SHIPS_PATH, ships);
  s3ShipsCache = ships;
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
  trader:    { room: 'bazaar',       icon: '💰' },
  normie:    { room: 'lounge',       icon: '🦋' },
};

/**
 * Display tag: system display name from S3 aliases.
 * System identity, not ship name — ships and systems are different entities.
 * Falls back to raw hostname if no alias configured.
 */
export function shipTag(hostname?: string, _pip?: string): string {
  return systemName(hostname);
}

/**
 * Returns true if the given role has no duty-room access — i.e. its `rw` list
 * in the fleet.json `roles` section is absent or empty.  Bots with such roles
 * (e.g. normie) must never join duty rooms; they are quarters-only.
 */
export function isQuartersOnlyRole(role: string): boolean {
  try {
    // Use S3 cache (populated by loadFleetAsync bootstrap); disk fallback for pre-init callers
    const roles = s3RolesCache ?? (() => {
      const raw = readJson<Record<string, unknown>>(FLEET_PATH);
      return isRecord(raw.roles) ? raw.roles as Record<string, { rw?: string[] }> : null;
    })();
    const roleConfig = roles?.[role];
    return !roleConfig?.rw || roleConfig.rw.length === 0;
  } catch {
    return false; // on error, don't block
  }
}

/** Clear cached config (for testing or reload). */
export function clearShipConfigCache(): void {
  cached = null;
  s3FleetCache = null;
  s3ShipsCache = null;
  s3RolesCache = null;
}
