/**
 * Service module: all start/stop/chat/deploy logic.
 * Replaces scripts/start, scripts/stop, scripts/chat, scripts/common.sh, scripts/validate-deploy.sh.
 * All operations are synchronous (CLI tool, not async server).
 */
import crypto from 'crypto';
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { parseEnvFile } from 'nanoclaw/env-utils.js';
import { loadShipConfig, loadFleet } from './ship-config.js';
import { shellQuote, resolveRoot, assertValidBotName } from './utils.js';
import { resolveOAuthToken } from './auth-service.js';
import { pm2Stop, pm2StartBot, pm2Name } from './process-manager.js';

export function getActiveBots(): string[] {
  return loadShipConfig().bots;
}

const ROLE_PATTERN = /^[A-Za-z0-9._-]*$/;

export function instanceDir(root: string, bot: string): string {
  assertValidBotName(bot);
  return path.join(root, '_runtime', 'instances', bot);
}

export function logDir(root: string): string {
  return path.join(root, '_runtime', 'logs');
}

export function resolveRole(bot: string): string {
  try {
    const fleet = loadFleet();
    const role = (fleet[bot]?.role || '').toLowerCase();
    if (role && (!ROLE_PATTERN.test(role) || role.includes('..'))) throw new Error(`Invalid role: ${role}`);
    return role;
  } catch { return ''; }
}

export function personaDir(root: string, bot: string): string {
  assertValidBotName(bot);
  return path.join(root, 'bots', resolveRole(bot), bot);
}

export function profileEnvPath(_root: string, bot: string): string {
  assertValidBotName(bot);
  return path.join(loadShipConfig().secretsPath, 'bots', bot, 'env');
}

export function seedMainRoomRegistration(instanceBase: string, mainJid: string, mainGroupName: string, mainGroupFolder: string, requiresTrigger: boolean): void {
  const storeDir = path.join(instanceBase, 'store');
  fs.mkdirSync(storeDir, { recursive: true });
  const seedDb = new Database(path.join(storeDir, 'messages.db'));
  try {
    seedDb.exec(`CREATE TABLE IF NOT EXISTS registered_groups (jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE, trigger_pattern TEXT NOT NULL, added_at TEXT NOT NULL, container_config TEXT, requires_trigger INTEGER DEFAULT 1)`);
    seedDb.prepare(`INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger) VALUES (?, ?, ?, ?, ?, ?)`).run(mainJid, mainGroupName, mainGroupFolder, '', new Date().toISOString(), requiresTrigger ? 1 : 0);
  } finally { seedDb.close(); }
}

export function loadProfileEnv(root: string, bot: string): Record<string, string> {
  const envFile = profileEnvPath(root, bot);
  if (!fs.existsSync(envFile)) throw new Error(`Missing profile env: ${envFile}`);
  return parseEnvFile(envFile);
}

export function collectBotMatrixUserIds(): Set<string> {
  const config = loadShipConfig();
  const ids = new Set<string>();
  try {
    for (const bot of fs.readdirSync(path.join(config.secretsPath, 'bots'))) {
      const envFile = path.join(config.secretsPath, 'bots', bot, 'env');
      if (fs.existsSync(envFile)) {
        const env = parseEnvFile(envFile);
        if (env.MATRIX_USER_ID) ids.add(env.MATRIX_USER_ID);
      }
    }
  } catch { }
  return ids;
}

export function applyBrainEnv(env: Record<string, string>): Record<string, string> {
  const out = { ...env };
  const isOllama = Boolean(out.BRAIN_BASE_URL);
  out.ANTHROPIC_MODEL = out.BRAIN_MODEL || '';
  if (isOllama) {
    out.ANTHROPIC_SMALL_FAST_MODEL = out.BRAIN_MODEL || '';
    out.ANTHROPIC_DEFAULT_SONNET_MODEL = out.BRAIN_MODEL || '';
  }
  out.ANTHROPIC_BASE_URL = out.BRAIN_BASE_URL || '';
  out.ANTHROPIC_AUTH_TOKEN = out.BRAIN_AUTH_TOKEN || '';
  out.ANTHROPIC_API_KEY = out.BRAIN_API_KEY || '';
  out.CLAUDE_CODE_OAUTH_TOKEN = out.BRAIN_OAUTH_TOKEN || resolveOAuthToken();
  if (out.BRAIN_CA_CERT_FILE) out.NODE_EXTRA_CA_CERTS = out.BRAIN_CA_CERT_FILE;
  return out;
}

// Re-exports from services to maintain backward compatibility where needed
export { ensurePodmanReady, killStaleContainers } from './podman-service.js';
export { deployBot, validateDeploy, rebuildImage, rsyncInstance } from './deploy-service.js';
export { syncPersona, restorePersona } from './persona-service.js';
export { holodeckCreate, holodeckTeardown, holodeckPromote } from './holodeck-service.js';

export function bootstrapBot(root: string, bot: string): void {
  const allowed = getActiveBots();
  if (!allowed.includes(bot)) throw new Error(`${bot} not assigned to this ship`);
  const instance = instanceDir(root, bot);
  const logs = logDir(root);
  fs.mkdirSync(logs, { recursive: true });
  // Dynamic import to avoid circular dep
  import('./deploy-service.js').then(s => s.deployBot(root, bot));
  pm2StartBot(bot, process.execPath, instance, logs, root);
}

export function stopBot(bot: string): void {
  assertValidBotName(bot);
  pm2Stop(pm2Name(bot));
}

export async function installRelay(): Promise<void> {
  const root = resolveRoot();
  const logs = logDir(root);
  fs.mkdirSync(logs, { recursive: true });
  execSync('npm run build', { cwd: root, stdio: 'inherit', env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` } });
  startRelay();
  try { execFileSync('pm2', ['startup'], { stdio: 'inherit' }); } catch { }
  try { execFileSync('pm2', ['save'], { stdio: 'pipe' }); } catch { }
}

export function startRelay(): void {
  const root = resolveRoot();
  const logs = logDir(root);
  fs.mkdirSync(logs, { recursive: true });
  pm2Stop('infiniclaw-relay');
  const distFile = path.join(root, 'dist', 'relay.js');
  if (!fs.existsSync(distFile)) throw new Error('dist/relay.js not found');
  execFileSync('pm2', ['start', process.execPath, '--name', 'infiniclaw-relay', '--cwd', root, '--output', path.join(logs, 'relay.log'), '--error', path.join(logs, 'relay.error.log'), '--restart-delay', '5000', '--max-restarts', '50', '--', distFile], {
    stdio: 'inherit',
    env: { ...process.env, INFINICLAW_ROOT: root, HOME: os.homedir(), PATH: `${path.dirname(process.execPath)}:${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` }
  });
}

export function stopRelay(): void {
  for (const bot of getActiveBots()) {
    pm2Stop(pm2Name(bot));
    pm2Stop(pm2Name(`${bot}-holodeck`));
  }
  pm2Stop('infiniclaw-relay');
}

export function removeStaleProcesses(): void {
  const validNames = new Set([...getActiveBots().map(pm2Name), 'infiniclaw-relay']);
  try {
    const out = execFileSync('pm2', ['jlist'], { encoding: 'utf-8' });
    const list = JSON.parse(out) as Array<{ name: string }>;
    for (const proc of list) {
      if (proc.name.startsWith('infiniclaw-') && !validNames.has(proc.name) && !proc.name.includes('-holodeck')) {
        pm2Stop(proc.name);
      }
    }
  } catch { }
}
