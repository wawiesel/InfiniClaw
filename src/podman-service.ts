import { execSync } from 'child_process';
import { recoverPodman, stopContainersByPrefix } from 'nanoclaw/podman-utils.js';
import { assertValidBotName } from './utils.js';

export function ensurePodmanReady(): void {
  try {
    execSync('podman info', { stdio: 'pipe' });
    return;
  } catch { /* fall through to recovery */ }
  if (!recoverPodman()) {
    throw new Error(
      'Podman API unavailable after recovery attempt.\n' +
      'Try: podman machine stop podman-machine-default && podman machine start podman-machine-default',
    );
  }
}

export function killStaleContainers(onlyBot?: string): void {
  if (onlyBot) assertValidBotName(onlyBot);
  const prefix = onlyBot ? `nanoclaw-${onlyBot}-` : 'nanoclaw-';
  const stopped = stopContainersByPrefix(prefix, 5);
  for (const name of stopped) {
    console.log(`Stopping stale container: ${name}`);
  }
}
