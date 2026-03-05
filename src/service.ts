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

import { parseEnvFile } from 'nanoclaw/env-utils.js';
import { recoverPodman, stopContainersByPrefix } from 'nanoclaw/podman-utils.js';

import { loadMachineConfig } from './machine-config.js';
import { pullAll, pushAll } from './s3-sync.js';

// ── Constants ──────────────────────────────────────────────────────────

// pm2 binary resolved from project node_modules
const PM2_BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'node_modules', '.bin', 'pm2');

export function getActiveBots(): string[] {
  return loadMachineConfig().bots;
}

const RSYNC_EXCLUDES = [
  'node_modules',
  'data',
  'store',
  'logs',
  '.env.local',
];

const BOT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertValidBotName(bot: string): void {
  if (!BOT_NAME_PATTERN.test(bot) || bot.includes('..')) {
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
  const config = loadMachineConfig();
  try {
    const roster = JSON.parse(fs.readFileSync(path.join(config.secretsPath, 'roster.json'), 'utf-8'));
    return (roster[bot]?.role || '').toLowerCase();
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
  const config = loadMachineConfig();
  return path.join(config.secretsPath, bot, 'env');
}

/** Seed the registered_groups table with the main room from profile env. */
function seedMainRoomRegistration(instanceBase: string, mainJid: string, mainGroupName: string, mainGroupFolder: string, requiresTrigger: boolean): void {
  const storeDir = path.join(instanceBase, 'store');
  fs.mkdirSync(storeDir, { recursive: true });
  const seedDb = new Database(path.join(storeDir, 'messages.db'));
  seedDb.exec(`CREATE TABLE IF NOT EXISTS registered_groups (
    jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
    trigger_pattern TEXT NOT NULL, added_at TEXT NOT NULL,
    container_config TEXT, requires_trigger INTEGER DEFAULT 1
  )`);
  seedDb.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(mainJid, mainGroupName, mainGroupFolder, '', new Date().toISOString(), requiresTrigger ? 1 : 0);
  seedDb.close();
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
  const config = loadMachineConfig();
  const ids = new Set<string>();
  try {
    for (const bot of fs.readdirSync(config.secretsPath)) {
      const envFile = path.join(config.secretsPath, bot, 'env');
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

// ── Persona sync ───────────────────────────────────────────────────────

/**
 * Sync persona state before redeploy.
 * Persona CLAUDE.md is edited directly by bots via writable mount — no copy needed.
 * Group CLAUDE.md is ONE-WAY (repo → instance) — no save-back.
 * MCP servers are ONE-WAY (persona → session) — no save-back.
 */
export function syncPersona(root: string, bot: string): void {
  const instance = instanceDir(root, bot);
  const persona = personaDir(root, bot);
  if (!fs.existsSync(persona)) return;

  // Guard: only sync if instance data belongs to a recent run
  const runIdPath = path.join(instance, 'data', 'run-id');
  if (!fs.existsSync(runIdPath)) {
    console.log(`${bot}: skipping syncPersona (no run-id, instance data may be stale)`);
    return;
  }
  try {
    const ageMs = Date.now() - fs.statSync(runIdPath).mtimeMs;
    if (ageMs > 24 * 60 * 60 * 1000) {
      console.log(`${bot}: skipping syncPersona (run-id is ${Math.round(ageMs / 3600000)}h old)`);
      return;
    }
  } catch { return; }

  // TODO: Implement any required pre-deploy persona sync work here.
  // Current architecture is one-way (repo/persona -> instance), so this is intentionally a no-op.
}

/** Update the local presence file to reflect currently running bots. */
export function updatePresence(root: string): void {
  const config = loadMachineConfig();
  const hostname = os.hostname();
  const presenceDir = path.join(config.secretsPath, 'operator', 'presence');
  fs.mkdirSync(presenceDir, { recursive: true });
  const localPresence = { hostname, bots: getActiveBots(), updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(presenceDir, `${hostname}.json`), JSON.stringify(localPresence, null, 2));
}

/** Write local presence file and generate crew-status.json from all machines' presence. */
export function writeCrewStatus(root: string, thisBot: string, dataDir: string): void {
  const config = loadMachineConfig();
  const hostname = os.hostname();

  // Write this machine's presence
  const presenceDir = path.join(config.secretsPath, 'operator', 'presence');
  fs.mkdirSync(presenceDir, { recursive: true });
  const localPresence = { hostname, bots: getActiveBots(), updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(presenceDir, `${hostname}.json`), JSON.stringify(localPresence, null, 2));

  // Read all machines' presence to build fleet-wide active set
  const allPresent = new Set<string>();
  try {
    for (const file of fs.readdirSync(presenceDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(presenceDir, file), 'utf-8'));
        for (const bot of p.bots || []) allPresent.add(bot);
      } catch { /* skip corrupt files */ }
    }
  } catch { /* no presence dir */ }

  let roster: Record<string, { role?: string; rank?: number; title?: string }> = {};
  try {
    roster = JSON.parse(fs.readFileSync(path.join(config.secretsPath, 'roster.json'), 'utf-8'));
  } catch { /* no roster */ }

  // Build room map from ALL present bots (not just this machine)
  // For CO determination, we need to consider the full fleet
  const crewByRoom: Record<string, { bot: string; rank: number }[]> = {};
  const crew: {
    name: string;
    role: string;
    rank: number;
    title?: string;
    room: string;
    present: boolean;
    isCommandingOfficer: boolean;
  }[] = [];
  const crewIndexByBotId = new Map<string, number>();

  for (const [botId, info] of Object.entries(roster)) {
    const env = (() => { try { return loadProfileEnv(root, botId); } catch { return null; } })();
    const room = env?.MAIN_GROUP_NAME || 'unknown';
    const rank = info.rank ?? 99;
    const present = allPresent.has(botId);

    if (present) {
      const key = room.toLowerCase();
      if (!crewByRoom[key]) crewByRoom[key] = [];
      crewByRoom[key].push({ bot: botId, rank });
    }

    crew.push({
      name: env?.ASSISTANT_NAME || botId,
      role: info.role || 'unknown',
      rank,
      title: info.title,
      room,
      present,
      isCommandingOfficer: false, // set below
    });
    crewIndexByBotId.set(botId, crew.length - 1);
  }

  // Mark CO for each room (lowest rank among present bots)
  for (const members of Object.values(crewByRoom)) {
    members.sort((a, b) => a.rank - b.rank);
    const coBotId = members[0]?.bot;
    if (coBotId) {
      const idx = crewIndexByBotId.get(coBotId);
      if (idx !== undefined) crew[idx].isCommandingOfficer = true;
    }
  }

  crew.sort((a, b) => a.rank - b.rank);

  fs.writeFileSync(path.join(dataDir, 'crew-status.json'), JSON.stringify({
    thisBot,
    generatedAt: new Date().toISOString(),
    crew,
  }, null, 2));
}

export function restorePersona(root: string, bot: string): void {
  const instance = instanceDir(root, bot);
  const persona = personaDir(root, bot);
  if (!fs.existsSync(persona)) return;

  // Append persona CLAUDE.md to base CLAUDE.md
  const personaClaude = path.join(persona, 'CLAUDE.md');
  if (fs.existsSync(personaClaude)) {
    const content = fs.readFileSync(personaClaude, 'utf-8');
    fs.appendFileSync(path.join(instance, 'CLAUDE.md'), '\n' + content);
  }
  // ROOM.md is mounted directly at /workspace/CLAUDE.md by container-mounts.ts
}

// ── Deploy ─────────────────────────────────────────────────────────────

/**
 * Full deploy: syncPersona → rsync → npm ci if needed → build → restorePersona.
 */
export function deployBot(root: string, bot: string): void {
  const instance = instanceDir(root, bot);
  fs.mkdirSync(instance, { recursive: true });

  rebuildImageIfChanged(root, bot);
  syncPersona(root, bot);
  rsyncInstance(root, instance);
  stampGitVersion(root, instance);

  // Install deps if lockfile differs
  const lockSrc = path.join(root, 'package-lock.json');
  const lockDst = path.join(instance, 'node_modules', '.package-lock.json');
  if (!fs.existsSync(path.join(instance, 'node_modules')) || !filesEqual(lockSrc, lockDst)) {
    console.log(`${bot}: installing dependencies...`);
    execSync('npm ci', { cwd: instance, stdio: 'inherit' });
    try { fs.copyFileSync(path.join(instance, 'package-lock.json'), lockDst); } catch { /* ok */ }
  }

  // Build TypeScript
  console.log(`${bot}: building...`);
  execSync('npm run build', { cwd: instance, stdio: 'inherit' });

  // Pre-register main room from profile env
  const profileEnv = loadProfileEnv(root, bot);
  const mainJid = profileEnv.LOCAL_MIRROR_MATRIX_JID;
  const mainGroupName = profileEnv.MAIN_GROUP_NAME;
  const mainGroupFolder = profileEnv.MAIN_GROUP_FOLDER || 'main';

  restorePersona(root, bot);
  if (mainJid && mainGroupName) {
    seedMainRoomRegistration(instance, mainJid, mainGroupName, mainGroupFolder, true);
    console.log(`${bot}: pre-registered ${mainGroupName} (${mainGroupFolder})`);
  }

  // Write crew status so container tools can report roster
  const dataDir = path.join(instance, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  writeCrewStatus(root, bot, dataDir);

  // Mark instance as fresh so syncPersona knows data is current
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

export function rebuildImage(root: string, bot: string): void {
  const script = path.join(root, 'bots', 'container', 'build.sh');
  execFileSync(script, [bot], { stdio: 'inherit' });
}

/** Hash all files that contribute to a bot's container image. */
function computeBuildContextHash(root: string, bot: string): string {
  const hash = crypto.createHash('sha256');
  // Bot-specific Dockerfile
  const dockerfile = path.join(root, 'bots', 'container', bot, 'Dockerfile');
  if (fs.existsSync(dockerfile)) hash.update(fs.readFileSync(dockerfile));
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

  // 3. Root config files
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
  const config = loadMachineConfig();
  const envFile = path.join(config.secretsPath, bot, 'env');
  return `#!/bin/bash
# Auto-generated by InfiniClaw — DO NOT EDIT
# Sources env from secrets repo so values are never hardcoded.
set -a
source "${envFile}"
set +a

# Computed vars
export PERSONA_NAME="${bot}"
export INFINICLAW_ROOT="${root}"
export PATH="${os.homedir()}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin"
export HOME="${os.homedir()}"

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

exec "${nodeBin}" "${instance}/dist/main.js"
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
  validNames.add('infiniclaw-supervisor');
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
  pm2Stop(pm2Name(bot));
}

// ── Supervisor ──────────────────────────────────────────────────────

const SUPERVISOR_PM2_NAME = 'infiniclaw-supervisor';

export function startSupervisor(root: string): void {
  const logs = logDir(root);
  fs.mkdirSync(logs, { recursive: true });
  pm2Stop(SUPERVISOR_PM2_NAME);

  // The supervisor runs from the same instance as the first active bot
  // (it only needs compiled dist/supervisor.js + node_modules).
  const bots = getActiveBots();
  if (bots.length === 0) {
    console.log('supervisor: no active bots — skipping');
    return;
  }
  const instance = instanceDir(root, bots[0]);
  const distFile = path.join(instance, 'dist', 'supervisor.js');
  if (!fs.existsSync(distFile)) {
    console.log('supervisor: dist/supervisor.js not found — skipping (build first)');
    return;
  }

  const outLog = path.join(logs, 'supervisor.log');
  const errLog = path.join(logs, 'supervisor.error.log');

  execFileSync(
    PM2_BIN,
    [
      'start',
      process.execPath,
      '--name', SUPERVISOR_PM2_NAME,
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
        PATH: `${os.homedir()}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin`,
      },
    },
  );
  console.log('supervisor: started');
}

export function stopSupervisor(): void {
  pm2Stop(SUPERVISOR_PM2_NAME);
  console.log('supervisor: stopped');
}

// ── Top-level commands ─────────────────────────────────────────────────

export async function start(onlyBot?: string): Promise<void> {
  const root = resolveRoot();
  const allBots = getActiveBots();
  const bots = onlyBot ? allBots.filter(b => b === onlyBot) : allBots;
  if (onlyBot && bots.length === 0) {
    throw new Error(`Bot "${onlyBot}" not found in machine.json (active: ${allBots.join(', ')})`);
  }
  const logs = logDir(root);
  fs.mkdirSync(logs, { recursive: true });

  ensurePodmanReady();

  // S3 is backup-only. Pull is manual (`cli sync pull`) for bot transport.
  // Push happens automatically on stop.

  // Stop targeted services so old code stops before we build
  for (const bot of bots) { pm2Stop(pm2Name(bot)); }
  removeStaleProcesses();
  killRogueProcesses();
  spawnSync('sleep', ['1']);
  killStaleContainers(onlyBot);

  for (const bot of bots) {
    try {
      const instance = instanceDir(root, bot);
      deployBot(root, bot);
      pm2StartBot(bot, process.execPath, instance, logs, root);
      console.log(`${bot}: started (${pm2Name(bot)})`);
    } catch (err) {
      console.error(`${bot}: failed to start -`, err);
    }
  }

  // Start supervisor (watches Matrix for !join/!dismiss/!restart)
  startSupervisor(root);

  // Save pm2 process list so `pm2 resurrect` can restore after reboot
  try { execFileSync(PM2_BIN, ['save'], { stdio: 'pipe' }); } catch { /* ok */ }

  console.log('\nInfiniClaw running. Check status:\n  npx pm2 list');
}

export async function stop(onlyBot?: string): Promise<void> {
  const root = resolveRoot();
  const allBots = getActiveBots();
  const bots = onlyBot ? allBots.filter(b => b === onlyBot) : allBots;

  for (const bot of bots) {
    try { syncPersona(root, bot); } catch { /* best effort */ }
    pm2Stop(pm2Name(bot));
    console.log(`${bot}: stopped`);

    // Stop holodeck instance if running
    pm2Stop(pm2Name(holodeckBotName(bot)));
  }

  removeStaleProcesses();
  if (!onlyBot) {
    killRogueProcesses();
    stopSupervisor();
  }
  killStaleContainers(onlyBot);

  // Push state to S3 before returning so data is not lost on exit.
  // Timeout after 30s to avoid hanging on network issues.
  try {
    const pushPromise = pushAll(root);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('S3 push timed out after 30s')), 30_000),
    );
    await Promise.race([pushPromise, timeout]);
    console.log('S3 backup complete.');
  } catch (err) {
    console.warn(`S3 push failed: ${err instanceof Error ? err.message : err}`);
  }

  console.log('InfiniClaw stopped.');
}

export async function sync(direction: 'push' | 'pull'): Promise<void> {
  const root = resolveRoot();
  if (direction === 'push') {
    await pushAll(root);
  } else {
    await pullAll(root);
  }
}

export function chat(bot: string): void {
  const root = resolveRoot();
  const instance = instanceDir(root, bot);

  if (!fs.existsSync(instance)) {
    throw new Error(`Missing instance for ${bot}. Run 'start' first.`);
  }

  rsyncInstance(root, instance);

  // Build if needed
  const distMain = path.join(instance, 'dist', 'main.js');
  let needsBuild = !fs.existsSync(distMain);
  if (!needsBuild) {
    try {
      const srcFiles = execFileSync('find', [path.join(instance, 'src'), '-name', '*.ts', '-newer', distMain], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      needsBuild = srcFiles.length > 0;
    } catch {
      needsBuild = true;
    }
  }
  if (needsBuild) {
    console.log('Building TypeScript...');
    execSync('npm run build', { cwd: instance, stdio: 'inherit' });
  }

  const profileEnv = loadProfileEnv(root, bot);
  const env = applyBrainEnv(profileEnv);

  ensurePodmanReady();

  // Build the full env for the child process
  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...env,
    INFINICLAW_ROOT: root,
    PERSONA_NAME: bot,
    LOCAL_CHANNEL_ENABLED: '1',
    LOCAL_CHAT_JID: env.LOCAL_MIRROR_MATRIX_JID || 'local:terminal',
    LOCAL_CHAT_NAME: `${bot} (Terminal)`,
  };

  // exec into node (replaces this process)
  const result = spawnSync('node', ['dist/main.js'], {
    cwd: instance,
    env: childEnv,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

// ── Send (operator message to bot room) ─────────────────────────────

export async function send(room: string, message: string): Promise<void> {
  const root = resolveRoot();
  const config = loadMachineConfig();
  const localBots = config.bots;

  // Find the room's Matrix room ID and homeserver from any local bot's config
  let roomId: string | undefined;
  let homeserver: string | undefined;
  for (const bot of localBots) {
    try {
      const env = loadProfileEnv(root, bot);
      if (env.MAIN_GROUP_NAME?.toLowerCase() === room.toLowerCase()) {
        const jid = env.LOCAL_MIRROR_MATRIX_JID;
        roomId = jid?.replace(/^matrix:/, '');
        homeserver = env.MATRIX_HOMESERVER;
        if (roomId) break;
      }
    } catch { /* skip */ }
  }
  if (!roomId) {
    throw new Error(`Unknown room: ${room}. No local bot has MAIN_GROUP_NAME matching it.`);
  }

  // Find a local bot that's in this room and has a valid Matrix access token
  let accessToken: string | undefined;
  let senderBot: string | undefined;
  for (const bot of localBots) {
    try {
      const env = loadProfileEnv(root, bot);
      const botJid = env.LOCAL_MIRROR_MATRIX_JID?.replace(/^matrix:/, '');
      if (botJid !== roomId) continue;
      const inst = instanceDir(root, bot);
      const storageFile = path.join(inst, 'store', 'matrix-bot.json');
      if (fs.existsSync(storageFile)) {
        const storage = JSON.parse(fs.readFileSync(storageFile, 'utf-8'));
        const token = storage.kvStore?.matrix_access_token;
        if (token) {
          accessToken = token;
          senderBot = bot;
          if (env.MATRIX_HOMESERVER) homeserver = env.MATRIX_HOMESERVER;
          break;
        }
      }
    } catch { /* skip */ }
  }
  if (!accessToken || !senderBot || !homeserver) {
    throw new Error('No local bot with a stored Matrix access token. Run \'start\' first.');
  }

  // Send to Matrix — bots pick it up via room sync
  const txnId = `op-${Date.now()}`;
  const url = `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      msgtype: 'm.text',
      body: `[Operator]: ${message}`,
      format: 'org.matrix.custom.html',
      formatted_body: `<details><summary>📞 Operator</summary>${message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</details>`,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Matrix send failed (${resp.status}): ${body}`);
  }
  console.log(`Sent to ${room} (via ${senderBot})`);
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
  const config = loadMachineConfig();
  const hdProfileDir = path.join(config.secretsPath, hdBot);
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

export function holodeckChat(bot: string): void {
  chat(holodeckBotName(bot));
}

export function holodeckTeardown(bot: string): void {
  assertValidBotName(bot);
  const root = resolveRoot();
  const hdBot = holodeckBotName(bot);
  const worktree = path.join(root, '_holodeck', bot);
  const instance = instanceDir(root, hdBot);
  const hdProfile = path.join(loadMachineConfig().secretsPath, hdBot);

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
