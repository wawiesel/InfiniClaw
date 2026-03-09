/**
 * Podman container utilities.
 * Single source of truth for podman recovery, container listing, and stop operations.
 */
import { execSync, spawnSync } from 'child_process';
import { ASSISTANT_NAME } from 'nanoclaw/config.js';
import { logger } from 'nanoclaw/logger.js';

// ── Helpers ─────────────────────────────────────────────────────────

/** Check if podman API is reachable. */
export function canReachPodmanApi(): boolean {
  try {
    execSync('podman info', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Sanitized bot name for use in container name prefixes. */
export function botTag(): string {
  return (ASSISTANT_NAME || 'bot').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── Recovery ────────────────────────────────────────────────────────

type PodmanMachineEntry = { Name: string; Default?: boolean; Running?: boolean; Starting?: boolean };

function getPodmanMachines(): PodmanMachineEntry[] {
  try {
    const result = spawnSync('podman', ['machine', 'list', '--format', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    if (result.status !== 0) return [];
    const parsed: unknown = JSON.parse(result.stdout || '[]');
    return Array.isArray(parsed) ? parsed.filter(
      (item): item is PodmanMachineEntry =>
        !!item && typeof item === 'object' && 'Name' in item && typeof (item as { Name: unknown }).Name === 'string',
    ) : [];
  } catch {
    return [];
  }
}

const SAFE_MACHINE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Recover podman runtime. Detects machine name dynamically,
 * handles stuck "Starting" state, polls until API is ready.
 */
export function recoverPodman(): boolean {
  if (canReachPodmanApi()) return true;

  logger.warn('Podman API unavailable, attempting recovery...');

  let machineName = 'podman-machine-default';
  try {
    const machines = getPodmanMachines();
    const machine = machines.find((m) => m.Default) || machines[0];
    if (machine && SAFE_MACHINE_NAME.test(machine.Name)) {
      machineName = machine.Name;
      // Handle stuck "Starting" or unresponsive "Running" state
      if (machine.Starting || machine.Running) {
        logger.warn({ machineName, starting: machine.Starting, running: machine.Running },
          'Podman machine in bad state, stopping first');
        try { spawnSync('podman', ['machine', 'stop', machineName], { stdio: 'pipe', timeout: 30_000 }); } catch { /* best effort */ }
      }
    }
  } catch { /* use default machine name */ }

  try {
    spawnSync('podman', ['machine', 'start', machineName], { stdio: 'pipe', timeout: 180_000 });
  } catch { /* best effort */ }

  // Poll for API readiness
  for (let i = 0; i < 30; i++) {
    if (canReachPodmanApi()) {
      logger.info({ machineName }, 'Podman recovered');
      return true;
    }
    spawnSync('sleep', ['1']);
  }

  logger.error({ machineName }, 'Podman recovery failed');
  return false;
}

// ── Container management ────────────────────────────────────────────

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

export function stopContainer(name: string, graceSec = 1, timeoutMs = 10000): void {
  try {
    execSync(`podman stop -t ${graceSec} "${name}"`, { stdio: 'pipe', timeout: timeoutMs });
  } catch { /* best effort */ }
}

export function stopContainersByPrefix(prefix: string, graceSec = 1): string[] {
  const names = getPodmanContainerNames();
  const matching = names.filter((n) => n.startsWith(prefix));
  for (const name of matching) {
    stopContainer(name, graceSec);
  }
  return matching;
}
