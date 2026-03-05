/**
 * Machine configuration.
 * Reads ~/.config/infiniclaw/machine.json to determine which bots run on this machine,
 * where secrets are stored, and optional S3 sync settings.
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

export interface MachineConfig {
  bots: string[];
  secretsPath: string;
  s3?: S3Config;
  containerNetwork?: string; // e.g. "host" — passed as --network to podman run
}

const CONFIG_PATH = path.join(os.homedir(), '.config', 'infiniclaw', 'machine.json');
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

  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Missing machine config: ${CONFIG_PATH}\n` +
      'Create it with at minimum:\n' +
      '{\n  "bots": ["bot1", "bot2"],\n  "secretsPath": "/path/to/secrets"\n}',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    throw new Error(`machine.json: invalid JSON in ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error('machine.json: top-level JSON must be an object');
  }
  const raw = parsed;

  if (!Array.isArray(raw.bots) || raw.bots.length === 0) {
    throw new Error(`machine.json: "bots" must be a non-empty array`);
  }
  const bots = raw.bots.map((value, i) => {
    if (!isNonEmptyString(value)) {
      throw new Error(`machine.json: bots[${i}] must be a non-empty string`);
    }
    const bot = value.trim();
    if (!isValidBotName(bot)) {
      throw new Error(`machine.json: invalid bot name "${bot}"`);
    }
    return bot;
  });
  if (new Set(bots).size !== bots.length) {
    throw new Error('machine.json: "bots" must not contain duplicates');
  }

  if (!isNonEmptyString(raw.secretsPath)) {
    throw new Error(`machine.json: "secretsPath" must be a non-empty string`);
  }
  const secretsPath = path.resolve(raw.secretsPath.trim());
  if (!path.isAbsolute(secretsPath)) {
    throw new Error('machine.json: "secretsPath" must be an absolute path');
  }
  if (!fs.existsSync(secretsPath)) {
    throw new Error(`machine.json: secretsPath does not exist: ${secretsPath}`);
  }
  const secretsStat = fs.statSync(secretsPath);
  if (!secretsStat.isDirectory()) {
    throw new Error(`machine.json: secretsPath must be a directory: ${secretsPath}`);
  }

  const config: MachineConfig = {
    bots,
    secretsPath,
  };

  if (typeof raw.containerNetwork === 'string') {
    if (!/^[a-z][a-z0-9_-]*$/i.test(raw.containerNetwork)) {
      throw new Error(`machine.json: "containerNetwork" must be a valid network name (got "${raw.containerNetwork}")`);
    }
    config.containerNetwork = raw.containerNetwork;
  }

  if (raw.s3) {
    if (!isRecord(raw.s3)) {
      throw new Error('machine.json: "s3" must be an object');
    }
    const s3 = raw.s3;
    if (!isNonEmptyString(s3.endpoint) || !isNonEmptyString(s3.bucket) ||
        !isNonEmptyString(s3.accessKey) || !isNonEmptyString(s3.secretKey)) {
      throw new Error('machine.json: "s3" requires endpoint, bucket, accessKey, secretKey');
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

/** Clear cached config (for testing or reload). */
export function clearMachineConfigCache(): void {
  cached = null;
}
