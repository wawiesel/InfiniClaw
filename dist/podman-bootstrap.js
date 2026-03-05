/**
 * InfiniClaw Podman bootstrap.
 * Machine management, image availability checks, orphaned container cleanup.
 */
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ASSISTANT_NAME, CONTAINER_IMAGE } from 'nanoclaw/config.js';
import { logger } from 'nanoclaw/logger.js';
import { stopContainersByPrefix } from 'nanoclaw/podman-utils.js';
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function canReachPodmanApi() {
    try {
        execSync('podman info', { stdio: 'pipe' });
        return true;
    }
    catch {
        return false;
    }
}
function podmanCommandSucceeded(args) {
    const result = spawnSync('podman', args, { stdio: 'ignore' });
    return result.status === 0;
}
function ensurePodmanImageAvailable() {
    if (podmanCommandSucceeded(['image', 'exists', CONTAINER_IMAGE])) {
        logger.debug({ image: CONTAINER_IMAGE }, 'Podman image available');
        return;
    }
    const dockerfilePath = path.join(process.cwd(), 'container', 'Dockerfile');
    const buildContext = path.join(process.cwd(), 'container');
    if (!fs.existsSync(dockerfilePath) || !fs.existsSync(buildContext)) {
        throw new Error(`Container image ${CONTAINER_IMAGE} missing and build context not found`);
    }
    logger.warn({ image: CONTAINER_IMAGE }, 'Podman image missing; rebuilding');
    const buildResult = spawnSync('podman', ['build', '-t', CONTAINER_IMAGE, '-f', dockerfilePath, buildContext], {
        stdio: 'inherit',
        timeout: 30 * 60 * 1000,
    });
    if (buildResult.error) {
        throw new Error(`Failed to rebuild container image ${CONTAINER_IMAGE}: ${buildResult.error.message}`);
    }
    if (buildResult.status !== 0) {
        throw new Error(`Failed to rebuild container image ${CONTAINER_IMAGE} (exit code ${buildResult.status ?? 'unknown'})`);
    }
    if (!podmanCommandSucceeded(['image', 'exists', CONTAINER_IMAGE])) {
        throw new Error(`Container image ${CONTAINER_IMAGE} is still missing after rebuild`);
    }
    logger.info({ image: CONTAINER_IMAGE }, 'Podman image rebuilt and ready');
}
async function waitForPodmanApi(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (canReachPodmanApi())
            return true;
        await sleep(1000);
    }
    return canReachPodmanApi();
}
function getPodmanMachines() {
    const output = execSync('podman machine list --format json', {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
    });
    const parsed = JSON.parse(output || '[]');
    if (!Array.isArray(parsed))
        return [];
    return parsed.filter((item) => !!item &&
        typeof item === 'object' &&
        'Name' in item &&
        typeof item.Name === 'string');
}
function selectPodmanMachine(machines) {
    return machines.find((m) => m.Default) || machines[0];
}
async function ensurePodmanRuntimeAvailable() {
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
                spawnSync('podman', ['machine', 'stop', machineName], {
                    stdio: 'pipe',
                    timeout: 30000,
                });
            }
            catch {
                // Best effort: a stale "starting" state may not stop cleanly.
            }
        }
        else if (machine.Running) {
            logger.warn({ machineName }, 'Podman machine reports running but API is unavailable; restarting');
            try {
                spawnSync('podman', ['machine', 'stop', machineName], {
                    stdio: 'pipe',
                    timeout: 30000,
                });
            }
            catch {
                // Best effort before restart.
            }
        }
        const startResult = spawnSync('podman', ['machine', 'start', machineName], {
            stdio: 'pipe',
            timeout: 180000,
        });
        if (startResult.error) {
            throw startResult.error;
        }
        if (startResult.status !== 0) {
            throw new Error(`podman machine start failed with exit code ${startResult.status ?? 'unknown'}`);
        }
    }
    catch (err) {
        logger.error({ err, machineName }, 'Failed to start Podman machine');
        throw err;
    }
    if (await waitForPodmanApi(120000)) {
        logger.info({ machineName }, 'Podman runtime recovered');
        return;
    }
    throw new Error('Podman machine started but API did not become ready');
}
export function cleanupOrphanedPodmanContainers() {
    const botTag = (ASSISTANT_NAME || 'bot').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const stopped = stopContainersByPrefix(`nanoclaw-${botTag}-`);
    if (stopped.length > 0) {
        logger.info({ count: stopped.length, names: stopped }, 'Stopped orphaned podman containers');
    }
}
export async function ensureContainerSystemRunning() {
    try {
        await ensurePodmanRuntimeAvailable();
        cleanupOrphanedPodmanContainers();
        ensurePodmanImageAvailable();
    }
    catch (err) {
        logger.error({ err }, 'Podman runtime/image setup failed');
        console.error('\n╔════════════════════════════════════════════════════════════════╗');
        console.error('║  FATAL: Podman setup failed                                     ║');
        console.error('║                                                                ║');
        console.error('║  Could not start Podman runtime or prepare container image.    ║');
        console.error('║  Check: podman machine list / podman machine start             ║');
        console.error('╚════════════════════════════════════════════════════════════════╝\n');
        const originalError = err instanceof Error ? err : new Error(String(err));
        throw new Error(`Podman bootstrap failed: ${originalError.message}`, {
            cause: originalError,
        });
    }
}
//# sourceMappingURL=podman-bootstrap.js.map