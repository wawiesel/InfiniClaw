/**
 * InfiniClaw container runner.
 * Forks upstream's runContainerAgent() with InfiniClaw mounts/secrets baked in.
 *
 * Re-exports writeTasksSnapshot, writeGroupsSnapshot from upstream's container-runner
 * so callers don't need to know which module provides them.
 */
import { ChildProcess, exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseEnvLine } from 'nanoclaw/env-utils.js';
import {
  buildBotDirectory,
  buildInfiniClawMounts,
  getPersonaPortPublish,
  readGroupMcpServers,
} from './container-mounts.js';
import {
  normalizeProviderSecrets,
  mapCertPathSecretsToContainer,
} from './container-secrets.js';
import { recoverPodman, stopContainersByPrefix } from 'nanoclaw/podman-utils.js';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_CPUS,
  CONTAINER_MEMORY_MB,
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

// Re-export upstream utilities that main.ts needs
export { writeTasksSnapshot, writeGroupsSnapshot } from 'nanoclaw/container-runner.js';
export type { ContainerOutput, ContainerInput } from 'nanoclaw/container-runner.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

const ALLOWED_ENV_VARS = [
  'ASSISTANT_NAME',
  'ASSISTANT_ROLE',
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
];

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
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
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

function buildContainerArgs(mounts: VolumeMount[], containerName: string, portPublish: string[] = []): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  args.push('--pull=never');

  const hostUid = process.getuid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--userns=keep-id', '-e', 'HOME=/home/node');
  }

  if (CONTAINER_MEMORY_MB > 0) {
    args.push('--memory', `${CONTAINER_MEMORY_MB}m`);
  }
  if (CONTAINER_CPUS > 0) {
    args.push('--cpus', String(CONTAINER_CPUS));
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
  // Pre-flight: verify podman is reachable, recover if not
  try {
    execSync('podman info', { stdio: 'pipe', timeout: 5000 });
  } catch {
    if (!recoverPodman()) {
      return { status: 'error', result: null, error: 'Podman unavailable and recovery failed' };
    }
  }

  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  const projectRoot = process.cwd();
  // Expose DB path (as container-side path) so the in-container MCP server can do direct DB lookups
  const hostDbPath = path.join(STORE_DIR, 'messages.db');
  const homeDir = os.homedir();
  const containerDbPath = hostDbPath.startsWith(homeDir + path.sep)
    ? path.join('/workspace/extra/home', hostDbPath.slice(homeDir.length + 1))
    : hostDbPath;
  process.env.NANOCLAW_DB_PATH = containerDbPath;
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
  const groupIpcDir = path.join(DATA_DIR, 'ipc', input.groupFolder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  try {
    const botDir = buildBotDirectory();
    fs.writeFileSync(path.join(groupIpcDir, 'bot_directory.json'), JSON.stringify(botDir));
  } catch { /* best effort */ }

  // Read .mcp.json from group dir for inline SDK passthrough
  const mcpServers = readGroupMcpServers(groupDir);
  const effectiveInput: ContainerInput & { disallowedTools?: string[] } = {
    ...input,
    disallowedTools: ['SendMessage', 'TeamCreate', 'TeamDelete'],
    ...(Object.keys(mappedSecrets).length > 0 ? { secrets: mappedSecrets } : {}),
    ...(mcpServers ? { mcpServers } : {}),
  };
  const redactedInputForLog: ContainerInput = {
    ...effectiveInput,
    secrets: redactSecrets(effectiveInput.secrets),
  };
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const botTag = (ASSISTANT_NAME || 'bot').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const containerName = `nanoclaw-${botTag}-${safeName}-${Date.now()}`;
  killExistingContainersForGroup(botTag, safeName);
  // Read portPublish from persona container-config.json
  const portPublish = getPersonaPortPublish();
  const containerArgs = buildContainerArgs(mounts, containerName, portPublish);

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

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn('podman', containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(effectiveInput));
    container.stdin.end();

    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, containerName }, 'Container timeout, stopping gracefully');
      exec(`podman stop "${containerName}"`, { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn({ group: group.name, containerName, err }, 'Graceful stop failed, force killing');
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(timeoutLog, [
          `=== Container Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Container: ${containerName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Had Streaming Output: ${hadStreamingOutput}`,
        ].join('\n'));

        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          const chainTimer = setTimeout(() => {
            logger.warn(
              { group: group.name, containerName },
              'outputChain stalled 30s after container close, force-resolving',
            );
            resolve({ status: 'success', result: null, newSessionId });
          }, 30_000);
          outputChain
            .then(() => {
              clearTimeout(chainTimer);
              resolve({ status: 'success', result: null, newSessionId });
            })
            .catch((err) => {
              clearTimeout(chainTimer);
              logger.error(
                { group: group.name, err },
                'outputChain rejected after container close',
              );
              resolve({ status: 'success', result: null, newSessionId });
            });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        const timeoutMinutes = Math.round(configTimeout / 60_000);
        resolve({
          status: 'error',
          result: null,
          error: `Task timed out after ${timeoutMinutes} minutes with no response. Try again or simplify the request.`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(redactedInputForLog, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${effectiveInput.prompt.length} chars`,
          `Session ID: ${effectiveInput.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle
      if (onOutput) {
        const chainTimer = setTimeout(() => {
          logger.warn(
            { group: group.name, containerName, duration },
            'outputChain stalled 30s after container close, force-resolving',
          );
          resolve({ status: 'success', result: null, newSessionId });
        }, 30_000);
        outputChain
          .then(() => {
            clearTimeout(chainTimer);
            logger.info(
              { group: group.name, duration, newSessionId },
              'Container completed (streaming mode)',
            );
            resolve({ status: 'success', result: null, newSessionId });
          })
          .catch((err) => {
            clearTimeout(chainTimer);
            logger.error(
              { group: group.name, err },
              'outputChain rejected after container close',
            );
            resolve({ status: 'success', result: null, newSessionId });
          });
        return;
      }

      // Legacy mode: parse the last output marker pair
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, containerName, error: err }, 'Container spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}
