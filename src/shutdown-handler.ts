import { logger } from 'nanoclaw/logger.js';
import { matrixService } from './matrix-service.js';
import { botDisplayName } from './bot-manager.js';
import { fleetManager } from './fleet-manager.js';
import { channels, findChannel } from './channel-manager.js';
import { syncPersona } from './service.js';

export function setupShutdownHandlers(
  persistentTimers: ReturnType<typeof setInterval>[],
  registeredGroups: Record<string, any>,
  queue: any,
  matrixRef: any,
): void {
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    for (const timer of persistentTimers) clearInterval(timer);
    
    for (const jid of Object.keys(registeredGroups)) {
      const ch = findChannel(jid);
      if (ch?.setStatusPip) {
        try { await ch.setStatusPip(jid, '🔴'); } catch { /* best-effort */ }
      }
    }

    for (const ch of channels) {
      if (ch.setPresenceStatus) {
        try { await ch.setPresenceStatus('offline', 'shutting down...'); } catch { }
      }
    }

    if (matrixRef) {
      try { await matrixService.setDisplayName(botDisplayName('🔴')); } catch { /* best-effort */ }
    }

    // Sync personas
    const rootDir = process.env.INFINICLAW_ROOT;
    const personaName = process.env.PERSONA_NAME;
    if (rootDir && personaName) {
      try {
        syncPersona(rootDir, personaName);
        logger.info({ personaName }, 'Synced group memory and skills to personas/');
      } catch (err) {
        logger.warn({ err, personaName }, 'Failed to sync personas on shutdown');
      }
    }

    await queue.shutdown(10000);
    for (const ch of channels) {
      try { await ch.disconnect(); } catch { }
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
