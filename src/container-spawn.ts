/**
 * InfiniClaw container runner.
 * Prepares InfiniClaw-specific mounts, secrets, and config, then delegates
 * the spawn lifecycle to upstream's composable runContainer().
 *
 * Re-exports writeTasksSnapshot, writeGroupsSnapshot from upstream's container-runner
 * so callers don't need to know which module provides them.
 */
import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { parseEnvLine } from './env-utils.js';
import { capitalizeName } from './formatting.js';
import { envInt } from './utils.js';
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
import { botTag, canReachPodmanApi, recoverPodman, stopContainer, stopContainersByPrefix } from './podman-utils.js';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  STORE_DIR,
  IDLE_TIMEOUT,
} from 'nanoclaw/config.js';
import { logger } from 'nanoclaw/logger.js';
import type { RegisteredGroup } from 'nanoclaw/types.js';
import type { ContainerInput, ContainerOutput } from 'nanoclaw/container-runner.js';
import { runContainer, type VolumeMount } from './run-container.js';

// Re-export upstream utilities that main.ts needs
export { writeTasksSnapshot, writeGroupsSnapshot } from 'nanoclaw/container-runner.js';
export type { ContainerOutput, ContainerInput } from 'nanoclaw/container-runner.js';

// ── Config ──────────────────────────────────────────────────────────

const CONTAINER_CPUS = parseFloat(process.env.CONTAINER_CPUS || '0');
const CONTAINER_MEMORY_MB = envInt('CONTAINER_MEMORY_MB', 0);
const CONTAINER_MEMORY_RESERVATION_MB = envInt('CONTAINER_MEMORY_RESERVATION_MB', 0);
const CONTAINER_HEAP_LIMIT_MB = envInt('CONTAINER_HEAP_LIMIT_MB', 0);

const SAFE_CONTAINER_NAME_TAG = /^[a-zA-Z0-9_.-]{1,32}$/;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ALLOWED_ENV_VARS = [
  'ASSISTANT_NAME', 'ASSISTANT_ROLE', 'IsChief',
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'NANOCLAW_SKIP_TOKEN_COUNTING',
  'NANOCLAW_CONTEXT_WINDOW', 'NANOCLAW_DB_PATH', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'OLLAMA_HOST', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'INFINICLAW_ROOT', 'PERSONA_NAME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
];

// ── Secret collection ───────────────────────────────────────────────

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
    for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      const [key, value] = parsed;
      if (ALLOWED_ENV_VARS.includes(key) && !secrets[key] && value.trim().length > 0) {
        secrets[key] = value;
      }
    }
  }

  // Auto-inject git identity so commits are attributed to the bot
  const name = secrets['ASSISTANT_NAME'];
  const matrixUser = process.env['MATRIX_USERNAME'];
  if (name) {
    const displayName = capitalizeName(name);
    const email = matrixUser ? `${matrixUser}@a-gis.org` : `${name.toLowerCase()}@a-gis.org`;
    if (!secrets['GIT_AUTHOR_NAME']) secrets['GIT_AUTHOR_NAME'] = displayName;
    if (!secrets['GIT_AUTHOR_EMAIL']) secrets['GIT_AUTHOR_EMAIL'] = email;
    if (!secrets['GIT_COMMITTER_NAME']) secrets['GIT_COMMITTER_NAME'] = displayName;
    if (!secrets['GIT_COMMITTER_EMAIL']) secrets['GIT_COMMITTER_EMAIL'] = email;
  }

  return secrets;
}

function redactSecrets(secrets: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!secrets || Object.keys(secrets).length === 0) return undefined;
  return Object.fromEntries(Object.keys(secrets).map((k) => [k, '[REDACTED]']));
}

// ── Volume mounts ───────────────────────────────────────────────────

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

  // Project root — rw for engineers (they need to edit code), ro for others
  if (isMain) {
    const role = (normalizedSecrets.ASSISTANT_ROLE || process.env.ASSISTANT_ROLE || '').toLowerCase();
    const projectReadonly = role !== 'engineer';
    mounts.push({ hostPath: projectRoot, containerPath: '/workspace/project', readonly: projectReadonly });
  }
  mounts.push({
    hostPath: path.join(GROUPS_DIR, group.folder),
    containerPath: '/workspace/persona/temp',
    readonly: false,
  });

  // Claude Code session state
  const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
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
  mounts.push({ hostPath: groupSessionsDir, containerPath: '/home/node/.claude', readonly: false });

  // IPC namespace
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({ hostPath: groupIpcDir, containerPath: '/workspace/ipc', readonly: false });

  // Env file mount
  const envDir = path.join(DATA_DIR, 'env');
  fs.mkdirSync(envDir, { recursive: true });
  const filteredLines = Object.entries(normalizedSecrets)
    .filter(([key, value]) => ALLOWED_ENV_VARS.includes(key) && value.trim().length > 0)
    .map(([key, value]) => `${key}=${quoteEnvValue(value)}`);
  if (filteredLines.length > 0) {
    fs.writeFileSync(path.join(envDir, 'env'), filteredLines.join('\n') + '\n');
    mounts.push({ hostPath: envDir, containerPath: '/workspace/env-dir', readonly: true });
  }

  // InfiniClaw additional mounts (persona, memory, cache, ssh, home ro, allowlist)
  mounts.push(...buildInfiniClawMounts({
    group, isMain, groupSessionsDir, groupsDir: GROUPS_DIR, dataDir: DATA_DIR, projectRoot,
    secrets: normalizedSecrets,
  }));

  return mounts;
}

// ── Container args ──────────────────────────────────────────────────

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  portPublish: string[] = [],
  memoryMb?: number,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--network', 'host', '--name', containerName, '--pull=never'];

  const hostUid = process.getuid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--userns=keep-id', '-e', 'HOME=/home/node');
  }

  const effectiveMemoryMb = memoryMb && memoryMb > 0 ? memoryMb : CONTAINER_MEMORY_MB;
  if (effectiveMemoryMb > 0) {
    args.push('--memory', `${effectiveMemoryMb}m`);
    if (CONTAINER_MEMORY_RESERVATION_MB > 0 && CONTAINER_MEMORY_RESERVATION_MB < effectiveMemoryMb) {
      args.push('--memory-reservation', `${CONTAINER_MEMORY_RESERVATION_MB}m`);
    }
  }
  if (CONTAINER_CPUS > 0) args.push('--cpus', String(CONTAINER_CPUS));
  if (CONTAINER_HEAP_LIMIT_MB > 0) args.push('-e', `NODE_OPTIONS=--max-old-space-size=${CONTAINER_HEAP_LIMIT_MB}`);

  for (const mount of mounts) {
    args.push('-v', `${mount.hostPath}:${mount.containerPath}${mount.readonly ? ':ro' : ''}`);
  }
  for (const p of portPublish) args.push('-p', p);

  // Inject CONTAINER_ENV_* as container environment variables (prefix stripped)
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('CONTAINER_ENV_') && value) {
      const envName = key.slice('CONTAINER_ENV_'.length);
      if (!SAFE_ENV_NAME.test(envName)) { logger.warn({ key }, 'Skipping invalid CONTAINER_ENV_* name'); continue; }
      args.push('-e', `${envName}=${value}`);
    }
  }

  args.push(CONTAINER_IMAGE);
  return args;
}

// ── Pre-flight ──────────────────────────────────────────────────────

function preflightPodman(): ContainerOutput | null {
  if (!canReachPodmanApi() && !recoverPodman()) {
    return { status: 'error', result: null, error: 'Podman unavailable and recovery failed' };
  }
  return null;
}

// ── Path remapping ──────────────────────────────────────────────────

function remapInfiniClawRoot(secrets: Record<string, string>, mounts: VolumeMount[]): void {
  const hostRoot = secrets['INFINICLAW_ROOT'];
  if (!hostRoot) return;
  const resolvedRoot = fs.existsSync(hostRoot) ? fs.realpathSync(hostRoot) : hostRoot;
  const rootMount = mounts.find((m) => {
    const resolved = fs.existsSync(m.hostPath) ? fs.realpathSync(m.hostPath) : m.hostPath;
    return resolved === resolvedRoot;
  });
  if (rootMount) secrets['INFINICLAW_ROOT'] = rootMount.containerPath;
}

// ── IPC setup ───────────────────────────────────────────────────────

function writeBotDirectoryToIpc(groupFolder: string): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  try {
    fs.writeFileSync(path.join(groupIpcDir, 'bot_directory.json'), JSON.stringify(buildBotDirectory()));
  } catch (err) { logger.warn({ err }, 'Failed to write bot directory to IPC'); }
}

// ── Container name + stale cleanup ──────────────────────────────────

function resolveContainerName(
  group: RegisteredGroup,
  containerNameTag?: string,
): { containerName: string; safeContainerNameTag?: string } {
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const tag = containerNameTag?.trim();
  const safeTag = tag && SAFE_CONTAINER_NAME_TAG.test(tag) ? tag : undefined;
  if (tag && !safeTag) logger.warn({ containerNameTag: tag }, 'Ignoring invalid containerNameTag');

  const nameTag = safeTag ? `-${safeTag}` : '';
  const containerName = `nanoclaw-${botTag()}-${safeName}${nameTag}`;

  // Stop existing container with this exact name before respawning
  stopContainer(containerName);
  // Also clean up legacy timestamped containers (nanoclaw-bot-group-<timestamp>)
  const legacyPrefix = `${containerName}-`;
  const stopped = stopContainersByPrefix(legacyPrefix);
  for (const name of stopped) logger.info({ name }, 'Killed legacy timestamped container');

  return { containerName, safeContainerNameTag: safeTag };
}

// ── MCP servers ─────────────────────────────────────────────────────

function resolveMcpServers(): Record<string, Record<string, unknown>> | undefined {
  const rootDir = process.env.INFINICLAW_ROOT;
  const role = (process.env.ASSISTANT_ROLE || '').toLowerCase();
  const roleDir = rootDir && role ? path.join(rootDir, 'bots', role) : undefined;
  return roleDir ? readPersonaGroupMcpServers(roleDir) : undefined;
}

// ── Main orchestrator ───────────────────────────────────────────────

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  assertValidGroupFolder(group.folder);

  const preflight = preflightPodman();
  if (preflight) return preflight;

  fs.mkdirSync(path.join(GROUPS_DIR, group.folder), { recursive: true });
  process.env.NANOCLAW_DB_PATH = path.join(STORE_DIR, 'messages.db');

  // Collect and normalize secrets, build mounts, remap paths
  const secrets = normalizeProviderSecrets(collectContainerSecrets(process.cwd()));
  const mounts = buildVolumeMounts(group, input.isMain, secrets);
  const mappedSecrets = mapCertPathSecretsToContainer(secrets, mounts);
  remapInfiniClawRoot(mappedSecrets, mounts);

  writeBotDirectoryToIpc(group.folder);

  // Assemble effective input
  const { containerName, safeContainerNameTag } = resolveContainerName(group, input.containerNameTag);
  const mcpServers = resolveMcpServers();
  const effectiveInput: ContainerInput & { disallowedTools?: string[] } = {
    ...input,
    groupFolder: group.folder,
    ...(safeContainerNameTag ? { containerNameTag: safeContainerNameTag } : {}),
    disallowedTools: ['SendMessage', 'TeamCreate', 'TeamDelete', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'CronCreate', 'CronDelete', 'CronList', 'NotebookEdit', 'TodoWrite'],
    ...(Object.keys(mappedSecrets).length > 0 ? { secrets: mappedSecrets } : {}),
    ...(mcpServers ? { mcpServers } : {}),
  };

  // Build container args
  const personaConfig = getPersonaContainerConfig();
  const portPublish = safeContainerNameTag ? [] : personaConfig.portPublish;
  const containerArgs = buildContainerArgs(mounts, containerName, portPublish, personaConfig.memoryMb);
  const configTimeout = input.timeoutOverrideMs || group.containerConfig?.timeout || CONTAINER_TIMEOUT;

  logger.debug({
    group: group.name, containerName,
    mounts: mounts.map((m) => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`),
    containerArgs: containerArgs.join(' '),
  }, 'Container mount configuration');

  logger.info({
    group: group.name, containerName, runtime: 'podman', mountCount: mounts.length, isMain: input.isMain,
  }, 'Spawning container agent');

  // Delegate to run loop
  const mountFmt = (detail: boolean) => mounts.map(
    (m) => detail ? `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}` : `${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
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
    logInput: { ...effectiveInput, secrets: redactSecrets(effectiveInput.secrets) },
    verboseLogExtras: [`=== Container Args ===`, containerArgs.join(' '), ``, `=== Mounts ===`, mountFmt(true).join('\n'), ``],
    summaryLogExtras: [`=== Input Summary ===`, `Prompt length: ${effectiveInput.prompt.length} chars`, `Session ID: ${effectiveInput.sessionId || 'new'}`, ``, `=== Mounts ===`, mountFmt(false).join('\n'), ``],
    timeoutErrorMessage: `Task timed out after ${Math.round(configTimeout / 60_000)} minutes with no response. Try again or simplify the request.`,
    outputChainTimeoutMs: 30_000,
    maxErrorStderrChars: 0,
    firstOutputDeadlineMs: 300_000,
  });
}
