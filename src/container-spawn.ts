/**
 * InfiniClaw container runner.
 * Prepares InfiniClaw-specific mounts, secrets, and config, then delegates
 * the spawn lifecycle to upstream's composable runContainer().
 *
 * Re-exports writeTasksSnapshot, writeGroupsSnapshot from upstream's container-runner
 * so callers don't need to know which module provides them.
 */
import { ChildProcess, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { parseEnvLine } from './env-utils.js';
import {
  buildBotDirectory,
  buildInfiniClawMounts,
  getPersonaContainerConfig,
  readPersonaGroupMcpServers,
} from './container-mounts.js';
import { assertValidGroupFolder } from 'nanoclaw/group-folder.js';
import {
  normalizeProviderSecrets,
  mapCertPathSecretsToContainer,
} from './container-secrets.js';
import { recoverPodman, stopContainersByPrefix } from './podman-utils.js';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  STORE_DIR,
  IDLE_TIMEOUT,
  ASSISTANT_NAME,
} from 'nanoclaw/config.js';
import { logger } from 'nanoclaw/logger.js';
import type { RegisteredGroup } from 'nanoclaw/types.js';
import type { ContainerInput, ContainerOutput } from 'nanoclaw/container-runner.js';
import { runContainer, type VolumeMount } from './run-container.js';

// Re-export upstream utilities that main.ts needs
export { writeTasksSnapshot, writeGroupsSnapshot } from 'nanoclaw/container-runner.js';
export type { ContainerOutput, ContainerInput } from 'nanoclaw/container-runner.js';

// Container resource limits — upstream removed these from config in v1.2.2
const CONTAINER_CPUS = parseFloat(process.env.CONTAINER_CPUS || '0');
const CONTAINER_MEMORY_MB = parseInt(process.env.CONTAINER_MEMORY_MB || '0', 10);
const CONTAINER_MEMORY_RESERVATION_MB = parseInt(process.env.CONTAINER_MEMORY_RESERVATION_MB || '0', 10);
const CONTAINER_HEAP_LIMIT_MB = parseInt(process.env.CONTAINER_HEAP_LIMIT_MB || '0', 10);

const ALLOWED_ENV_VARS = [
  'ASSISTANT_NAME',
  'ASSISTANT_ROLE',
  'IS_CO',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'NANOCLAW_SKIP_TOKEN_COUNTING',
  'NANOCLAW_CONTEXT_WINDOW',
  'NANOCLAW_DB_PATH',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'OLLAMA_HOST',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'INFINICLAW_ROOT',
  'PERSONA_NAME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
];
const SAFE_CONTAINER_NAME_TAG = /^[a-zA-Z0-9_.-]{1,32}$/;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function collectContainerSecrets(projectRoot: string): Record<string, string> {
  const secrets: Record<string, string> = {};

  for (const key of ALLOWED_ENV_VARS) {
    const value = process.env[key];
    if (value && value.trim().length > 0) {
      secrets[key] = value;
    }
  }

  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    for (const line of envContent.split('\n')) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      const [key, value] = parsed;
      if (!ALLOWED_ENV_VARS.includes(key)) continue;
      if (!secrets[key] && value.trim().length > 0) {
        secrets[key] = value;
      }
    }
  }

  // Auto-inject git identity from Matrix username so commits are attributed to the bot
  const botName = secrets['ASSISTANT_NAME'];
  const matrixUser = process.env['MATRIX_USERNAME'];
  if (botName) {
    const displayName = botName.charAt(0).toUpperCase() + botName.slice(1).toLowerCase();
    const email = matrixUser ? `${matrixUser}@a-gis.org` : `${botName.toLowerCase()}@a-gis.org`;
    if (!secrets['GIT_AUTHOR_NAME']) secrets['GIT_AUTHOR_NAME'] = displayName;
    if (!secrets['GIT_AUTHOR_EMAIL']) secrets['GIT_AUTHOR_EMAIL'] = email;
    if (!secrets['GIT_COMMITTER_NAME']) secrets['GIT_COMMITTER_NAME'] = displayName;
    if (!secrets['GIT_COMMITTER_EMAIL']) secrets['GIT_COMMITTER_EMAIL'] = email;
  }

  return secrets;
}

function redactSecrets(
  secrets: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!secrets || Object.keys(secrets).length === 0) return undefined;
  return Object.fromEntries(
    Object.keys(secrets).map((k) => [k, '[REDACTED]']),
  );
}

function quoteEnvValue(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  normalizedSecrets: Record<string, string>,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();

  if (isMain) {
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/persona/temp',
      readonly: false,
    });
  } else {
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/persona/temp',
      readonly: false,
    });
  }

  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')); } catch { /* new file */ }
  settings.env = {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    ...((settings.env as Record<string, string>) || {}),
  };
  settings.enableAllProjectMcpServers = true;
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');

  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  const envDir = path.join(DATA_DIR, 'env');
  fs.mkdirSync(envDir, { recursive: true });
  const filteredLines = Object.entries(normalizedSecrets)
    .filter(([key, value]) => ALLOWED_ENV_VARS.includes(key) && value.trim().length > 0)
    .map(([key, value]) => `${key}=${quoteEnvValue(value)}`);

  if (filteredLines.length > 0) {
    fs.writeFileSync(path.join(envDir, 'env'), filteredLines.join('\n') + '\n');
    mounts.push({
      hostPath: envDir,
      containerPath: '/workspace/env-dir',
      readonly: true,
    });
  }

  // InfiniClaw additional volume mounts
  const extraMounts = buildInfiniClawMounts({
    group,
    isMain,
    groupSessionsDir,
    groupsDir: GROUPS_DIR,
    dataDir: DATA_DIR,
    projectRoot,
  });
  mounts.push(...extraMounts);

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  portPublish: string[] = [],
  memoryMb?: number,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--network', 'host', '--name', containerName];

  args.push('--pull=never');

  const hostUid = process.getuid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--userns=keep-id', '-e', 'HOME=/home/node');
  }

  const effectiveMemoryMb = memoryMb && memoryMb > 0 ? memoryMb : CONTAINER_MEMORY_MB;
  if (effectiveMemoryMb > 0) {
    args.push('--memory', `${effectiveMemoryMb}m`);
    // Soft limit: kernel reclaims memory more aggressively past this threshold
    if (CONTAINER_MEMORY_RESERVATION_MB > 0 && CONTAINER_MEMORY_RESERVATION_MB < effectiveMemoryMb) {
      args.push('--memory-reservation', `${CONTAINER_MEMORY_RESERVATION_MB}m`);
    }
  }
  if (CONTAINER_CPUS > 0) {
    args.push('--cpus', String(CONTAINER_CPUS));
  }

  // V8 heap limit inside container — triggers GC before cgroup hard kill
  if (CONTAINER_HEAP_LIMIT_MB > 0) {
    args.push('-e', `NODE_OPTIONS=--max-old-space-size=${CONTAINER_HEAP_LIMIT_MB}`);
  }
  for (const mount of mounts) {
    args.push(
      '-v',
      `${mount.hostPath}:${mount.containerPath}${mount.readonly ? ':ro' : ''}`,
    );
  }
  for (const p of portPublish) {
    args.push('-p', p);
  }

  // Inject CONTAINER_ENV_* as container environment variables
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('CONTAINER_ENV_') && value) {
      const envName = key.slice('CONTAINER_ENV_'.length);
      if (!SAFE_ENV_NAME.test(envName)) {
        logger.warn({ key }, 'Skipping invalid CONTAINER_ENV_* name');
        continue;
      }
      args.push('-e', `${envName}=${value}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

function killExistingContainersForGroup(botTag: string, safeName: string): void {
  const prefix = `nanoclaw-${botTag}-${safeName}-`;
  const stopped = stopContainersByPrefix(prefix);
  for (const name of stopped) {
    logger.info({ name }, 'Killed stale container for same bot/group before spawn');
  }
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  assertValidGroupFolder(group.folder);

  // Pre-flight: verify podman is reachable, recover if not
  try {
    execSync('podman info', { stdio: 'pipe', timeout: 5000 });
  } catch {
    if (!recoverPodman()) {
      return { status: 'error', result: null, error: 'Podman unavailable and recovery failed' };
    }
  }

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  const projectRoot = process.cwd();

  // Expose DB path (as container-side path) so the in-container MCP server can do direct DB lookups.
  // The home dir is mounted ro at its real host path (e.g. /Users/ww5 → /Users/ww5), so the
  // container-side path is identical to the host path — no remapping needed.
  const hostDbPath = path.join(STORE_DIR, 'messages.db');
  process.env.NANOCLAW_DB_PATH = hostDbPath;

  const secrets = normalizeProviderSecrets(collectContainerSecrets(projectRoot));
  const mounts = buildVolumeMounts(group, input.isMain, secrets);
  const mappedSecrets = mapCertPathSecretsToContainer(secrets, mounts);

  // Remap INFINICLAW_ROOT from host path to container-side path
  const hostRoot = mappedSecrets['INFINICLAW_ROOT'];
  if (hostRoot) {
    const resolvedRoot = fs.existsSync(hostRoot) ? fs.realpathSync(hostRoot) : hostRoot;
    const rootMount = mounts.find((m) => {
      const resolvedMount = fs.existsSync(m.hostPath) ? fs.realpathSync(m.hostPath) : m.hostPath;
      return resolvedMount === resolvedRoot;
    });
    if (rootMount) {
      mappedSecrets['INFINICLAW_ROOT'] = rootMount.containerPath;
    }
  }

  // Write bot directory to IPC dir so the MCP server can resolve recipients
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  try {
    const botDir = buildBotDirectory();
    fs.writeFileSync(path.join(groupIpcDir, 'bot_directory.json'), JSON.stringify(botDir));
  } catch (err) { logger.warn({ err }, 'Failed to write bot directory to IPC'); }

  // Read .mcp.json from persona for SDK passthrough (single source of truth)
  const rootDir = process.env.INFINICLAW_ROOT;
  const personaName = process.env.PERSONA_NAME;
  const role = (process.env.ASSISTANT_ROLE || '').toLowerCase();
  const roleDir = rootDir && role ? path.join(rootDir, 'bots', role) : undefined;
  let mcpServers = roleDir ? readPersonaGroupMcpServers(roleDir) : undefined;

  const containerNameTag = input.containerNameTag?.trim();
  const safeContainerNameTag = containerNameTag && SAFE_CONTAINER_NAME_TAG.test(containerNameTag)
    ? containerNameTag
    : undefined;
  if (containerNameTag && !safeContainerNameTag) {
    logger.warn({ containerNameTag }, 'Ignoring invalid containerNameTag');
  }

  const effectiveInput: ContainerInput & { disallowedTools?: string[] } = {
    ...input,
    groupFolder: group.folder,
    ...(safeContainerNameTag ? { containerNameTag: safeContainerNameTag } : {}),
    disallowedTools: ['SendMessage', 'TeamCreate', 'TeamDelete', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'],
    ...(Object.keys(mappedSecrets).length > 0 ? { secrets: mappedSecrets } : {}),
    ...(mcpServers ? { mcpServers } : {}),
  };

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const botTag = (ASSISTANT_NAME || 'bot').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const nameTag = safeContainerNameTag ? `-${safeContainerNameTag}` : '';
  const containerName = `nanoclaw-${botTag}-${safeName}${nameTag}-${Date.now()}`;
  if (!safeContainerNameTag) {
    killExistingContainersForGroup(botTag, safeName);
  }

  const personaContainerConfig = getPersonaContainerConfig();
  const portPublish = safeContainerNameTag ? [] : personaContainerConfig.portPublish;
  const containerArgs = buildContainerArgs(mounts, containerName, portPublish, personaContainerConfig.memoryMb);
  const configTimeout = input.timeoutOverrideMs || group.containerConfig?.timeout || CONTAINER_TIMEOUT;
  const timeoutMinutes = Math.round(configTimeout / 60_000);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      runtime: 'podman',
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const redactedInputForLog: ContainerInput = {
    ...effectiveInput,
    secrets: redactSecrets(effectiveInput.secrets),
  };

  const mountLogLines = mounts.map(
    (m) => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
  );
  const mountSummaryLines = mounts.map(
    (m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
  );

  return runContainer({
    runtime: 'podman',
    args: containerArgs,
    stdinData: effectiveInput,
    groupName: group.name,
    groupFolder: group.folder,
    containerName,
    logsDir: path.join(GROUPS_DIR, group.folder, 'logs'),
    configTimeout,
    idleTimeout: IDLE_TIMEOUT,
    maxOutputSize: CONTAINER_MAX_OUTPUT_SIZE,
    onProcess,
    onOutput,
    stopCommand: `podman stop "${containerName}"`,
    logInput: redactedInputForLog,
    verboseLogExtras: [
      `=== Container Args ===`,
      containerArgs.join(' '),
      ``,
      `=== Mounts ===`,
      mountLogLines.join('\n'),
      ``,
    ],
    summaryLogExtras: [
      `=== Input Summary ===`,
      `Prompt length: ${effectiveInput.prompt.length} chars`,
      `Session ID: ${effectiveInput.sessionId || 'new'}`,
      ``,
      `=== Mounts ===`,
      mountSummaryLines.join('\n'),
      ``,
    ],
    timeoutErrorMessage: `Task timed out after ${timeoutMinutes} minutes with no response. Try again or simplify the request.`,
    outputChainTimeoutMs: 30_000,
    maxErrorStderrChars: 0,
    firstOutputDeadlineMs: 300_000,
  });
}
