import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { instanceDir, loadProfileEnv, getActiveBots, personaDir, profileEnvPath, seedMainRoomRegistration, logDir } from './service.js';
import { assertValidBotName, resolveRoot } from './utils.js';
import { ensurePodmanReady } from './podman-service.js';
import { rsyncInstance } from './deploy-service.js';
import { loadShipConfig } from './ship-config.js';
import { pm2StartBot, pm2Stop, pm2Name } from './process-manager.js';
import { stopContainersByPrefix } from 'nanoclaw/podman-utils.js';

export function holodeckBotName(bot: string): string {
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

  // 5. Create holodeck profile
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

  // 7. Restore persona
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
}

export function holodeckTeardown(bot: string): void {
  assertValidBotName(bot);
  const root = resolveRoot();
  const hdBot = holodeckBotName(bot);
  const worktree = path.join(root, '_holodeck', bot);
  const instance = instanceDir(root, hdBot);
  const config = loadShipConfig();
  const hdProfile = path.join(config.secretsPath, 'bots', hdBot);

  pm2Stop(pm2Name(hdBot));
  stopContainersByPrefix(`nanoclaw-${hdBot}-`);

  if (fs.existsSync(instance)) fs.rmSync(instance, { recursive: true });
  if (fs.existsSync(hdProfile)) fs.rmSync(hdProfile, { recursive: true });
  if (fs.existsSync(worktree)) {
    execFileSync('git', ['worktree', 'remove', worktree, '--force'], { cwd: root, stdio: 'inherit' });
  }
}

export function holodeckPromote(bot: string): void {
  assertValidBotName(bot);
  const root = resolveRoot();
  const worktree = path.join(root, '_holodeck', bot);
  if (!fs.existsSync(worktree)) throw new Error(`No holodeck found for ${bot}.`);

  const branch = execSync('git branch --show-current', { cwd: worktree, encoding: 'utf-8' }).trim();
  if (!branch) throw new Error('Cannot determine holodeck branch.');

  console.log(`Merging '${branch}' into current branch...`);
  execFileSync('git', ['merge', branch], { cwd: root, stdio: 'inherit' });

  holodeckTeardown(bot);

  console.log(`Redeploying ${bot}...`);
  // Import bootstrapBot from service to avoid circular dependency
  import('./service.js').then(s => s.bootstrapBot(root, bot));
}
