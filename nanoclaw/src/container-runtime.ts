/**
 * Container runtime abstraction.
 *
 * Isolates all podman and Apple Container lifecycle logic so that
 * index.ts and container-runner.ts stay runtime-agnostic.
 * InfiniClaw (podman-only) and the upstream fork (Apple Container default)
 * both use this module — only the CONTAINER_RUNTIME env var differs.
 */
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CONTAINER_IMAGE,
  CONTAINER_RUNTIME,
} from './config.js';
import { logger } from './logger.js';

// ─── Shared helpers ──────────────────────────────────────────────

export function isPodmanRuntime(): boolean {
  return CONTAINER_RUNTIME === 'podman';
}

export function containerCli(): 'container' | 'podman' {
  return isPodmanRuntime() ? 'podman' : 'container';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function botTagPrefix(): string {
  const tag = (ASSISTANT_NAME || 'bot').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return `nanoclaw-${tag}-`;
}

// ─── Runtime health ──────────────────────────────────────────────

export function runtimeHealthy(): boolean {
  if (isPodmanRuntime()) {
    return canReachPodmanApi();
  }
  try {
    execSync('container system status', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ─── Active container detection ──────────────────────────────────

export function hasRuntimeActiveContainer(safeFolder: string): boolean {
  const prefix = `${botTagPrefix()}${safeFolder}-`;

  if (isPodmanRuntime()) {
    try {
      const output = execSync('podman ps --format json', {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      const parsed: unknown = JSON.parse(output || '[]');
      if (!Array.isArray(parsed)) return false;
      return parsed.some((entry) => {
        if (!entry || typeof entry !== 'object') return false;
        const record = entry as Record<string, unknown>;
        const namesRaw = record.Names ?? record.Name;
        const names = Array.isArray(namesRaw)
          ? namesRaw.filter((n): n is string => typeof n === 'string')
          : typeof namesRaw === 'string'
            ? [namesRaw]
            : [];
        return names.some((n) => n.startsWith(prefix));
      });
    } catch {
      return false;
    }
  }

  try {
    const output = execSync('container ls --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const parsed: unknown = JSON.parse(output || '[]');
    if (!Array.isArray(parsed)) return false;
    return parsed.some((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const record = entry as {
        status?: string;
        configuration?: { id?: string };
      };
      return (
        record.status === 'running' &&
        typeof record.configuration?.id === 'string' &&
        record.configuration.id.startsWith(prefix)
      );
    });
  } catch {
    return false;
  }
}

// ─── Podman helpers ──────────────────────────────────────────────

function canReachPodmanApi(): boolean {
  try {
    execSync('podman info', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function podmanCommandSucceeded(args: string[]): boolean {
  const result = spawnSync('podman', args, { stdio: 'ignore' });
  return result.status === 0;
}

function ensurePodmanImageAvailable(): void {
  if (podmanCommandSucceeded(['image', 'exists', CONTAINER_IMAGE])) {
    logger.debug({ image: CONTAINER_IMAGE }, 'Podman image available');
    return;
  }

  const dockerfilePath = path.join(process.cwd(), 'container', 'Dockerfile');
  const buildContext = path.join(process.cwd(), 'container');
  if (!fs.existsSync(dockerfilePath) || !fs.existsSync(buildContext)) {
    throw new Error(
      `Container image ${CONTAINER_IMAGE} missing and build context not found`,
    );
  }

  logger.warn({ image: CONTAINER_IMAGE }, 'Podman image missing; rebuilding');
  const buildResult = spawnSync(
    'podman',
    ['build', '-t', CONTAINER_IMAGE, '-f', dockerfilePath, buildContext],
    {
      stdio: 'inherit',
      timeout: 30 * 60 * 1000,
    },
  );

  if (buildResult.error) {
    throw new Error(
      `Failed to rebuild container image ${CONTAINER_IMAGE}: ${buildResult.error.message}`,
    );
  }

  if (buildResult.status !== 0) {
    throw new Error(
      `Failed to rebuild container image ${CONTAINER_IMAGE} (exit code ${buildResult.status ?? 'unknown'})`,
    );
  }

  if (!podmanCommandSucceeded(['image', 'exists', CONTAINER_IMAGE])) {
    throw new Error(
      `Container image ${CONTAINER_IMAGE} is still missing after rebuild`,
    );
  }

  logger.info({ image: CONTAINER_IMAGE }, 'Podman image rebuilt and ready');
}

async function waitForPodmanApi(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (canReachPodmanApi()) return true;
    await sleep(1000);
  }
  return canReachPodmanApi();
}

type PodmanMachineListEntry = {
  Name: string;
  Default?: boolean;
  Running?: boolean;
  Starting?: boolean;
};

function getPodmanMachines(): PodmanMachineListEntry[] {
  const output = execSync('podman machine list --format json', {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  const parsed: unknown = JSON.parse(output || '[]');
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is PodmanMachineListEntry =>
      !!item &&
      typeof item === 'object' &&
      'Name' in item &&
      typeof (item as { Name: unknown }).Name === 'string',
  );
}

function selectPodmanMachine(machines: PodmanMachineListEntry[]): PodmanMachineListEntry | undefined {
  return machines.find((m) => m.Default) || machines[0];
}

async function ensurePodmanRuntimeAvailable(): Promise<void> {
  if (await waitForPodmanApi(2000)) {
    logger.debug('Podman runtime available');
    return;
  }

  logger.warn('Podman runtime unavailable; attempting machine recovery');

  let machineName = 'podman-machine-default';
  try {
    const machine = selectPodmanMachine(getPodmanMachines());
    if (!machine) {
      throw new Error('No podman machine exists. Run: podman machine init');
    }
    machineName = machine.Name;
    if (machine.Starting && !machine.Running) {
      logger.warn({ machineName }, 'Podman machine stuck in starting state; forcing stop');
      try {
        execSync(`podman machine stop ${machineName}`, { stdio: 'pipe', timeout: 30000 });
      } catch {
        // Best effort: a stale "starting" state may not stop cleanly.
      }
    } else if (machine.Running) {
      logger.warn({ machineName }, 'Podman machine reports running but API is unavailable; restarting');
      try {
        execSync(`podman machine stop ${machineName}`, { stdio: 'pipe', timeout: 30000 });
      } catch {
        // Best effort before restart.
      }
    }

    execSync(`podman machine start ${machineName}`, { stdio: 'pipe', timeout: 180000 });
  } catch (err) {
    logger.error({ err, machineName }, 'Failed to start Podman machine');
    throw err;
  }

  if (await waitForPodmanApi(120000)) {
    logger.info({ machineName }, 'Podman runtime recovered');
    return;
  }

  throw new Error('Podman machine started but API did not become ready');
}

function cleanupOrphanedPodmanContainers(): void {
  try {
    const output = execSync('podman ps --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: Array<{ Names?: string[] | string }> = JSON.parse(
      output || '[]',
    );
    const names = containers.flatMap((c) => {
      if (Array.isArray(c.Names)) return c.Names;
      return c.Names ? [c.Names] : [];
    });
    const ownPrefix = botTagPrefix();
    const orphans = names.filter((n) => n.startsWith(ownPrefix));
    for (const name of orphans) {
      try {
        execSync(`podman stop -t 1 ${name}`, { stdio: 'pipe' });
      } catch {
        // Best-effort cleanup
      }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned podman containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned podman containers');
  }
}

// ─── Apple Container helpers ─────────────────────────────────────

function cleanupOrphanedAppleContainers(): void {
  try {
    const output = execSync('container ls --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: { status: string; configuration: { id: string } }[] = JSON.parse(output || '[]');
    const ownPrefix = botTagPrefix();
    const orphans = containers
      .filter((c) => c.status === 'running' && c.configuration.id.startsWith(ownPrefix))
      .map((c) => c.configuration.id);
    for (const name of orphans) {
      try {
        execSync(`container stop ${name}`, { stdio: 'pipe' });
      } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

// ─── Unified entry point ─────────────────────────────────────────

export async function ensureContainerSystemRunning(): Promise<void> {
  if (isPodmanRuntime()) {
    try {
      await ensurePodmanRuntimeAvailable();
      cleanupOrphanedPodmanContainers();
      ensurePodmanImageAvailable();
    } catch (err) {
      logger.error({ err }, 'Podman runtime/image setup failed');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Podman setup failed                                     ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Could not start Podman runtime or prepare container image.    ║',
      );
      console.error(
        '║  Check: podman machine list / podman machine start             ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Podman is required but not available');
    }
    return;
  }

  try {
    execSync('container system status', { stdio: 'pipe' });
    logger.debug('Apple Container system already running');
  } catch {
    logger.info('Starting Apple Container system...');
    try {
      execSync('container system start', { stdio: 'pipe', timeout: 30000 });
      logger.info('Apple Container system started');
    } catch (err) {
      logger.error({ err }, 'Failed to start Apple Container system');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Apple Container system failed to start                 ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without Apple Container system.             ║',
      );
      console.error(
        '║  Install from: https://github.com/apple/container              ║',
      );
      console.error(
        '║  Then run: container system start                              ║',
      );
      console.error(
        '║  Then restart NanoClaw                                         ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Apple Container system is required but not running');
    }
  }

  cleanupOrphanedAppleContainers();
}
