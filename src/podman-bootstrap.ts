/**
 * InfiniClaw Podman bootstrap.
 * Machine management, image availability checks, orphaned container cleanup.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, CONTAINER_IMAGE } from 'nanoclaw/config.js';
import { logger } from 'nanoclaw/logger.js';

type PodmanMachineListEntry = {
  Name: string;
  Default?: boolean;
  Running?: boolean;
  Starting?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSafePodmanArg(value: string): boolean {
  return value.length > 0 && !value.startsWith('-') && !/[\s\x00-\x1f\x7f]/.test(value);
}

function getContainerImageOrThrow(): string {
  const image = (CONTAINER_IMAGE || '').trim();
  if (!isSafePodmanArg(image)) {
    throw new Error(`Invalid container image reference: ${CONTAINER_IMAGE}`);
  }
  return image;
}

function isSafeMachineName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

function canReachPodmanApi(): boolean {
  const result = spawnSync('podman', ['info'], { stdio: 'pipe' });
  return result.status === 0;
}

function podmanCommandSucceeded(args: string[]): boolean {
  const result = spawnSync('podman', args, { stdio: 'ignore' });
  return result.status === 0;
}

function ensurePodmanImageAvailable(): void {
  const image = getContainerImageOrThrow();
  if (podmanCommandSucceeded(['image', 'exists', image])) {
    logger.debug({ image }, 'Podman image available');
    return;
  }

  const dockerfilePath = path.join(process.cwd(), 'container', 'Dockerfile');
  const buildContext = path.join(process.cwd(), 'container');
  if (!fs.existsSync(dockerfilePath) || !fs.existsSync(buildContext)) {
    throw new Error(
      `Container image ${image} missing and build context not found`,
    );
  }

  logger.warn({ image }, 'Podman image missing; rebuilding');
  const buildResult = spawnSync(
    'podman',
    ['build', '-t', image, '-f', dockerfilePath, buildContext],
    {
      stdio: 'inherit',
      timeout: 30 * 60 * 1000,
    },
  );

  if (buildResult.error) {
    throw new Error(
      `Failed to rebuild container image ${image}: ${buildResult.error.message}`,
    );
  }

  if (buildResult.status !== 0) {
    throw new Error(
      `Failed to rebuild container image ${image} (exit code ${buildResult.status ?? 'unknown'})`,
    );
  }

  if (!podmanCommandSucceeded(['image', 'exists', image])) {
    throw new Error(
      `Container image ${image} is still missing after rebuild`,
    );
  }

  logger.info({ image }, 'Podman image rebuilt and ready');
}

async function waitForPodmanApi(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (canReachPodmanApi()) return true;
    await sleep(1000);
  }
  return canReachPodmanApi();
}

function getPodmanMachines(): PodmanMachineListEntry[] {
  const result = spawnSync('podman', ['machine', 'list', '--format', 'json'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `podman machine list failed with exit code ${result.status ?? 'unknown'}`,
    );
  }
  const output = result.stdout || '[]';
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

function stopPodmanMachine(machineName: string): void {
  try {
    spawnSync('podman', ['machine', 'stop', machineName], {
      stdio: 'pipe',
      timeout: 30000,
    });
  } catch {
    // Best effort stop
  }
}

function startPodmanMachine(machineName: string): void {
  const startResult = spawnSync('podman', ['machine', 'start', machineName], {
    stdio: 'pipe',
    timeout: 180000,
  });
  if (startResult.error) {
    throw startResult.error;
  }
  if (startResult.status !== 0) {
    throw new Error(
      `podman machine start failed with exit code ${startResult.status ?? 'unknown'}`,
    );
  }
}

function recoverPodmanMachineState(machine: PodmanMachineListEntry): void {
  const machineName = machine.Name;
  if (!isSafeMachineName(machineName)) {
    throw new Error(`Invalid podman machine name: ${machineName}`);
  }
  if (machine.Starting && !machine.Running) {
    logger.warn({ machineName }, 'Podman machine stuck in starting state; forcing stop');
    stopPodmanMachine(machineName);
  } else if (machine.Running) {
    logger.warn({ machineName }, 'Podman machine reports running but API is unavailable; restarting');
    stopPodmanMachine(machineName);
  }
  startPodmanMachine(machineName);
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
    recoverPodmanMachineState(machine);
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

type PodmanPsEntry = {
  Names?: string[] | string;
};

function getRunningContainerNames(): string[] {
  const result = spawnSync('podman', ['ps', '--format', 'json'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  if (result.status !== 0) return [];

  const parsed: unknown = JSON.parse(result.stdout || '[]');
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const names = (entry as PodmanPsEntry)?.Names;
    if (Array.isArray(names)) return names.filter((n): n is string => typeof n === 'string');
    return typeof names === 'string' ? [names] : [];
  });
}

export function cleanupOrphanedPodmanContainers(): void {
  const botTag = (ASSISTANT_NAME || 'bot').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const prefix = `nanoclaw-${botTag}-`;
  const stopped: string[] = [];
  for (const name of getRunningContainerNames()) {
    if (!name.startsWith(prefix)) continue;
    const result = spawnSync('podman', ['stop', '-t', '1', name], {
      stdio: 'pipe',
      timeout: 10000,
    });
    if (result.status === 0) {
      stopped.push(name);
    }
  }
  if (stopped.length > 0) {
    logger.info({ count: stopped.length, names: stopped }, 'Stopped orphaned podman containers');
  }
}

export async function ensureContainerSystemRunning(): Promise<void> {
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
    const originalError = err instanceof Error ? err : new Error(String(err));
    throw new Error(`Podman bootstrap failed: ${originalError.message}`, {
      cause: originalError,
    });
  }
}
