import crypto from 'crypto';
import { execFileSync, execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { instanceDir, loadProfileEnv, getActiveBots, personaDir, seedMainRoomRegistration, restorePersona } from './service.js';
import { assertValidBotName, resolveRoot } from './utils.js';

const RSYNC_EXCLUDES = [
  'node_modules',
  'data',
  'store',
  'logs',
  '.env.local',
];

export function deployBot(root: string, bot: string): void {
  const instance = instanceDir(root, bot);
  fs.mkdirSync(instance, { recursive: true });

  rebuildImageIfChanged(root, bot);
  // syncPersona(root, bot); // Persona sync can be handled separately if needed
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

  restorePersona(root, bot);
  if (mainJid && mainGroupName) {
    seedMainRoomRegistration(instance, mainJid, mainGroupName, mainGroupFolder, true);
    console.log(`${bot}: pre-registered ${mainGroupName} (${mainGroupFolder})`);
  }

  const dataDir = path.join(instance, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Mark instance as fresh
  fs.writeFileSync(path.join(dataDir, 'run-id'), `${Date.now()}`);
}

export function validateDeploy(root: string, bot: string): { ok: boolean; errors: string } {
  const instance = instanceDir(root, bot);
  const staging = path.join(root, '_runtime', 'staging', bot);
  fs.mkdirSync(staging, { recursive: true });

  rsyncInstance(root, staging, 'pipe');

  // Symlink node_modules from live instance
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

function computeBuildContextHash(root: string, bot: string): string {
  const hash = crypto.createHash('sha256');
  const dockerfile = path.join(root, 'bots', 'container', bot, 'Dockerfile');
  if (fs.existsSync(dockerfile)) hash.update(fs.readFileSync(dockerfile));
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

function rebuildImageIfChanged(root: string, bot: string): void {
  const hashDir = path.join(root, '_runtime', 'data');
  fs.mkdirSync(hashDir, { recursive: true });
  const hashFile = path.join(hashDir, `image-hash-${bot}`);
  const currentHash = computeBuildContextHash(root, bot);
  let storedHash = '';
  try { storedHash = fs.readFileSync(hashFile, 'utf8').trim(); } catch { }
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

function stampGitVersion(root: string, instance: string): void {
  try {
    const opts = { cwd: root, encoding: 'utf-8' as const, stdio: 'pipe' as const };
    const hash = execSync('git rev-parse --short HEAD', opts).toString().trim();
    const date = execSync('git log -1 --format=%ci HEAD', opts).toString().trim().slice(0, 10);
    const subject = execSync('git log -1 --format=%s HEAD', opts).toString().trim();
    fs.writeFileSync(path.join(instance, 'GIT_VERSION'), `${hash} (${date}) ${subject}\n`);
  } catch { }
}

export function rsyncInstance(root: string, dst: string, stdio: 'inherit' | 'pipe' = 'inherit'): void {
  const excludeArgs = RSYNC_EXCLUDES.flatMap((e) => ['--exclude', e]);
  const ncDst = path.join(dst, 'external', 'nanoclaw');
  fs.mkdirSync(ncDst, { recursive: true });
  execFileSync('rsync', ['-a', '--delete', ...excludeArgs, `${path.join(root, 'external', 'nanoclaw')}/`, `${ncDst}/`], { stdio });

  const srcDst = path.join(dst, 'src');
  fs.mkdirSync(srcDst, { recursive: true });
  execFileSync('rsync', ['-a', '--delete', `${path.join(root, 'src')}/`, `${srcDst}/`], { stdio });

  const scriptsSrc = path.join(root, 'scripts');
  if (fs.existsSync(scriptsSrc)) {
    const scriptsDst = path.join(dst, 'scripts');
    fs.mkdirSync(scriptsDst, { recursive: true });
    execFileSync('rsync', ['-a', '--delete', `${scriptsSrc}/`, `${scriptsDst}/`], { stdio });
  }

  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) {
    const src = path.join(root, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dst, file));
  }

  const baseClaude = path.join(root, 'bots', 'CLAUDE.md');
  if (fs.existsSync(baseClaude)) fs.copyFileSync(baseClaude, path.join(dst, 'CLAUDE.md'));
}

function filesEqual(a: string, b: string): boolean {
  try {
    const result = spawnSync('diff', ['-q', a, b], { stdio: 'pipe' });
    return result.status === 0;
  } catch {
    return false;
  }
}
