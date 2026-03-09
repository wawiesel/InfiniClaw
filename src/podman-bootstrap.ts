/**
 * InfiniClaw Podman bootstrap.
 * Image availability checks and orphaned container cleanup.
 * Recovery logic lives in podman-utils.ts.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE } from 'nanoclaw/config.js';
import { logger } from 'nanoclaw/logger.js';
import {
  botTag,
  canReachPodmanApi,
  getPodmanContainerNames,
  recoverPodman,
  stopContainer,
} from './podman-utils.js';

// ── Image management ────────────────────────────────────────────────

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
    { stdio: 'inherit', timeout: 30 * 60 * 1000 },
  );

  if (buildResult.error) {
    throw new Error(`Failed to rebuild container image ${image}: ${buildResult.error.message}`);
  }
  if (buildResult.status !== 0) {
    throw new Error(`Failed to rebuild container image ${image} (exit code ${buildResult.status ?? 'unknown'})`);
  }
  if (!podmanCommandSucceeded(['image', 'exists', image])) {
    throw new Error(`Container image ${image} is still missing after rebuild`);
  }

  logger.info({ image }, 'Podman image rebuilt and ready');
}

// ── Orphan cleanup ──────────────────────────────────────────────────

export function cleanupOrphanedPodmanContainers(): void {
  const prefix = `nanoclaw-${botTag()}-`;
  const stopped: string[] = [];
  for (const name of getPodmanContainerNames()) {
    if (!name.startsWith(prefix)) continue;
    stopContainer(name);
    stopped.push(name);
  }
  if (stopped.length > 0) {
    logger.info({ count: stopped.length, names: stopped }, 'Stopped orphaned podman containers');
  }
}

// ── Bootstrap ───────────────────────────────────────────────────────

export async function ensureContainerSystemRunning(): Promise<void> {
  try {
    if (!canReachPodmanApi() && !recoverPodman()) {
      throw new Error('Podman runtime unavailable after recovery attempt');
    }
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
