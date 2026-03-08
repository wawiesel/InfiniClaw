/**
 * Ship configuration.
 * Reads fleet.json from the secrets repo (~/.config/infiniclaw/secrets/bots/fleet.json)
 * to determine which bots run on this ship, S3 settings, and per-ship options.
 * secretsPath is by convention ~/.config/infiniclaw/secrets.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isRecord, readJson, writeJson } from './utils.js';

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export type BotStatus = 'onduty' | 'lounge' | 'quarters' | 'sleep' | 'transit';

export interface BotEntry {
  role: string;
  rank: number;
  ship: string | null;
  status: BotStatus;
  title?: string;
}

export interface ShipConfig {
  bots: string[];
  secretsPath: string;
  s3?: S3Config;
}

const SECRETS_PATH = path.join(os.homedir(), '.config', 'infiniclaw', 'secrets');
const FLEET_PATH = path.join(SECRETS_PATH, 'bots', 'fleet.json');
const SHIPS_PATH = path.join(SECRETS_PATH, 'operator', 'ships.json');
const SAFE_BOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

let cached: ShipConfig | null = null;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidBotName(name: string): boolean {
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
    throw new Error(`fleet.json: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
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
    if (entry.ship === hostname && (entry.status === 'onduty' || (entry.status as string) === 'active')) {
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

/** Load the full fleet config (all bots, not just this ship's). */
export function loadFleet(): Record<string, BotEntry> {
  const raw = readJson<Record<string, unknown>>(FLEET_PATH);
  const bots: Record<string, BotEntry> = (raw.bots as Record<string, BotEntry>) || {};
  // Migrate legacy statuses
  for (const entry of Object.values(bots)) {
    if (!entry.status && 'active' in entry) {
      entry.status = (entry as any).active ? 'onduty' : 'lounge';
      delete (entry as any).active;
    }
    // Migrate old status names
    const s = entry.status as string;
    if (s === 'active') entry.status = 'onduty';
    else if (s === 'dismissed') entry.status = 'lounge';
    else if (s === 'sleeping') entry.status = 'sleep';
  }
  return bots;
}

/** Write updated fleet config back to disk. */
export function writeFleet(fleet: Record<string, BotEntry>): void {
  const raw = readJson<Record<string, unknown>>(FLEET_PATH);
  raw.bots = fleet;
  writeJson(FLEET_PATH, raw);
}

export interface ShipEntry {
  ip: string | null;
  os: string;
  user: string | null;
  active: boolean;
  rank: number;
  spaceId?: string;
  loungeId?: string;
  quartersSpaceId?: string;
}

/** Load all ships from operator/ships.json. */
export function loadShips(): Record<string, ShipEntry> {
  return readJson<Record<string, ShipEntry>>(SHIPS_PATH);
}

/** Write updated ships config back to disk. */
export function writeShips(ships: Record<string, ShipEntry>): void {
  writeJson(SHIPS_PATH, ships);
}

/** Check if this ship is active. */
export function isShipActive(): boolean {
  try {
    const ships = loadShips();
    const hostname = os.hostname();
    return ships[hostname]?.active !== false;
  } catch {
    return true; // default to active if ships.json missing
  }
}

/** Clear cached config (for testing or reload). */
export function clearShipConfigCache(): void {
  cached = null;
}
