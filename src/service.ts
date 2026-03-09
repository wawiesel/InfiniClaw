/**
 * Service module: all start/stop/chat/deploy logic.
 * Replaces scripts/start, scripts/stop, scripts/chat, scripts/common.sh, scripts/validate-deploy.sh.
 * All operations are synchronous (CLI tool, not async server).
 */
import crypto from 'crypto';
import { execFileSync, execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { parseEnvFile } from './env-utils.js';
import { recoverPodman, stopContainersByPrefix } from './podman-utils.js';

import { loadShipConfig, loadFleet, SAFE_BOT_NAME } from './ship-config.js';
import { shellQuote } from './utils.js';

// ── Constants ──────────────────────────────────────────────────────────

// pm2 binary resolved from project node_modules
const PM2_BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'node_modules', '.bin', 'pm2');

export function getActiveBots(): string[] {
  return loadShipConfig().bots;
}

const RSYNC_EXCLUDES = [
  'node_modules',
  'data',
  'store',
  'logs',
  '.env.local',
];

const ROLE_PATTERN = /^[A-Za-z0-9._-]*$/;

function assertValidBotName(bot: string): void {
  if (!SAFE_BOT_NAME.test(bot) || bot.includes('..')) {
    throw new Error(`Invalid bot name: ${bot}`);
  }
}

// ── Path helpers ───────────────────────────────────────────────────────

export function resolveRoot(): string {
  const explicit = process.env.INFINICLAW_ROOT?.trim();
  if (explicit) return explicit;
  // Walk up from cwd looking for bots/ + external/nanoclaw/
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'bots')) && fs.existsSync(path.join(dir, 'external', 'nanoclaw'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('Cannot resolve InfiniClaw root. Set INFINICLAW_ROOT or run from project directory.');
}

function externalNanoclawDir(root: string): string {
  return path.join(root, 'external', 'nanoclaw');
}

export function instanceDir(root: string, bot: string): string {
  assertValidBotName(bot);
  return path.join(root, '_runtime', 'instances', bot);
}

function logDir(root: string): string {
  return path.join(root, '_runtime', 'logs');
}

function resolveRole(bot: string): string {
  try {
    const fleet = loadFleet();
    const role = (fleet[bot]?.role || '').toLowerCase();
    if (role && (!ROLE_PATTERN.test(role) || role.includes('..'))) {
      throw new Error(`Invalid role for bot ${bot}: ${role}`);
    }
    return role;
  } catch {
    return '';
  }
}

function personaDir(root: string, bot: string): string {
  assertValidBotName(bot);
  return path.join(root, 'bots', resolveRole(bot), bot);
}

function profileEnvPath(_root: string, bot: string): string {
  assertValidBotName(bot);
  const config = loadShipConfig();
  return path.join(config.secretsPath, 'bots', bot, 'env');
}

/** Seed the registered_groups table with the main room from profile env. */
function seedMainRoomRegistration(instanceBase: string, mainJid: string, mainGroupName: string, mainGroupFolder: string, requiresTrigger: boolean): void {
  const storeDir = path.join(instanceBase, 'store');
  fs.mkdirSync(storeDir, { recursive: true });
  const seedDb = new Database(path.join(storeDir, 'messages.db'));
  try {
    seedDb.exec(`CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL, added_at TEXT NOT NULL,
      container_config TEXT, requires_trigger INTEGER DEFAULT 1
    )`);
    seedDb.prepare(
      `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(mainJid, mainGroupName, mainGroupFolder, '', new Date().toISOString(), requiresTrigger ? 1 : 0);
  } finally {
    seedDb.close();
  }
}

// ── Env loading ────────────────────────────────────────────────────────

export function loadProfileEnv(root: string, bot: string): Record<string, string> {
  const envFile = profileEnvPath(root, bot);
  if (!fs.existsSync(envFile)) {
    throw new Error(`Missing profile env: ${envFile}\nCopy from: ${envFile}.example`);
  }
  return parseEnvFile(envFile);
}

/** Collect MATRIX_USER_ID from all bot env files in the secrets directory. */
export function collectBotMatrixUserIds(): Set<string> {
  const config = loadShipConfig();
  const ids = new Set<string>();
  try {
    for (const bot of fs.readdirSync(path.join(config.secretsPath, 'bots'))) {
      const envFile = path.join(config.secretsPath, 'bots', bot, 'env');
      if (!fs.existsSync(envFile)) continue;
      const env = parseEnvFile(envFile);
      if (env.MATRIX_USER_ID) ids.add(env.MATRIX_USER_ID);
    }
  } catch (err) { console.warn('Failed to read bot matrix user IDs:', err instanceof Error ? err.message : err); }
  return ids;
}

export function applyBrainEnv(env: Record<string, string>): Record<string, string> {
  const out = { ...env };

  // For Anthropic mode (no custom base URL): only override the main model.
  // Let the SDK use its own defaults for small/fast and sonnet.
  // For Ollama mode (custom base URL set): override all three model vars so the
  // SDK doesn't fall back to Anthropic defaults.
  const isOllama = Boolean(out.BRAIN_BASE_URL);
  out.ANTHROPIC_MODEL = out.BRAIN_MODEL || '';
  if (isOllama) {
    out.ANTHROPIC_SMALL_FAST_MODEL = out.BRAIN_MODEL || '';
    out.ANTHROPIC_DEFAULT_SONNET_MODEL = out.BRAIN_MODEL || '';
  }
  out.ANTHROPIC_BASE_URL = out.BRAIN_BASE_URL || '';
  out.ANTHROPIC_AUTH_TOKEN = out.BRAIN_AUTH_TOKEN || '';
  out.ANTHROPIC_API_KEY = out.BRAIN_API_KEY || '';
  out.CLAUDE_CODE_OAUTH_TOKEN = out.BRAIN_OAUTH_TOKEN || '';
  if (out.BRAIN_CA_CERT_FILE) out.NODE_EXTRA_CA_CERTS = out.BRAIN_CA_CERT_FILE;

  // Local fallback: if no explicit profile OAuth token, pull from macOS keychain
  if (!out.CLAUDE_CODE_OAUTH_TOKEN) {
    out.CLAUDE_CODE_OAUTH_TOKEN = resolveOAuthToken();
  }

  return out;
}

/** Warn thresholds for OAuth token expiry. */
const TOKEN_EXPIRY_WARN_DAYS = 7;
const TOKEN_EXPIRY_CRIT_DAYS = 1;

function resolveOAuthToken(): string {
  try {
    const credJson = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    ).trim();
    if (!credJson) return '';
    const parsed = JSON.parse(credJson);
    const oauth = parsed?.claudeAiOauth;
    if (!oauth?.accessToken) return '';

    checkTokenExpiry(oauth.expiresAt);
    return oauth.accessToken;
  } catch {
    return '';
  }
}

function checkTokenExpiry(expiresAt: number | undefined): void {
  if (!expiresAt) return;
  const now = Date.now();
  const remaining = expiresAt - now;
  const days = remaining / (1000 * 60 * 60 * 24);

  if (remaining <= 0) {
    console.error(
      `\x1b[31m[AUTH] OAuth token EXPIRED ${Math.abs(Math.round(days))} day(s) ago. ` +
      `Run \`claude setup-token\` to renew.\x1b[0m`,
    );
  } else if (days <= TOKEN_EXPIRY_CRIT_DAYS) {
    console.error(
      `\x1b[31m[AUTH] OAuth token expires in ${Math.round(days * 24)} hours. ` +
      `Run \`claude setup-token\` to renew.\x1b[0m`,
    );
  } else if (days <= TOKEN_EXPIRY_WARN_DAYS) {
    console.warn(
      `\x1b[33m[AUTH] OAuth token expires in ${Math.round(days)} day(s). ` +
      `Run \`claude setup-token\` to renew.\x1b[0m`,
    );
  }
}

// ── Podman ─────────────────────────────────────────────────────────────

export function ensurePodmanReady(): void {
  try {
    execSync('podman info', { stdio: 'pipe' });
    return;
  } catch { /* fall through to recovery */ }
  if (!recoverPodman()) {
    throw new Error(
      'Podman API unavailable after recovery attempt.\n' +
      'Try: podman machine stop podman-machine-default && podman machine start podman-machine-default',
    );
  }
}

export function killStaleContainers(onlyBot?: string): void {
  if (onlyBot) assertValidBotName(onlyBot);
  const prefix = onlyBot ? `nanoclaw-${onlyBot}-` : 'nanoclaw-';
  const stopped = stopContainersByPrefix(prefix, 5);
  for (const name of stopped) {
    console.log(`Stopping stale container: ${name}`);
  }
}

// ── Process cleanup ────────────────────────────────────────────────────

export function killRogueProcesses(): void {
  try {
    const output = execSync("pgrep -f 'nanoclaw.*dist/main\\.js'", {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    for (const pid of output.trim().split('\n').filter(Boolean)) {
      try { process.kill(parseInt(pid, 10)); } catch { /* best effort */ }
    }
  } catch {
    // no matching processes
  }
}

// ── Deploy ─────────────────────────────────────────────────────────────

/**
 * Full deploy: rsync → npm ci if needed → build.
 */
export function deployBot(root: string, bot: string): void {
  const instance = instanceDir(root, bot);
  fs.mkdirSync(instance, { recursive: true });

  rebuildImageIfChanged(root, bot);
  rsyncInstance(root, instance);
  stampGitVersion(root, instance);

  // Install deps if lockfile differs
  const lockSrc = path.join(root, 'package-lock.json');
  const lockDst = path.join(instance, 'node_modules', '.package-lock.json');
  if (!fs.existsSync(path.join(instance, 'node_modules')) || !filesEqual(lockSrc, lockDst)) {
    console.log(`${bot}: installing dependencies...`);
    execSync('npm ci', { cwd: instance, stdio: 'inherit', timeout: 300_000 });
    try { fs.copyFileSync(path.join(instance, 'package-lock.json'), lockDst); } catch { /* ok */ }
  }

  // Build TypeScript
  console.log(`${bot}: building...`);
  execSync('npm run build', { cwd: instance, stdio: 'inherit', timeout: 120_000 });

  // Pre-register main room from profile env
  const profileEnv = loadProfileEnv(root, bot);
  const mainJid = profileEnv.LOCAL_MIRROR_MATRIX_JID;
  const mainGroupName = profileEnv.MAIN_GROUP_NAME;
  const mainGroupFolder = profileEnv.MAIN_GROUP_FOLDER || 'main';

  if (mainJid && mainGroupName) {
    seedMainRoomRegistration(instance, mainJid, mainGroupName, mainGroupFolder, true);
    console.log(`${bot}: pre-registered ${mainGroupName} (${mainGroupFolder})`);
  }

  const dataDir = path.join(instance, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(path.join(dataDir, 'run-id'), `${Date.now()}`);
}

/**
 * Validate code compiles before allowing a restart.
 * Syncs to staging dir, symlinks node_modules, runs tsc --noEmit.
 */
export function validateDeploy(root: string, bot: string): { ok: boolean; errors: string } {
  const instance = instanceDir(root, bot);
  const staging = path.join(root, '_runtime', 'staging', bot);
  fs.mkdirSync(staging, { recursive: true });

  rsyncInstance(root, staging, 'pipe');

  // Symlink node_modules from live instance (fall back to any bot's instance for new bots)
  let instanceModules = path.join(instance, 'node_modules');
  if (!fs.existsSync(instanceModules)) {
    for (const fallback of getActiveBots()) {
      const alt = path.join(instanceDir(root, fallback), 'node_modules');
      if (fs.existsSync(alt)) { instanceModules = alt; break; }
    }
  }
  if (fs.existsSync(instanceModules)) {
    const stagingModules = path.join(staging, 'node_modules');
    try { fs.unlinkSync(stagingModules); } catch { /* ok */ }
    try { fs.rmSync(stagingModules, { recursive: true }); } catch { /* ok */ }
    fs.symlinkSync(instanceModules, stagingModules);
  }

  try {
    execSync('npx tsc --noEmit', { cwd: staging, stdio: 'pipe', encoding: 'utf-8' });
    return { ok: true, errors: '' };
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr || (err as Error).message;
    return { ok: false, errors: stderr };
  }
}

/** Find a bot's Dockerfile: searches bots/{role}/{bot}/Dockerfile. */
function findDockerfile(root: string, bot: string): string | null {
  const botsDir = path.join(root, 'bots');
  try {
    for (const role of fs.readdirSync(botsDir, { withFileTypes: true })) {
      if (!role.isDirectory()) continue;
      const candidate = path.join(botsDir, role.name, bot, 'Dockerfile');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* ignore */ }
  return null;
}

export function rebuildImage(root: string, bot: string): void {
  const script = path.join(root, 'bots', 'build.sh');
  execFileSync(script, [bot], { stdio: 'inherit' });
}

/** Hash all files that contribute to a bot's container image. */
function computeBuildContextHash(root: string, bot: string): string {
  const hash = crypto.createHash('sha256');
  // Bot-specific Dockerfile
  const dockerfile = findDockerfile(root, bot);
  if (dockerfile) hash.update(fs.readFileSync(dockerfile));
  // Shared build context: external/nanoclaw/container/agent-runner/
  const agentRunner = path.join(root, 'external', 'nanoclaw', 'container', 'agent-runner');
  if (fs.existsSync(agentRunner)) {
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else hash.update(fs.readFileSync(full));
      }
    };
    walk(agentRunner);
  }
  return hash.digest('hex');
}

/** Rebuild the container image for a bot only if the build context changed. */
function rebuildImageIfChanged(root: string, bot: string): void {
  const hashDir = path.join(root, '_runtime', 'data');
  fs.mkdirSync(hashDir, { recursive: true });
  const hashFile = path.join(hashDir, `image-hash-${bot}`);
  const currentHash = computeBuildContextHash(root, bot);
  let storedHash = '';
  try { storedHash = fs.readFileSync(hashFile, 'utf8').trim(); } catch { /* first run */ }
  // Also rebuild if the image was removed (e.g. podman rmi)
  let imageExists = true;
  try {
    execFileSync('podman', ['image', 'exists', `nanoclaw-${bot}:latest`], { stdio: 'pipe' });
  } catch { imageExists = false; }
  if (currentHash === storedHash && imageExists) {
    console.log(`${bot}: container image up to date`);
    return;
  }
  console.log(`${bot}: build context changed, rebuilding image...`);
  rebuildImage(root, bot);
  fs.writeFileSync(hashFile, currentHash);
}

// ── pm2 helpers ─────────────────────────────────────────────────────

function pm2Name(bot: string): string {
  return `infiniclaw-${bot}`;
}

function pm2Stop(name: string): void {
  try { execFileSync(PM2_BIN, ['delete', name], { stdio: 'pipe' }); } catch { /* ok — not running */ }
}

/** Stamp git version info into instance so running code knows its deploy commit. */
function stampGitVersion(root: string, instance: string): void {
  try {
    const opts = { cwd: root, encoding: 'utf-8' as const, stdio: 'pipe' as const };
    const hash = execSync('git rev-parse --short HEAD', opts).toString().trim();
    const date = execSync('git log -1 --format=%ci HEAD', opts).toString().trim().slice(0, 10);
    const subject = execSync('git log -1 --format=%s HEAD', opts).toString().trim();
    fs.writeFileSync(path.join(instance, 'GIT_VERSION'), `${hash} (${date}) ${subject}\n`);
  } catch {
    // Not a git repo or git unavailable — skip
  }
}

/**
 * Sync project files to an instance directory.
 * Copies external/nanoclaw/, src/, and root config files.
 */
function rsyncInstance(root: string, dst: string, stdio: 'inherit' | 'pipe' = 'inherit'): void {
  const excludeArgs = RSYNC_EXCLUDES.flatMap((e) => ['--exclude', e]);

  // 1. external/nanoclaw/ → instance/external/nanoclaw/
  const ncDst = path.join(dst, 'external', 'nanoclaw');
  fs.mkdirSync(ncDst, { recursive: true });
  execFileSync('rsync', ['-a', '--delete', ...excludeArgs, `${externalNanoclawDir(root)}/`, `${ncDst}/`], { stdio });

  // 2. src/ → instance/src/
  const srcDst = path.join(dst, 'src');
  fs.mkdirSync(srcDst, { recursive: true });
  execFileSync('rsync', ['-a', '--delete', `${path.join(root, 'src')}/`, `${srcDst}/`], { stdio });

  // 3. scripts/ → instance/scripts/
  const scriptsSrc = path.join(root, 'scripts');
  if (fs.existsSync(scriptsSrc)) {
    const scriptsDst = path.join(dst, 'scripts');
    fs.mkdirSync(scriptsDst, { recursive: true });
    execFileSync('rsync', ['-a', '--delete', `${scriptsSrc}/`, `${scriptsDst}/`], { stdio });
  }

  // 4. Root config files
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) {
    const src = path.join(root, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dst, file));
  }

  // 4. Base CLAUDE.md from bots/
  const baseClaude = path.join(root, 'bots', 'CLAUDE.md');
  if (fs.existsSync(baseClaude)) fs.copyFileSync(baseClaude, path.join(dst, 'CLAUDE.md'));
}

/** Generate a shell wrapper that sources the env file at launch time. */
function generateStartScript(root: string, bot: string, nodeBin: string, instance: string): string {
  const config = loadShipConfig();
  const envFile = path.join(config.secretsPath, 'bots', bot, 'env');
  const pathVal = `${path.dirname(process.execPath)}:${os.homedir()}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin`;
  return `#!/bin/bash
# Auto-generated by InfiniClaw — DO NOT EDIT
# Sources env from secrets repo so values are never hardcoded.
set -a
source ${shellQuote(envFile)}
set +a

# Computed vars
export PERSONA_NAME=${shellQuote(bot)}
export INFINICLAW_ROOT=${shellQuote(root)}
export PATH=${shellQuote(pathVal)}
export HOME=${shellQuote(os.homedir())}

# Captain identity (fleet-wide, from secrets/captain)
CAPTAIN_FILE=${shellQuote(path.join(config.secretsPath, 'captain'))}
if [ -f "\$CAPTAIN_FILE" ]; then
  source "\$CAPTAIN_FILE"
  export CAPTAIN_USER_ID
fi

# Brain env → Anthropic/Claude SDK env (mirrors applyBrainEnv)
export ANTHROPIC_MODEL="\${BRAIN_MODEL:-}"
if [ -n "\${BRAIN_BASE_URL:-}" ]; then
  export ANTHROPIC_SMALL_FAST_MODEL="\${BRAIN_MODEL:-}"
  export ANTHROPIC_DEFAULT_SONNET_MODEL="\${BRAIN_MODEL:-}"
fi
export ANTHROPIC_BASE_URL="\${BRAIN_BASE_URL:-}"
export ANTHROPIC_AUTH_TOKEN="\${BRAIN_AUTH_TOKEN:-}"
export ANTHROPIC_API_KEY="\${BRAIN_API_KEY:-}"
export CLAUDE_CODE_OAUTH_TOKEN="\${BRAIN_OAUTH_TOKEN:-}"
if [ -n "\${BRAIN_CA_CERT_FILE:-}" ]; then
  export NODE_EXTRA_CA_CERTS="\${BRAIN_CA_CERT_FILE}"
fi

exec ${shellQuote(nodeBin)} ${shellQuote(path.join(instance, 'dist', 'main.js'))}
`;
}

function pm2StartBot(bot: string, nodeBin: string, instance: string, logs: string, root: string): void {
  const name = pm2Name(bot);
  pm2Stop(name);

  // Write start script that sources env file at runtime
  const startScript = path.join(instance, 'start.sh');
  fs.writeFileSync(startScript, generateStartScript(root, bot, nodeBin, instance), { mode: 0o755 });

  const outLog = path.join(logs, `${bot}.log`);
  const errLog = path.join(logs, `${bot}.error.log`);

  execFileSync(
    PM2_BIN,
    [
      'start',
      '/bin/bash',
      '--name', name,
      '--cwd', instance,
      '--output', outLog,
      '--error', errLog,
      '--restart-delay', '2000',
      '--max-restarts', '100',
      '--',
      startScript,
    ],
    { stdio: 'inherit' },
  );
}

export function removeStaleProcesses(): void {
  const validNames = new Set(getActiveBots().map(pm2Name));
  validNames.add('infiniclaw-relay');
  try {
    const out = execFileSync(PM2_BIN, ['jlist'], { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' });
    const list = JSON.parse(out) as Array<{ name: string }>;
    for (const proc of list) {
      if (proc.name.startsWith('infiniclaw-') && !validNames.has(proc.name) && !proc.name.includes('-holodeck')) {
        pm2Stop(proc.name);
        console.log(`Removed stale process: ${proc.name}`);
      }
    }
  } catch { /* best effort */ }
}

/**
 * Refresh start script for a bot so a pm2 restart picks up new env vars.
 * Use before self-restart.
 */
export function refreshStartScript(root: string, bot: string): void {
  const instance = instanceDir(root, bot);
  const startScript = path.join(instance, 'start.sh');
  fs.writeFileSync(startScript, generateStartScript(root, bot, process.execPath, instance), { mode: 0o755 });
}

/**
 * Bootstrap a new bot: deploy, start via pm2.
 * Safe to call on an already-running bot (stops first).
 */
export function bootstrapBot(root: string, bot: string): void {
  const allowed = getActiveBots();
  if (!allowed.includes(bot)) {
    throw new Error(`${bot} is not in this machine's machine.json — refusing to start`);
  }

  const instance = instanceDir(root, bot);
  const logs = logDir(root);
  fs.mkdirSync(logs, { recursive: true });

  deployBot(root, bot);
  pm2StartBot(bot, process.execPath, instance, logs, root);
}

/** Stop a bot via pm2. Does not deploy or restart. */
export function stopBot(bot: string): void {
  assertValidBotName(bot);
  pm2Stop(pm2Name(bot));
}

/**
 * Refresh a bot: stop → kill stale containers → redeploy → start.
 * Shared core used by both the relay `!refresh` command and the IPC `refresh_bot` handler.
 */
export function refreshBot(root: string, bot: string): void {
  stopBot(bot);
  killStaleContainers(bot);
  bootstrapBot(root, bot);
}

// ── Relay ────────────────────────────────────────────────────────────

const RELAY_PM2_NAME = 'infiniclaw-relay';

/**
 * Install: build project, start relay via pm2, set up pm2 startup.
 * The relay bootstraps all assigned bots on its own startup.
 */
export async function installRelay(): Promise<void> {
  const root = resolveRoot();
  const logs = logDir(root);
  fs.mkdirSync(logs, { recursive: true });

  // Build
  console.log('Building...');
  const nodeBinDir = path.dirname(process.execPath);
  execSync('npm run build', {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, PATH: `${nodeBinDir}:${process.env.PATH}` },
  });

  // Start relay
  startRelay();

  // Set up pm2 startup + save so relay survives reboots
  try {
    execFileSync(PM2_BIN, ['startup'], { stdio: 'inherit' });
  } catch {
    console.warn('pm2 startup failed — you may need to run it manually with sudo');
  }
  try { execFileSync(PM2_BIN, ['save'], { stdio: 'pipe' }); } catch { /* ok */ }

  console.log('\nRelay installed. It will auto-start bots on startup.');
  console.log('Check status: npx pm2 list');
}

/**
 * Start the relay process via pm2. The relay handles bot startup internally.
 */
export function startRelay(): void {
  const root = resolveRoot();
  const logs = logDir(root);
  fs.mkdirSync(logs, { recursive: true });
  pm2Stop(RELAY_PM2_NAME);

  const distFile = path.join(root, 'dist', 'relay.js');
  if (!fs.existsSync(distFile)) {
    throw new Error('dist/relay.js not found — run `npm run build` first');
  }

  const outLog = path.join(logs, 'relay.log');
  const errLog = path.join(logs, 'relay.error.log');

  execFileSync(
    PM2_BIN,
    [
      'start',
      process.execPath,
      '--name', RELAY_PM2_NAME,
      '--cwd', root,
      '--output', outLog,
      '--error', errLog,
      '--restart-delay', '5000',
      '--max-restarts', '50',
      '--',
      distFile,
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        INFINICLAW_ROOT: root,
        HOME: os.homedir(),
        PATH: `${path.dirname(process.execPath)}:${os.homedir()}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin`,
      },
    },
  );
  console.log('relay: started');
}

/**
 * Stop the relay + all bots.
 */
export function stopRelay(): void {
  const root = resolveRoot();

  // Stop all bots
  for (const bot of getActiveBots()) {
    pm2Stop(pm2Name(bot));
    pm2Stop(pm2Name(holodeckBotName(bot)));
    console.log(`${bot}: stopped`);
  }
  killStaleContainers();
  removeStaleProcesses();

  // Stop relay
  pm2Stop(RELAY_PM2_NAME);
  console.log('relay: stopped');
}

/**
 * Uninstall: stop everything, remove pm2 startup.
 */
export function uninstallRelay(): void {
  stopRelay();
  try {
    execFileSync(PM2_BIN, ['unstartup'], { stdio: 'inherit' });
  } catch {
    console.warn('pm2 unstartup failed — you may need to run it manually');
  }
  console.log('Relay uninstalled.');
}

// ── Holodeck (blue-green test instances) ───────────────────────────────

function holodeckBotName(bot: string): string {
  return `${bot}-holodeck`;
}

export function holodeckCreate(bot: string, branch: string): void {
  assertValidBotName(bot);
  const activeBots = getActiveBots();
  if (!activeBots.includes(bot)) {
    throw new Error(`Unknown bot: ${bot}. Valid: ${activeBots.join(', ')}`);
  }

  const root = resolveRoot();
  const worktree = path.join(root, '_holodeck', bot);
  const hdBot = holodeckBotName(bot);
  const instance = instanceDir(root, hdBot);

  if (fs.existsSync(worktree)) {
    throw new Error(`Holodeck already exists for ${bot}. Run 'holodeck teardown ${bot}' first.`);
  }

  ensurePodmanReady();

  // 1. Create git worktree from branch
  console.log(`Creating worktree for branch '${branch}'...`);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const normalizedBranch = branch.trim();
  if (!normalizedBranch) throw new Error('Branch name is required.');
  execFileSync('git', ['check-ref-format', '--branch', normalizedBranch], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['worktree', 'add', worktree, normalizedBranch], { cwd: root, stdio: 'inherit' });

  // 2. Deploy worktree code to holodeck instance
  fs.mkdirSync(instance, { recursive: true });
  rsyncInstance(worktree, instance);

  // 3. Install deps
  const liveMods = path.join(instanceDir(root, bot), 'node_modules');
  if (fs.existsSync(liveMods) && !fs.existsSync(path.join(instance, 'node_modules'))) {
    // Symlink from live bot to save time (same deps in most cases)
    console.log(`${hdBot}: linking node_modules from live ${bot}...`);
    fs.symlinkSync(liveMods, path.join(instance, 'node_modules'));
  }
  if (!fs.existsSync(path.join(instance, 'node_modules'))) {
    console.log(`${hdBot}: installing dependencies...`);
    execSync('npm ci', { cwd: instance, stdio: 'inherit' });
  }

  // 4. Build
  console.log(`${hdBot}: building...`);
  execSync('npm run build', { cwd: instance, stdio: 'inherit' });

  // 5. Create holodeck profile (clone live bot, force terminal-only)
  const config = loadShipConfig();
  const hdProfileDir = path.join(config.secretsPath, 'bots', hdBot);
  fs.mkdirSync(hdProfileDir, { recursive: true });
  fs.copyFileSync(profileEnvPath(root, bot), profileEnvPath(root, hdBot));
  fs.appendFileSync(profileEnvPath(root, hdBot), [
    '',
    '# Holodeck overrides — terminal only, no Matrix',
    'LOCAL_CHANNEL_ENABLED=1',
    'MATRIX_HOMESERVER=',
    'MATRIX_USERNAME=',
    'MATRIX_PASSWORD=',
    '',
  ].join('\n'));

  // 6. Seed main room registration
  const profileEnv = loadProfileEnv(root, hdBot);
  const mainJid = profileEnv.LOCAL_CHAT_JID || profileEnv.LOCAL_MIRROR_MATRIX_JID;
  const mainGroupName = profileEnv.MAIN_GROUP_NAME;
  const mainGroupFolder = profileEnv.MAIN_GROUP_FOLDER || 'main';

  // 7. Restore persona (from worktree, using live bot's persona name)
  const persona = personaDir(worktree, bot);
  if (fs.existsSync(persona)) {
    const personaClaude = path.join(persona, 'CLAUDE.md');
    if (fs.existsSync(personaClaude)) {
      fs.appendFileSync(
        path.join(instance, 'CLAUDE.md'),
        '\n' + fs.readFileSync(personaClaude, 'utf-8'),
      );
    }
  }
  if (mainJid && mainGroupName) {
    seedMainRoomRegistration(instance, mainJid, mainGroupName, mainGroupFolder, true);
  }

  // 8. Mark instance data as current
  const dataDir = path.join(instance, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'run-id'), `${Date.now()}`);

  // 9. Start via pm2
  const logs = logDir(root);
  fs.mkdirSync(logs, { recursive: true });
  pm2StartBot(hdBot, process.execPath, instance, logs, root);

  console.log(`\nHolodeck started: ${hdBot}`);
  console.log(`  Branch: ${normalizedBranch}`);
  console.log(`  Instance: ${instance}`);
  console.log(`  Chat: npm run cli holodeck chat ${bot}`);
  console.log(`  Logs: tail -f ${logs}/${hdBot}.log`);
  console.log(`  Teardown: npm run cli holodeck teardown ${bot}`);
}

export function holodeckTeardown(bot: string): void {
  assertValidBotName(bot);
  const root = resolveRoot();
  const hdBot = holodeckBotName(bot);
  const worktree = path.join(root, '_holodeck', bot);
  const instance = instanceDir(root, hdBot);
  const hdProfile = path.join(loadShipConfig().secretsPath, 'bots', hdBot);

  // Stop service
  pm2Stop(pm2Name(hdBot));
  console.log(`${hdBot}: stopped`);

  // Kill holodeck containers
  stopContainersByPrefix(`nanoclaw-${hdBot}-`);

  // Remove instance
  if (fs.existsSync(instance)) {
    fs.rmSync(instance, { recursive: true });
    console.log(`Removed instance: ${instance}`);
  }

  // Remove profile
  if (fs.existsSync(hdProfile)) {
    fs.rmSync(hdProfile, { recursive: true });
    console.log(`Removed profile: ${hdProfile}`);
  }

  // Remove worktree
  if (fs.existsSync(worktree)) {
    execFileSync('git', ['worktree', 'remove', worktree, '--force'], { cwd: root, stdio: 'inherit' });
    console.log(`Removed worktree: ${worktree}`);
  }

  console.log(`Holodeck torn down for ${bot}.`);
}

export function holodeckPromote(bot: string): void {
  assertValidBotName(bot);
  const root = resolveRoot();
  const worktree = path.join(root, '_holodeck', bot);
  if (!fs.existsSync(worktree)) {
    throw new Error(`No holodeck found for ${bot}.`);
  }

  // Get branch name from worktree
  const branch = execSync('git branch --show-current', { cwd: worktree, encoding: 'utf-8' }).trim();
  if (!branch) throw new Error('Cannot determine holodeck branch.');

  // Merge into current branch
  console.log(`Merging '${branch}' into current branch...`);
  execFileSync('git', ['merge', branch], { cwd: root, stdio: 'inherit' });

  // Teardown holodeck
  holodeckTeardown(bot);

  // Redeploy live bot
  console.log(`Redeploying ${bot}...`);
  bootstrapBot(root, bot);

  console.log(`\nHolodeck promoted: '${branch}' merged, ${bot} redeployed.`);
}

// ── Utilities ──────────────────────────────────────────────────────────

function filesEqual(a: string, b: string): boolean {
  try {
    const result = spawnSync('diff', ['-q', a, b], { stdio: 'pipe' });
    return result.status === 0;
  } catch {
    return false;
  }
}
