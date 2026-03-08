import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { isOllamaBaseUrl, upsertEnvLine } from 'nanoclaw/env-utils.js';
import { loadShipConfig } from './ship-config.js';

/** Single-quote a value for safe embedding in a bash script. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Format duration in ms to a human-readable string. */
export function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hrs = (ms / 3_600_000).toFixed(1).replace(/\.0$/, '');
  return `${hrs}h`;
}

/** Format current time to HH:MM. */
export function formatTimestamp(): string {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

/** Get string representation of an error. */
export function errStr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Resolve InfiniClaw root directory. */
export function resolveRoot(): string {
  const explicit = process.env.INFINICLAW_ROOT?.trim();
  if (explicit) return explicit;
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'bots')) && fs.existsSync(path.join(dir, 'external', 'nanoclaw'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('Cannot resolve InfiniClaw root. Set INFINICLAW_ROOT or run from project directory.');
}

const BOT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Assert that a bot name is valid. */
export function assertValidBotName(bot: string): void {
  if (!BOT_NAME_PATTERN.test(bot) || bot.includes('..')) {
    throw new Error(`Invalid bot name: ${bot}`);
  }
}

/** Get git version info for the current repository. */
export function getGitVersion(root: string): string {
  try {
    const stamped = fs.readFileSync(path.join(root, 'GIT_VERSION'), 'utf-8').trim();
    if (stamped) return stamped;
  } catch { /* fall through */ }

  try {
    const opts = { cwd: root, encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as const };
    const hash = execSync('git rev-parse --short HEAD', opts).trim();
    const date = execSync('git log -1 --format=%ci HEAD', opts).trim().slice(0, 10);
    const subject = execSync('git log -1 --format=%s HEAD', opts).trim();
    return `${hash} (${date}) ${subject}`;
  } catch {
    return 'unknown';
  }
}

export function applyBrainMode(
  bot: string,
  mode: 'anthropic' | 'ollama',
  model?: string,
): string {
  const config = loadShipConfig();
  const envFile = path.join(config.secretsPath, 'bots', bot, 'env');
  if (!fs.existsSync(envFile)) {
    throw new Error(`Missing profile env: ${envFile}`);
  }

  if (mode === 'anthropic') {
    upsertEnvLine(envFile, 'BRAIN_MODEL', model || 'claude-sonnet-4-6');
    upsertEnvLine(envFile, 'BRAIN_BASE_URL', '');
    upsertEnvLine(envFile, 'BRAIN_AUTH_TOKEN', '');
    upsertEnvLine(envFile, 'BRAIN_API_KEY', '');
    const effectiveModel = model || 'claude-sonnet-4-6';
    return `Updated ${bot} to anthropic/${effectiveModel}. Restart required.`;
  }

  const effectiveModel = model || 'devstral-small-2-fast:latest';
  upsertEnvLine(envFile, 'BRAIN_MODEL', effectiveModel);
  upsertEnvLine(
    envFile,
    'BRAIN_BASE_URL',
    'http://host.containers.internal:11434',
  );
  upsertEnvLine(envFile, 'BRAIN_AUTH_TOKEN', 'ollama');
  upsertEnvLine(envFile, 'BRAIN_API_KEY', '');
  upsertEnvLine(envFile, 'BRAIN_OAUTH_TOKEN', '');
  return `Updated ${bot} to ollama/${effectiveModel}. Restart required.`;
}
