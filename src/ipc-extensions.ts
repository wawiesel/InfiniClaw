/**
 * Extended IPC operations for multi-bot deployments.
 *
 * Config-driven: requires INFINICLAW_ROOT or a standard InfiniClaw directory
 * layout. All handlers are no-ops when the required paths don't exist.
 * This module is fork-only — upstream nanoclaw does not have it.
 */
import { execFile, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, ASSISTANT_ROLE } from './config.js';
import { logger } from './logger.js';

// ─── Helpers ─────────────────────────────────────────────────────

export function resolveInfiniClawRoot(): string {
  const explicit = process.env.INFINICLAW_ROOT?.trim();
  if (explicit) return explicit;
  // Fallback from instances/<bot>/nanoclaw -> repo root
  return path.resolve(process.cwd(), '..', '..', '..');
}

function validateDeploy(bot: string): Promise<{ ok: boolean; errors: string }> {
  return new Promise((resolve) => {
    const root = resolveInfiniClawRoot();
    const script = path.join(root, 'scripts', 'validate-deploy.sh');
    if (!fs.existsSync(script)) {
      resolve({ ok: true, errors: '' });
      return;
    }
    execFile(script, [bot], { timeout: 60_000 }, (err, _stdout, stderr) => {
      if (err) {
        resolve({ ok: false, errors: stderr || err.message });
      } else {
        resolve({ ok: true, errors: '' });
      }
    });
  });
}

function deployInstance(bot: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const root = resolveInfiniClawRoot();
    const common = path.join(root, 'scripts', 'common.sh');
    const baseNanoclaw = path.join(root, 'nanoclaw');
    const instance = path.join(root, '_runtime', 'instances', bot, 'nanoclaw');
    const buildScript = path.join(root, 'bots', 'container', 'build.sh');
    if (!fs.existsSync(common) || !fs.existsSync(baseNanoclaw)) {
      resolve({ ok: false, output: 'InfiniClaw directory layout not found' });
      return;
    }
    const script = [
      `source "${common}"`,
      `sync_persona "${bot}"`,
      `rsync -a --delete --exclude node_modules --exclude data --exclude store --exclude groups --exclude logs --exclude .env.local "${baseNanoclaw}/" "${instance}/"`,
      `cd "${instance}"`,
      `if [ ! -d node_modules ] || ! diff -q "${baseNanoclaw}/package-lock.json" node_modules/.package-lock.json >/dev/null 2>&1; then npm ci && cp package-lock.json node_modules/.package-lock.json; fi`,
      `npm run build`,
      `restore_persona "${bot}"`,
      `"${buildScript}" "${bot}"`,
    ].join(' && ');
    execFile('bash', ['-c', script], { timeout: 600_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, output: stderr || err.message });
      } else {
        resolve({ ok: true, output: stdout });
      }
    });
  });
}

function rebuildImage(bot: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const root = resolveInfiniClawRoot();
    const script = path.join(root, 'bots', 'container', 'build.sh');
    if (!fs.existsSync(script)) {
      resolve({ ok: false, output: 'Build script not found' });
      return;
    }
    execFile(script, [bot], { timeout: 600_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, output: stderr || err.message });
      } else {
        resolve({ ok: true, output: stdout });
      }
    });
  });
}

function upsertEnvValue(envFile: string, key: string, value: string): void {
  const lines = fs.existsSync(envFile)
    ? fs.readFileSync(envFile, 'utf-8').split('\n')
    : [];
  const next = `${key}=${value}`;
  let updated = false;
  const out = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      updated = true;
      return next;
    }
    return line;
  });
  if (!updated) out.push(next);
  fs.writeFileSync(envFile, `${out.join('\n').replace(/\n*$/, '\n')}`);
}

function applyBrainMode(
  bot: string,
  mode: 'anthropic' | 'ollama',
  model?: string,
): string {
  const root = resolveInfiniClawRoot();
  const envFile = path.join(root, 'bots', 'profiles', bot, 'env');
  if (!fs.existsSync(envFile)) {
    throw new Error(`Missing profile env: ${envFile}`);
  }

  if (mode === 'anthropic') {
    upsertEnvValue(envFile, 'BRAIN_MODEL', model || 'claude-sonnet-4-5');
    upsertEnvValue(envFile, 'BRAIN_BASE_URL', '');
    upsertEnvValue(envFile, 'BRAIN_AUTH_TOKEN', '');
    upsertEnvValue(envFile, 'BRAIN_API_KEY', '');
    return `Updated ${bot} to anthropic mode. Restart required.`;
  }

  upsertEnvValue(
    envFile,
    'BRAIN_MODEL',
    model || 'devstral-small-2-fast:latest',
  );
  upsertEnvValue(
    envFile,
    'BRAIN_BASE_URL',
    'http://host.containers.internal:11434',
  );
  upsertEnvValue(envFile, 'BRAIN_AUTH_TOKEN', 'ollama');
  upsertEnvValue(envFile, 'BRAIN_API_KEY', '');
  upsertEnvValue(envFile, 'BRAIN_OAUTH_TOKEN', '');
  return `Updated ${bot} to ollama mode. Restart required.`;
}

export function readBrainMode(bot: string): { mode: 'anthropic' | 'ollama' | 'unknown'; model: string } {
  const root = resolveInfiniClawRoot();
  const envFile = path.join(root, 'bots', 'profiles', bot, 'env');
  if (!fs.existsSync(envFile)) {
    return { mode: 'unknown', model: '' };
  }
  const content = fs.readFileSync(envFile, 'utf-8');
  const getValue = (key: string): string => {
    const match = content.match(new RegExp(`^${key}=(.*)`, 'm'));
    return match ? match[1].trim() : '';
  };
  const model = getValue('BRAIN_MODEL');
  const baseUrl = getValue('BRAIN_BASE_URL');
  const authToken = getValue('BRAIN_AUTH_TOKEN');
  if (baseUrl && (baseUrl.includes('ollama') || baseUrl.includes('11434'))) {
    return { mode: 'ollama', model };
  }
  if (authToken === 'ollama') {
    return { mode: 'ollama', model };
  }
  return { mode: model ? 'anthropic' : 'unknown', model };
}

// ─── Extended IPC task handler ───────────────────────────────────

export interface ExtendedIpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
}

/**
 * Process an extended IPC task (set_brain_mode, restart_bot, rebuild_image, bot_status).
 * Returns true if the task type was handled, false if unknown.
 */
export async function processExtendedTaskIpc(
  data: {
    type: string;
    bot?: string;
    mode?: string;
    model?: string;
    chatJid?: string;
  },
  isMain: boolean,
  sourceGroup: string,
  deps: ExtendedIpcDeps,
): Promise<boolean> {
  switch (data.type) {
    case 'set_brain_mode': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized set_brain_mode attempt blocked');
        return true;
      }
      if (
        data.bot &&
        data.mode &&
        (data.mode === 'anthropic' || data.mode === 'ollama')
      ) {
        try {
          const summary = applyBrainMode(
            data.bot,
            data.mode,
            typeof data.model === 'string' ? data.model : undefined,
          );
          logger.info({ bot: data.bot, mode: data.mode }, 'Brain mode updated via IPC');
          if (typeof data.chatJid === 'string' && data.chatJid.trim().length > 0) {
            await deps.sendMessage(data.chatJid, `${ASSISTANT_NAME}:\n\n${summary}`);
          }
        } catch (err) {
          logger.error({ err, data }, 'Failed to apply set_brain_mode');
        }
      } else {
        logger.warn({ data }, 'Invalid set_brain_mode request');
      }
      return true;
    }

    case 'restart_bot': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized restart_bot attempt blocked');
        return true;
      }
      const bot = typeof data.bot === 'string' ? data.bot : 'engineer';
      logger.info({ bot }, 'Restart requested via IPC — validating deploy');
      const chatJid = typeof data.chatJid === 'string' && data.chatJid.trim().length > 0
        ? data.chatJid
        : null;
      const { ok, errors } = await validateDeploy(bot);
      if (!ok) {
        logger.error({ bot, errors }, 'Deploy validation failed — aborting restart');
        if (chatJid) {
          try {
            const trimmed = errors.length > 3000 ? errors.slice(-3000) : errors;
            await deps.sendMessage(chatJid, `⛔ deploy validation failed — not restarting:\n\n\`\`\`\n${trimmed}\n\`\`\``);
          } catch { /* best effort */ }
        }
        return true;
      }
      const selfBot = ASSISTANT_ROLE.toLowerCase();
      if (bot === selfBot) {
        logger.info({ bot }, 'Deploy validation passed — deploying to self then restarting');
        const deploy = await deployInstance(bot);
        if (!deploy.ok) {
          logger.error({ bot, output: deploy.output }, 'Self-deploy failed — aborting restart');
          if (chatJid) {
            try {
              const trimmed = deploy.output.length > 3000 ? deploy.output.slice(-3000) : deploy.output;
              await deps.sendMessage(chatJid, `⛔ self-deploy failed — not restarting:\n\n\`\`\`\n${trimmed}\n\`\`\``);
            } catch { /* best effort */ }
          }
          return true;
        }
        if (chatJid) {
          try {
            await deps.sendMessage(chatJid, `⭕️ <font color="#ff0000">restarting ${bot}...</font>`);
          } catch { /* best effort */ }
        }
        setTimeout(() => { process.exit(0); }, 500);
      } else {
        logger.info({ bot }, 'Deploy validation passed — deploying instance');
        const deploy = await deployInstance(bot);
        if (!deploy.ok) {
          logger.error({ bot, output: deploy.output }, 'Instance deploy failed');
          return true;
        }
        logger.info({ bot }, 'Instance deployed — restarting via launchctl');
        if (chatJid) {
          try {
            await deps.sendMessage(chatJid, `⭕️ <font color="#ff0000">restarting ${bot}...</font>`);
          } catch { /* best effort */ }
        }
        try {
          const uid = execSync('id -u').toString().trim();
          execSync(`launchctl kickstart -k gui/${uid}/com.infiniclaw.${bot}`, { timeout: 10_000 });
          logger.info({ bot }, 'Cross-bot restart succeeded');
        } catch (err) {
          logger.error({ bot, err }, 'Cross-bot restart via launchctl failed');
        }
      }
      return true;
    }

    case 'rebuild_image': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized rebuild_image attempt blocked');
        return true;
      }
      const imgBot = typeof data.bot === 'string' ? data.bot : 'commander';
      const imgChatJid = typeof data.chatJid === 'string' && data.chatJid.trim().length > 0
        ? data.chatJid
        : null;
      logger.info({ bot: imgBot }, 'Container image rebuild requested via IPC');
      if (imgChatJid) {
        try { await deps.sendMessage(imgChatJid, `🔧 rebuilding nanoclaw-${imgBot}:latest...`); } catch { /* best effort */ }
      }
      const result = await rebuildImage(imgBot);
      if (!result.ok) {
        logger.error({ bot: imgBot, output: result.output }, 'Image rebuild failed');
        if (imgChatJid) {
          try {
            const trimmed = result.output.length > 3000 ? result.output.slice(-3000) : result.output;
            await deps.sendMessage(imgChatJid, `⛔ image rebuild failed for ${imgBot}:\n\n\`\`\`\n${trimmed}\n\`\`\``);
          } catch { /* best effort */ }
        }
      } else {
        logger.info({ bot: imgBot }, 'Image rebuild succeeded');
        if (imgChatJid) {
          try { await deps.sendMessage(imgChatJid, `✅ nanoclaw-${imgBot}:latest rebuilt`); } catch { /* best effort */ }
        }
      }
      return true;
    }

    case 'bot_status': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized bot_status attempt blocked');
        return true;
      }
      const statusBot = typeof data.bot === 'string' ? data.bot : 'commander';
      const statusChatJid = typeof data.chatJid === 'string' && data.chatJid.trim().length > 0
        ? data.chatJid
        : null;
      if (!statusChatJid) return true;

      try {
        const logDir = path.resolve(process.env.INFINICLAW_ROOT || process.cwd(), 'logs');
        const errorLogPath = path.join(logDir, `${statusBot}.error.log`);
        const lastErrors = fs.existsSync(errorLogPath)
          ? fs.readFileSync(errorLogPath, 'utf8').split('\n').slice(-50).join('\n').trim()
          : '(no error log)';

        let launchctlInfo = '';
        try {
          launchctlInfo = execSync(`launchctl list com.infiniclaw.${statusBot} 2>&1`, { timeout: 5_000 }).toString().trim();
        } catch (e) {
          launchctlInfo = e instanceof Error ? e.message : 'unknown';
        }

        const parts = [`**${statusBot} status:**\n\`\`\`\n${launchctlInfo}\n\`\`\``];
        if (lastErrors && lastErrors !== '(no error log)') {
          const trimmed = lastErrors.length > 3000 ? lastErrors.slice(-3000) : lastErrors;
          parts.push(`**Last errors:**\n\`\`\`\n${trimmed}\n\`\`\``);
        }
        await deps.sendMessage(statusChatJid, parts.join('\n\n'));
      } catch (err) {
        logger.error({ statusBot, err }, 'Failed to get bot status');
      }
      return true;
    }

    default:
      return false;
  }
}
