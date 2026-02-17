/**
 * Service module: all start/stop/chat/deploy logic.
 * Replaces scripts/start, scripts/stop, scripts/chat, scripts/common.sh, scripts/validate-deploy.sh.
 * All operations are synchronous (CLI tool, not async server).
 */
import { execFileSync, execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { saveSkillsToPersona } from './skill-sync.js';

// ── Constants ──────────────────────────────────────────────────────────

export const BOTS = ['engineer', 'commander'] as const;
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');

const RSYNC_EXCLUDES = [
  'node_modules',
  'data',
  'store',
  'groups',
  'logs',
  '.env.local',
];

// ── Path helpers ───────────────────────────────────────────────────────

export function resolveRoot(): string {
  const explicit = process.env.INFINICLAW_ROOT?.trim();
  if (explicit) return explicit;
  // Walk up from cwd looking for bots/ directory
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'bots')) && fs.existsSync(path.join(dir, 'nanoclaw'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('Cannot resolve InfiniClaw root. Set INFINICLAW_ROOT or run from project directory.');
}

function baseNanoclawDir(root: string): string {
  return path.join(root, 'nanoclaw');
}

export function instanceDir(root: string, bot: string): string {
  return path.join(root, '_runtime', 'instances', bot, 'nanoclaw');
}

function logDir(root: string): string {
  return path.join(root, '_runtime', 'logs');
}

function personaDir(root: string, bot: string): string {
  return path.join(root, 'bots', 'personas', bot);
}

function profileEnvPath(root: string, bot: string): string {
  return path.join(root, 'bots', 'profiles', bot, 'env');
}

// ── Env loading ────────────────────────────────────────────────────────

export function loadProfileEnv(root: string, bot: string): Record<string, string> {
  const envFile = profileEnvPath(root, bot);
  if (!fs.existsSync(envFile)) {
    throw new Error(`Missing profile env: ${envFile}\nCopy from: ${envFile}.example`);
  }
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function applyBrainEnv(env: Record<string, string>): Record<string, string> {
  const out = { ...env };

  // Explicitly set all mapped vars (even to empty string) to override any launchd global env
  out.ANTHROPIC_MODEL = out.BRAIN_MODEL || '';
  out.ANTHROPIC_SMALL_FAST_MODEL = out.BRAIN_MODEL || '';
  out.ANTHROPIC_DEFAULT_SONNET_MODEL = out.BRAIN_MODEL || '';
  out.ANTHROPIC_BASE_URL = out.BRAIN_BASE_URL || '';
  out.ANTHROPIC_AUTH_TOKEN = out.BRAIN_AUTH_TOKEN || '';
  out.ANTHROPIC_API_KEY = out.BRAIN_API_KEY || '';
  out.CLAUDE_CODE_OAUTH_TOKEN = out.BRAIN_OAUTH_TOKEN || '';

  // Local fallback: if no explicit profile OAuth token, pull from macOS keychain
  if (!out.CLAUDE_CODE_OAUTH_TOKEN) {
    out.CLAUDE_CODE_OAUTH_TOKEN = resolveOAuthToken();
  }

  return out;
}

function resolveOAuthToken(): string {
  try {
    const credJson = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    ).trim();
    if (!credJson) return '';
    const parsed = JSON.parse(credJson);
    return parsed?.claudeAiOauth?.accessToken || '';
  } catch {
    return '';
  }
}

// ── Podman ─────────────────────────────────────────────────────────────

export function ensurePodmanReady(): void {
  try {
    execSync('podman info', { stdio: 'pipe' });
    return;
  } catch {
    // fall through to recovery
  }

  console.log('Podman API unavailable, attempting recovery...');
  try { execSync('podman machine stop podman-machine-default', { stdio: 'pipe', timeout: 30_000 }); } catch { /* best effort */ }
  try { execSync('podman machine start podman-machine-default', { stdio: 'pipe', timeout: 180_000 }); } catch { /* best effort */ }

  for (let i = 0; i < 10; i++) {
    try {
      execSync('podman info', { stdio: 'pipe' });
      return;
    } catch {
      spawnSync('sleep', ['1']);
    }
  }

  throw new Error(
    'Podman API unavailable after recovery attempt.\n' +
    'Try: podman machine stop podman-machine-default && podman machine start podman-machine-default',
  );
}

export function killStaleContainers(): void {
  try {
    const output = execSync("podman ps --format '{{.Names}}'", {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    for (const name of output.split('\n').filter((n) => n.startsWith('nanoclaw-'))) {
      console.log(`Stopping stale container: ${name}`);
      try { execSync(`podman stop -t 5 "${name}"`, { stdio: 'pipe' }); } catch { /* best effort */ }
    }
  } catch {
    // podman not available or no containers
  }
}

// ── Process cleanup ────────────────────────────────────────────────────

export function killRogueProcesses(): void {
  try {
    const output = execSync("pgrep -f 'nanoclaw.*dist/index\\.js'", {
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
 * Save runtime group .md files + skills from instance → personas/ dir.
 * Consolidates common.sh sync_persona + index.ts syncPersonas.
 */
export function syncPersona(root: string, bot: string): void {
  const instance = instanceDir(root, bot);
  const persona = personaDir(root, bot);
  if (!fs.existsSync(persona)) return;

  // SAVE: capture runtime group changes from instance → personas
  const instanceGroups = path.join(instance, 'groups');
  if (fs.existsSync(instanceGroups)) {
    for (const gname of fs.readdirSync(instanceGroups)) {
      const gdir = path.join(instanceGroups, gname);
      if (!fs.statSync(gdir).isDirectory()) continue;
      for (const file of fs.readdirSync(gdir)) {
        if (!file.endsWith('.md')) continue;
        const dst = path.join(persona, 'groups', gname);
        fs.mkdirSync(dst, { recursive: true });
        fs.copyFileSync(path.join(gdir, file), path.join(dst, file));
      }
    }
  }

  // SAVE: replace persona skills with session .claude/skills/ (authoritative)
  const sessionsBase = path.join(instance, 'data', 'sessions');
  if (fs.existsSync(sessionsBase)) {
    const sharedSkillsSrc = path.join(instance, 'container', 'skills');
    for (const folder of fs.readdirSync(sessionsBase)) {
      const skillsDir = path.join(sessionsBase, folder, '.claude', 'skills');
      if (!fs.existsSync(skillsDir)) continue;
      saveSkillsToPersona(skillsDir, path.join(persona, 'skills'), sharedSkillsSrc);
      break; // Only need one session (main)
    }
  }
}

/**
 * Append persona CLAUDE.md to instance base CLAUDE.md and seed group files.
 */
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

  // RESTORE: seed group files from personas → instance groups
  const personaGroups = path.join(persona, 'groups');
  if (fs.existsSync(personaGroups)) {
    for (const gname of fs.readdirSync(personaGroups)) {
      const gdir = path.join(personaGroups, gname);
      if (!fs.statSync(gdir).isDirectory()) continue;
      const dst = path.join(instance, 'groups', gname);
      fs.mkdirSync(dst, { recursive: true });
      for (const file of fs.readdirSync(gdir)) {
        if (!file.endsWith('.md')) continue;
        fs.copyFileSync(path.join(gdir, file), path.join(dst, file));
      }
    }
  }
}

// ── Deploy ─────────────────────────────────────────────────────────────

/**
 * Full deploy: syncPersona → rsync → npm ci if needed → build → restorePersona.
 */
export function deployBot(root: string, bot: string): void {
  const instance = instanceDir(root, bot);
  const base = baseNanoclawDir(root);
  fs.mkdirSync(instance, { recursive: true });

  syncPersona(root, bot);

  // Rsync vendored code to instance
  const excludeArgs = RSYNC_EXCLUDES.flatMap((e) => ['--exclude', e]);
  execFileSync('rsync', ['-a', '--delete', ...excludeArgs, `${base}/`, `${instance}/`], {
    stdio: 'inherit',
  });

  // Install deps if lockfile differs
  const lockSrc = path.join(base, 'package-lock.json');
  const lockDst = path.join(instance, 'node_modules', '.package-lock.json');
  if (!fs.existsSync(path.join(instance, 'node_modules')) || !filesEqual(lockSrc, lockDst)) {
    console.log(`${bot}: installing dependencies...`);
    execSync('npm ci', { cwd: instance, stdio: 'inherit' });
    try { fs.copyFileSync(path.join(instance, 'package-lock.json'), lockDst); } catch { /* ok */ }
  }

  // Build TypeScript
  console.log(`${bot}: building...`);
  execSync('npm run build', { cwd: instance, stdio: 'inherit' });

  restorePersona(root, bot);
}

/**
 * Validate code compiles before allowing a restart.
 * Syncs to staging dir, symlinks node_modules, runs tsc --noEmit.
 */
export function validateDeploy(root: string, bot: string): { ok: boolean; errors: string } {
  const instance = instanceDir(root, bot);
  const base = baseNanoclawDir(root);
  const staging = path.join(root, '_runtime', 'staging', bot, 'nanoclaw');
  fs.mkdirSync(staging, { recursive: true });

  const excludeArgs = RSYNC_EXCLUDES.flatMap((e) => ['--exclude', e]);
  execFileSync('rsync', ['-a', '--delete', ...excludeArgs, `${base}/`, `${staging}/`], {
    stdio: 'pipe',
  });

  // Symlink node_modules from live instance
  const instanceModules = path.join(instance, 'node_modules');
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

// ── Launchd plist ──────────────────────────────────────────────────────

function generatePlist(
  label: string,
  nodeBin: string,
  instance: string,
  logs: string,
  bot: string,
  env: Record<string, string>,
): string {
  const envEntries = Object.entries(env)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `        <key>${escapeXml(k)}</key>\n        <string>${escapeXml(v)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(nodeBin)}</string>
        <string>${escapeXml(instance)}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(instance)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
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

export function installAllowlist(root: string): void {
  const dir = path.join(os.homedir(), '.config', 'nanoclaw');
  const file = path.join(dir, 'mount-allowlist.json');
  if (fs.existsSync(file)) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(root, 'bots', 'config', 'mount-allowlist.json'), file);
  console.log(`Installed mount allowlist: ${file}`);
}

// ── Top-level commands ─────────────────────────────────────────────────

export function start(): void {
  const root = resolveRoot();
  const nodeBin = process.execPath;
  const logs = logDir(root);
  fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });

  ensurePodmanReady();
  installAllowlist(root);

  // Unload all services first so old code stops before we build
  for (const bot of BOTS) {
    const label = `com.infiniclaw.${bot}`;
    const plistPath = path.join(LAUNCH_AGENTS_DIR, `${label}.plist`);
    try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' }); } catch { /* ok */ }
  }

  // Remove legacy single-bot plist
  const legacyPlist = path.join(LAUNCH_AGENTS_DIR, 'com.nanoclaw.plist');
  if (fs.existsSync(legacyPlist)) {
    try { execSync(`launchctl unload "${legacyPlist}"`, { stdio: 'pipe' }); } catch { /* ok */ }
    fs.unlinkSync(legacyPlist);
    console.log('Removed legacy com.nanoclaw.plist');
  }

  killRogueProcesses();
  spawnSync('sleep', ['1']);
  killStaleContainers();

  // Rebuild container images
  console.log('Rebuilding container images...');
  rebuildImage(root, 'all');

  for (const bot of BOTS) {
    try {
      const instance = instanceDir(root, bot);

      deployBot(root, bot);

      const profileEnv = loadProfileEnv(root, bot);
      const env = applyBrainEnv(profileEnv);

      // Add static vars
      env.PATH = `${os.homedir()}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin`;
      env.HOME = os.homedir();
      env.INFINICLAW_ROOT = root;
      env.PERSONA_NAME = bot;

      const label = `com.infiniclaw.${bot}`;
      const plistPath = path.join(LAUNCH_AGENTS_DIR, `${label}.plist`);

      // Unload if already loaded
      try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' }); } catch { /* ok */ }

      const plist = generatePlist(label, nodeBin, instance, logs, bot, env);
      fs.writeFileSync(plistPath, plist);

      execSync(`launchctl load "${plistPath}"`, { stdio: 'inherit' });
      console.log(`${bot}: started (${label})`);
    } catch (err) {
      console.error(`${bot}: failed to start -`, err);
    }
  }

  console.log('\nInfiniClaw running. Check status:\n  launchctl list | grep infiniclaw');
}

export function stop(): void {
  const root = resolveRoot();

  // Save persona group memory before stopping
  for (const bot of BOTS) {
    try { syncPersona(root, bot); } catch { /* best effort */ }
  }

  for (const bot of BOTS) {
    const label = `com.infiniclaw.${bot}`;
    const plistPath = path.join(LAUNCH_AGENTS_DIR, `${label}.plist`);
    if (fs.existsSync(plistPath)) {
      try { execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' }); } catch { /* ok */ }
      fs.unlinkSync(plistPath);
      console.log(`${bot}: stopped and uninstalled`);
    } else {
      console.log(`${bot}: not installed`);
    }
  }

  // Remove legacy single-bot plist
  const legacyPlist = path.join(LAUNCH_AGENTS_DIR, 'com.nanoclaw.plist');
  if (fs.existsSync(legacyPlist)) {
    try { execSync(`launchctl unload "${legacyPlist}"`, { stdio: 'pipe' }); } catch { /* ok */ }
    fs.unlinkSync(legacyPlist);
    console.log('Removed legacy com.nanoclaw.plist');
  }

  killRogueProcesses();
  killStaleContainers();

  console.log('InfiniClaw stopped.');
}

export function chat(bot: string): void {
  const root = resolveRoot();
  const base = baseNanoclawDir(root);
  const instance = instanceDir(root, bot);

  if (!fs.existsSync(instance)) {
    throw new Error(`Missing instance for ${bot}. Run 'start' first.`);
  }

  // Sync code from vendored nanoclaw
  const excludeArgs = RSYNC_EXCLUDES.flatMap((e) => ['--exclude', e]);
  execFileSync('rsync', ['-a', '--delete', ...excludeArgs, `${base}/`, `${instance}/`], {
    stdio: 'inherit',
  });

  // Build if needed
  const distIndex = path.join(instance, 'dist', 'index.js');
  let needsBuild = !fs.existsSync(distIndex);
  if (!needsBuild) {
    try {
      const srcFiles = execSync(`find "${instance}/src" -name '*.ts' -newer "${distIndex}"`, {
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
  const result = spawnSync('node', ['dist/index.js'], {
    cwd: instance,
    env: childEnv,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
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
