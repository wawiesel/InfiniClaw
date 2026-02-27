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
}

const CONFIG_PATH = path.join(os.homedir(), '.config', 'infiniclaw', 'machine.json');

let cached: MachineConfig | null = null;

export function loadMachineConfig(): MachineConfig {
  if (cached) return cached;

  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Missing machine config: ${CONFIG_PATH}\n` +
      'Create it with at minimum:\n' +
      '{\n  "bots": ["engineer", "commander", "architect"],\n  "secretsPath": "/path/to/secrets/profiles"\n}',
    );
  }

  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

  if (!Array.isArray(raw.bots) || raw.bots.length === 0) {
    throw new Error(`machine.json: "bots" must be a non-empty array`);
  }
  if (typeof raw.secretsPath !== 'string' || !raw.secretsPath) {
    throw new Error(`machine.json: "secretsPath" must be a non-empty string`);
  }
  if (!fs.existsSync(raw.secretsPath)) {
    throw new Error(`machine.json: secretsPath does not exist: ${raw.secretsPath}`);
  }

  const config: MachineConfig = {
    bots: raw.bots as string[],
    secretsPath: raw.secretsPath as string,
  };

  if (raw.s3) {
    const s3 = raw.s3;
    if (typeof s3.endpoint !== 'string' || typeof s3.bucket !== 'string' ||
        typeof s3.accessKey !== 'string' || typeof s3.secretKey !== 'string') {
      throw new Error('machine.json: "s3" requires endpoint, bucket, accessKey, secretKey');
    }
    config.s3 = s3 as S3Config;
  }

  cached = config;
  return config;
}

/** Clear cached config (for testing or reload). */
export function clearMachineConfigCache(): void {
  cached = null;
}
