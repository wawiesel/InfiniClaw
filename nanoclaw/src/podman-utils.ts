/**
 * Shared podman container utilities.
 * Consolidates container listing, name parsing, and stop logic.
 */
import { execSync, spawnSync } from 'child_process';
import { logger } from './logger.js';

/**
 * Attempt to recover a dead podman socket by restarting the machine.
 * Returns true if recovery succeeded, false otherwise.
 */
export function recoverPodman(): boolean {
  logger.warn('Podman socket dead, attempting recovery...');
  try { execSync('podman machine stop podman-machine-default', { stdio: 'pipe', timeout: 30_000 }); } catch { /* best effort */ }
  try { execSync('podman machine start podman-machine-default', { stdio: 'pipe', timeout: 180_000 }); } catch { /* best effort */ }
  for (let i = 0; i < 10; i++) {
    try {
      execSync('podman info', { stdio: 'pipe' });
      logger.info('Podman recovered');
      return true;
    } catch {
      spawnSync('sleep', ['1']);
    }
  }
  logger.error('Podman recovery failed');
  return false;
}

/** Get all running podman container names. Returns empty array on failure. */
export function getPodmanContainerNames(timeoutMs = 5000): string[] {
  try {
    const output = execSync('podman ps --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: timeoutMs,
    });
    const containers: Array<{ Names?: string[] | string }> = JSON.parse(output || '[]');
    return containers.flatMap((c) => {
      if (Array.isArray(c.Names)) return c.Names;
      return c.Names ? [c.Names] : [];
    });
  } catch {
    return [];
  }
}

/** Stop a podman container by name. Best-effort, never throws. */
export function stopContainer(name: string, graceSec = 1, timeoutMs = 10000): void {
  try {
    execSync(`podman stop -t ${graceSec} "${name}"`, { stdio: 'pipe', timeout: timeoutMs });
  } catch { /* best effort */ }
}

/** Stop all running containers whose name starts with the given prefix. */
export function stopContainersByPrefix(prefix: string, graceSec = 1): string[] {
  const names = getPodmanContainerNames();
  const matching = names.filter((n) => n.startsWith(prefix));
  for (const name of matching) {
    stopContainer(name, graceSec);
  }
  return matching;
}
