/**
 * Machine configuration.
 * Reads fleet.json from the secrets repo (~/.config/infiniclaw/secrets/bots/fleet.json)
 * to determine which bots run on this machine, S3 settings, and per-machine options.
 * No machine.json needed — secretsPath is by convention ~/.config/infiniclaw/secrets.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export type BotStatus = 'active' | 'dismissed' | 'transit';

export interface BotEntry {
  role: string;
  rank: number;
  machine: string | null;
  status: BotStatus;
  title?: string;
}

export interface MachineConfig {
  bots: string[];
  secretsPath: string;
  s3?: S3Config;
}

const SECRETS_PATH = path.join(os.homedir(), '.config', 'infiniclaw', 'secrets');
const FLEET_PATH = path.join(SECRETS_PATH, 'bots', 'fleet.json');
const MACHINES_PATH = path.join(SECRETS_PATH, 'operator', 'machines.json');
const SAFE_BOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

let cached: MachineConfig | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidBotName(name: string): boolean {
  return SAFE_BOT_NAME.test(name) && name !== '.' && name !== '..';
}

export function loadMachineConfig(): MachineConfig {
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

  // Resolve bots assigned to this machine
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
    if (entry.machine === hostname && entry.status === 'active') {
      bots.push(name);
    }
  }

  const config: MachineConfig = {
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
  return path.join(loadMachineConfig().secretsPath, 'bots');
}

/** Load the full fleet config (all bots, not just this machine's). */
export function loadFleet(): Record<string, BotEntry> {
  const raw = JSON.parse(fs.readFileSync(FLEET_PATH, 'utf-8'));
  const bots: Record<string, BotEntry> = raw.bots || {};
  // Migrate legacy active:boolean → status enum
  for (const entry of Object.values(bots)) {
    if (!entry.status && 'active' in entry) {
      entry.status = (entry as any).active ? 'active' : 'dismissed';
      delete (entry as any).active;
    }
  }
  return bots;
}

/** Write updated fleet config back to disk. */
export function writeFleet(fleet: Record<string, BotEntry>): void {
  const raw = JSON.parse(fs.readFileSync(FLEET_PATH, 'utf-8'));
  raw.bots = fleet;
  fs.writeFileSync(FLEET_PATH, JSON.stringify(raw, null, 2) + '\n');
}

export interface MachineEntry {
  ip: string | null;
  os: string;
  user: string | null;
  active: boolean;
  rank: number;
}

/** Load all machines from operator/machines.json. */
export function loadMachines(): Record<string, MachineEntry> {
  return JSON.parse(fs.readFileSync(MACHINES_PATH, 'utf-8'));
}

/** Write updated machines config back to disk. */
export function writeMachines(machines: Record<string, MachineEntry>): void {
  fs.writeFileSync(MACHINES_PATH, JSON.stringify(machines, null, 2) + '\n');
}

/** Check if this machine is active. */
export function isMachineActive(): boolean {
  try {
    const machines = loadMachines();
    const hostname = os.hostname();
    return machines[hostname]?.active !== false;
  } catch {
    return true; // default to active if machines.json missing
  }
}

/** Clear cached config (for testing or reload). */
export function clearMachineConfigCache(): void {
  cached = null;
}
