import fs from 'fs';
import path from 'path';
import { logger } from 'nanoclaw/logger.js';
import { pruneExpired } from './allow-list.js';

export function startMemoryWatchdog(heapLimitMb: number, checkInterval: number, dataDir: string, onLimit: () => void) {
  const heapLimitBytes = heapLimitMb * 1024 * 1024;
  const heartbeatPath = path.join(dataDir, 'heartbeat');
  
  return setInterval(() => {
    const usage = process.memoryUsage();
    const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
    const rssMB = Math.round(usage.rss / 1024 / 1024);
    logger.info({ heapMB, rssMB, limitMB: heapLimitMb }, 'Memory');
    
    try { fs.writeFileSync(heartbeatPath, String(Date.now())); } catch { }
    
    if (heapLimitBytes > 0 && usage.heapUsed > heapLimitBytes) {
      logger.warn({ heapMB, limitMB: heapLimitMb }, 'Heap limit exceeded, recycling');
      onLimit();
    }
  }, checkInterval);
}

export function startPruningLoops(pruneAllowListInterval: number, pruneThreadsInterval: number, threadMaps: any[]) {
  const allowListTimer = setInterval(() => {
    const count = pruneExpired();
    if (count > 0) logger.info({ count }, 'Pruned expired allow-list entries');
  }, pruneAllowListInterval);

  const threadTimer = setInterval(() => {
    // Logic for pruning thread maps can go here
  }, pruneThreadsInterval);

  return [allowListTimer, threadTimer];
}
