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

const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');

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
  return path.join(root, 'bots', resolveRole(bot), bot);
}

function profileEnvPath(_root: string, bot: string): string {
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
  } catch { /* best effort */ }
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
}

/** Write local presence file and generate crew-status.json from all machines' presence. */
function writeCrewStatus(root: string, thisBot: string, dataDir: string): void {
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
  }

  // Mark CO for each room (lowest rank among present bots)
  for (const members of Object.values(crewByRoom)) {
    members.sort((a, b) => a.rank - b.rank);
    const coBotId = members[0]?.bot;
    if (coBotId) {
      const env = (() => { try { return loadProfileEnv(root, coBotId); } catch { return null; } })();
      const coName = env?.ASSISTANT_NAME || coBotId;
      const entry = crew.find((c) => c.name === coName);
      if (entry) entry.isCommandingOfficer = true;
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
  let mainRequiresTrigger = profileEnv.REQUIRES_TRIGGER === 'true';
  // Commanding officer (lowest rank among active bots on this room) never requires trigger
  if (mainRequiresTrigger && mainGroupName) {
    const roomMap = buildRoomMap(root);
    const co = roomMap[mainGroupName.toLowerCase()];
    if (co && co.bot === bot) {
      mainRequiresTrigger = false;
      console.log(`${bot}: promoted to commanding officer of ${mainGroupName} (trigger disabled)`);
    }
  }
  if (mainJid && mainGroupName) {
    seedMainRoomRegistration(instance, mainJid, mainGroupName, mainGroupFolder, mainRequiresTrigger);
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
  if (currentHash === storedHash) {
    console.log(`${bot}: container image up to date`);
    return;
  }
  console.log(`${bot}: build context changed, rebuilding image...`);
  rebuildImage(root, bot);
  fs.writeFileSync(hashFile, currentHash);
}

// ── Launchd helpers ─────────────────────────────────────────────────────

function plistPath(bot: string): string {
  return path.join(LAUNCH_AGENTS_DIR, `com.infiniclaw.${bot}.plist`);
}

function unloadPlist(plistFile: string): void {
  try { execSync(`launchctl unload "${plistFile}"`, { stdio: 'pipe' }); } catch { /* ok */ }
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

  // 4. Base CLAUDE.md from external/nanoclaw/
  const baseClaude = path.join(externalNanoclawDir(root), 'CLAUDE.md');
  if (fs.existsSync(baseClaude)) fs.copyFileSync(baseClaude, path.join(dst, 'CLAUDE.md'));
}

function buildLaunchdEnv(root: string, bot: string): Record<string, string> {
  const env = applyBrainEnv(loadProfileEnv(root, bot));
  env.PATH = `${os.homedir()}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin`;
  env.HOME = os.homedir();
  env.INFINICLAW_ROOT = root;
  env.PERSONA_NAME = bot;
  return env;
}

/** Generate a shell wrapper that sources the env file at launch time. */
function generateStartScript(root: string, bot: string, nodeBin: string, instance: string): string {
  const config = loadMachineConfig();
  const envFile = path.join(config.secretsPath, bot, 'env');
  return `#!/bin/bash
# Auto-generated by InfiniClaw — DO NOT EDIT
# Sources env from secrets repo so values are never hardcoded in plists.
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

function installPlistAndLoad(bot: string, nodeBin: string, instance: string, logs: string, root: string): void {
  const pp = plistPath(bot);
  unloadPlist(pp);

  // Write start script that sources env file at runtime
  const startScript = path.join(instance, 'start.sh');
  fs.writeFileSync(startScript, generateStartScript(root, bot, nodeBin, instance), { mode: 0o755 });

  const plist = generatePlist(`com.infiniclaw.${bot}`, startScript, instance, logs, bot);
  fs.writeFileSync(pp, plist);
  execSync(`launchctl load "${pp}"`, { stdio: 'inherit' });
}

function removeStalePlists(): void {
  // Remove legacy single-bot plist
  const legacyPlist = path.join(LAUNCH_AGENTS_DIR, 'com.nanoclaw.plist');
  if (fs.existsSync(legacyPlist)) {
    unloadPlist(legacyPlist);
    fs.unlinkSync(legacyPlist);
    console.log('Removed legacy com.nanoclaw.plist');
  }

  // Remove plists for bots no longer in active list (preserve non-bot services)
  const validLabels = new Set(getActiveBots().map((b) => `com.infiniclaw.${b}.plist`));
  validLabels.add('com.infiniclaw.minio.plist');
  try {
    for (const file of fs.readdirSync(LAUNCH_AGENTS_DIR)) {
      if (file.startsWith('com.infiniclaw.') && file.endsWith('.plist') && !validLabels.has(file) && !file.includes('-holodeck')) {
        const pp = path.join(LAUNCH_AGENTS_DIR, file);
        unloadPlist(pp);
        fs.unlinkSync(pp);
        console.log(`Removed stale plist: ${file}`);
      }
    }
  } catch { /* best effort */ }
}

function generatePlist(
  label: string,
  startScript: string,
  instance: string,
  logs: string,
  bot: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${escapeXml(startScript)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(instance)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(logs)}/${bot}.log</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logs)}/${bot}.error.log</string>
</dict>
</plist>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Rewrite the launchd plist and start script for a bot, WITHOUT unloading/loading it.
 * Use before self-restart so the respawned process picks up new env vars.
 */
export function refreshPlist(root: string, bot: string): void {
  const instance = instanceDir(root, bot);
  const logs = logDir(root);
  const pp = plistPath(bot);

  // Regenerate start script with fresh paths
  const startScript = path.join(instance, 'start.sh');
  fs.writeFileSync(startScript, generateStartScript(root, bot, process.execPath, instance), { mode: 0o755 });

  const plist = generatePlist(`com.infiniclaw.${bot}`, startScript, instance, logs, bot);
  fs.writeFileSync(pp, plist);
}

/**
 * Bootstrap a new bot: deploy, create launchd plist, and load it.
 * Safe to call on an already-running bot (unloads first).
 */
export function bootstrapBot(root: string, bot: string): void {
  const instance = instanceDir(root, bot);
  const logs = logDir(root);
  fs.mkdirSync(logs, { recursive: true });

  deployBot(root, bot);
  installPlistAndLoad(bot, process.execPath, instance, logs, root);
}

/** Stop a bot by unloading its launchd plist. Does not deploy or restart. */
export function stopBot(bot: string): void {
  unloadPlist(plistPath(bot));
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
  fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });

  ensurePodmanReady();

  // Pull state from S3 before deploying (warn on failure)
  try { await pullAll(root); } catch (err) {
    console.warn(`S3 pull failed — continuing: ${err instanceof Error ? err.message : err}`);
  }

  // Unload targeted services so old code stops before we build
  for (const bot of bots) { unloadPlist(plistPath(bot)); }
  removeStalePlists();
  killRogueProcesses();
  spawnSync('sleep', ['1']);
  killStaleContainers();

  for (const bot of bots) {
    try {
      const instance = instanceDir(root, bot);
      deployBot(root, bot);
      installPlistAndLoad(bot, process.execPath, instance, logs, root);
      console.log(`${bot}: started (com.infiniclaw.${bot})`);
    } catch (err) {
      console.error(`${bot}: failed to start -`, err);
    }
  }

  console.log('\nInfiniClaw running. Check status:\n  launchctl list | grep infiniclaw');
}

export async function stop(onlyBot?: string): Promise<void> {
  const root = resolveRoot();
  const allBots = getActiveBots();
  const bots = onlyBot ? allBots.filter(b => b === onlyBot) : allBots;

  for (const bot of bots) {
    const pp = plistPath(bot);
    if (fs.existsSync(pp)) {
      try { syncPersona(root, bot); } catch { /* best effort */ }
      unloadPlist(pp);
      fs.unlinkSync(pp);
      console.log(`${bot}: stopped and uninstalled`);
    } else {
      console.log(`${bot}: not installed`);
    }

    // Stop holodeck instance if running
    const hdPp = plistPath(holodeckBotName(bot));
    if (fs.existsSync(hdPp)) {
      unloadPlist(hdPp);
      fs.unlinkSync(hdPp);
      console.log(`${holodeckBotName(bot)}: stopped (holodeck)`);
    }
  }

  removeStalePlists();
  if (!onlyBot) killRogueProcesses();
  killStaleContainers(onlyBot);

  // Push state to S3 after stopping (warn on failure)
  try { await pushAll(root); } catch (err) {
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
      const srcFiles = execSync(`find "${instance}/src" -name '*.ts' -newer "${distMain}"`, {
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

/** Build room map dynamically from ALL bots' env files (fleet-wide).
 *  When multiple bots share a room, the highest-ranking (lowest rank number)
 *  bot is chosen — the commanding officer for that room.
 *  Uses the roster (not just local machine.json bots) so the CO election
 *  is consistent across machines. */
function buildRoomMap(root: string): Record<string, { bot: string; roomId: string; jid: string }> {
  const config = loadMachineConfig();
  let roster: Record<string, { rank?: number }> = {};
  try {
    roster = JSON.parse(fs.readFileSync(path.join(config.secretsPath, 'roster.json'), 'utf-8'));
  } catch { /* no roster — all bots equal */ }

  // Consider all bots in the roster, not just local ones
  const allBots = Object.keys(roster).length > 0 ? Object.keys(roster) : getActiveBots();

  const map: Record<string, { bot: string; roomId: string; jid: string; rank: number }> = {};
  for (const bot of allBots) {
    try {
      const env = loadProfileEnv(root, bot);
      const groupName = env.MAIN_GROUP_NAME;
      const jid = env.LOCAL_MIRROR_MATRIX_JID;
      if (!groupName || !jid) continue;
      const roomId = jid.replace(/^matrix:/, '');
      const rank = roster[bot]?.rank ?? 99;
      const key = groupName.toLowerCase();
      if (!map[key] || rank < map[key].rank) {
        map[key] = { bot, roomId, jid, rank };
      }
    } catch {
      // Skip bots with missing/broken env
    }
  }
  // Strip rank from return type
  const result: Record<string, { bot: string; roomId: string; jid: string }> = {};
  for (const [k, v] of Object.entries(map)) {
    result[k] = { bot: v.bot, roomId: v.roomId, jid: v.jid };
  }
  return result;
}

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
  execSync(`git worktree add "${worktree}" "${branch}"`, { cwd: root, stdio: 'inherit' });

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
  const hdRequiresTrigger = profileEnv.REQUIRES_TRIGGER === 'true';
  if (mainJid && mainGroupName) {
    seedMainRoomRegistration(instance, mainJid, mainGroupName, mainGroupFolder, hdRequiresTrigger);
  }

  // 8. Mark instance data as current
  const dataDir = path.join(instance, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'run-id'), `${Date.now()}`);

  // 9. Start launchd service
  const logs = logDir(root);
  fs.mkdirSync(logs, { recursive: true });
  installPlistAndLoad(hdBot, process.execPath, instance, logs, root);

  console.log(`\nHolodeck started: ${hdBot}`);
  console.log(`  Branch: ${branch}`);
  console.log(`  Instance: ${instance}`);
  console.log(`  Chat: npm run cli holodeck chat ${bot}`);
  console.log(`  Logs: tail -f ${logs}/${hdBot}.log`);
  console.log(`  Teardown: npm run cli holodeck teardown ${bot}`);
}

export function holodeckChat(bot: string): void {
  chat(holodeckBotName(bot));
}

export function holodeckTeardown(bot: string): void {
  const root = resolveRoot();
  const hdBot = holodeckBotName(bot);
  const worktree = path.join(root, '_holodeck', bot);
  const instance = instanceDir(root, hdBot);
  const hdProfile = path.join(loadMachineConfig().secretsPath, hdBot);

  // Stop service
  const pp = plistPath(hdBot);
  if (fs.existsSync(pp)) {
    unloadPlist(pp);
    fs.unlinkSync(pp);
    console.log(`${hdBot}: stopped`);
  }

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
    execSync(`git worktree remove "${worktree}" --force`, { cwd: root, stdio: 'inherit' });
    console.log(`Removed worktree: ${worktree}`);
  }

  console.log(`Holodeck torn down for ${bot}.`);
}

export function holodeckPromote(bot: string): void {
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
  execSync(`git merge "${branch}"`, { cwd: root, stdio: 'inherit' });

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
