import fs from 'fs';
import path from 'path';
import { logger } from 'nanoclaw/logger.js';
import { ensureContainerSystemRunning } from './podman-bootstrap.js';
import { initDatabase } from 'nanoclaw/db.js';
import { validateConfig } from './infini-config.js';
import { setBotMatrixUserIds } from './bot-manager.js';
import { collectBotMatrixUserIds } from './service.js';

export async function bootstrapSystem(): Promise<void> {
  // Load supplemental env from .env.local
  const envLocalPath = path.join(process.cwd(), '.env.local');
  if (fs.existsSync(envLocalPath)) {
    for (const line of fs.readFileSync(envLocalPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }

  // Ensure common tool paths are available (launchd provides minimal PATH)
  for (const p of ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']) {
    if (!(process.env.PATH || '').includes(p)) {
      process.env.PATH = `${p}:${process.env.PATH || ''}`;
    }
  }

  await ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');

  const configWarnings = validateConfig();
  for (const w of configWarnings) logger.warn(w);

  try {
    setBotMatrixUserIds(collectBotMatrixUserIds());
  } catch (err) {
    logger.warn({ err }, 'Failed to collect bot Matrix user IDs');
  }
}
