/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC.
 *
 * Exports composable utilities (runContainer, parseOutputMarkers, VolumeMount)
 * so downstream consumers (InfiniClaw) can build their own mounts/args and
 * delegate the spawn lifecycle to the shared run loop.
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { CONTAINER_RUNTIME_BIN, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function getHomeDir(): string {
  const home = process.env.HOME || os.homedir();
  if (!home) {
    throw new Error(
      'Unable to determine home directory: HOME environment variable is not set and os.homedir() returned empty',
    );
  }
  return home;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
  mcpServers?: Record<string, Record<string, unknown>>;
  /** Optional tag for parallel containers (e.g. 'interrupt'). Prevents killing existing containers for the same group. */
  containerNameTag?: string;
  /** Override the group/config timeout for this specific container run (ms). */
  timeoutOverrideMs?: number;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  isProgress?: boolean;
  newSessionId?: string;
  model?: string;
  error?: string;
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

// ── Composable utilities ────────────────────────────────────────────────

/**
 * Parse all complete output marker pairs from a buffer.
 * Returns parsed ContainerOutput objects and the remaining unparsed buffer.
 */
export function parseOutputMarkers(
  buffer: string,
): { outputs: ContainerOutput[]; remaining: string } {
  const outputs: ContainerOutput[] = [];
  let remaining = buffer;
  let startIdx: number;
  while ((startIdx = remaining.indexOf(OUTPUT_START_MARKER)) !== -1) {
    const endIdx = remaining.indexOf(OUTPUT_END_MARKER, startIdx);
    if (endIdx === -1) break;
    const jsonStr = remaining
      .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
      .trim();
    remaining = remaining.slice(endIdx + OUTPUT_END_MARKER.length);
    try {
      outputs.push(JSON.parse(jsonStr));
    } catch {
      // Skip malformed output
    }
  }
  return { outputs, remaining };
}

/**
 * Options for the composable container run loop.
 */
export interface RunContainerOpts {
  /** Container runtime binary (e.g., 'podman', 'docker') */
  runtime: string;
  /** Full args array for the container runtime */
  args: string[];
  /** Object to write to container stdin as JSON */
  stdinData: unknown;
  /** Group name for logging */
  groupName: string;
  /** Group folder for stderr debug label */
  groupFolder: string;
  /** Container name */
  containerName: string;
  /** Directory to write container run logs */
  logsDir: string;
  /** Per-group timeout from config (ms) */
  configTimeout: number;
  /** Idle timeout (ms) — used to compute minimum hard timeout */
  idleTimeout: number;
  /** Max accumulated stdout/stderr before truncation (bytes) */
  maxOutputSize: number;
  /** Called when the container process starts */
  onProcess: (proc: ChildProcess, containerName: string) => void;
  /** Called for each streamed output marker */
  onOutput?: (output: ContainerOutput) => Promise<void>;
  /** Shell command to stop the container gracefully on timeout */
  stopCommand: string;
  /** Input object to write in logs (may be redacted). Defaults to stdinData */
  logInput?: unknown;
  /** Extra log lines for verbose/error mode */
  verboseLogExtras?: string[];
  /** Summary log lines for non-verbose mode */
  summaryLogExtras?: string[];
  /** Custom timeout error message. Default: "Container timed out after {configTimeout}ms" */
  timeoutErrorMessage?: string;
  /** Timeout (ms) to force-resolve a stalled outputChain. 0 = no limit. Default: 0 */
  outputChainTimeoutMs?: number;
  /** Max stderr chars in error result. 0 = unlimited. Default: 200 */
  maxErrorStderrChars?: number;
  /** Kill container if no stdout data arrives within this many ms after spawn. 0 = disabled. Default: 0 */
  firstOutputDeadlineMs?: number;
}

/**
 * Composable container run loop.
 * Spawns a container, handles streaming output, timeout, and close.
 * Both NanoClaw and InfiniClaw use this after building their own mounts/args.
 */
export function runContainer(opts: RunContainerOpts): Promise<ContainerOutput> {
  const startTime = Date.now();
  fs.mkdirSync(opts.logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(opts.runtime, opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    opts.onProcess(container, opts.containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(opts.stdinData));
    container.stdin.end();

    // Timeout state (declared before stdout handler so callbacks can access it)
    let timedOut = false;
    let hadStreamingOutput = false;
    let firstOutputReceived = false;
    const timeoutMs = Math.max(opts.configTimeout, opts.idleTimeout + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: opts.groupName, containerName: opts.containerName },
        'Container timeout, stopping gracefully',
      );
      exec(opts.stopCommand, { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: opts.groupName, containerName: opts.containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    // First-output deadline: kill early if container produces zero stdout
    const foDeadlineMs = opts.firstOutputDeadlineMs ?? 0;
    let firstOutputTimer: ReturnType<typeof setTimeout> | null = null;
    if (foDeadlineMs > 0) {
      firstOutputTimer = setTimeout(() => {
        if (!firstOutputReceived) {
          logger.error(
            { group: opts.groupName, containerName: opts.containerName, deadlineMs: foDeadlineMs },
            'Container produced no output within first-output deadline, killing',
          );
          killOnTimeout();
        }
      }, foDeadlineMs);
    }

    // Streaming output state
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let firstOutputLogged = false;

    container.stdout.on('data', (data) => {
      if (!firstOutputReceived) {
        firstOutputReceived = true;
        if (firstOutputTimer) { clearTimeout(firstOutputTimer); firstOutputTimer = null; }
      }
      if (!firstOutputLogged) {
        firstOutputLogged = true;
        const ttfoMs = Date.now() - startTime;
        logger.info(
          { group: opts.groupName, containerName: opts.containerName, ttfoMs },
          'Time to first output',
        );
      }
      const chunk = data.toString();

      // Accumulate for logging
      if (!stdoutTruncated) {
        const remaining = opts.maxOutputSize - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: opts.groupName, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (opts.onOutput) {
        parseBuffer += chunk;
        const { outputs, remaining } = parseOutputMarkers(parseBuffer);
        parseBuffer = remaining;
        for (const parsed of outputs) {
          if (parsed.newSessionId) {
            newSessionId = parsed.newSessionId;
          }
          hadStreamingOutput = true;
          resetTimeout();
          outputChain = outputChain.then(() => opts.onOutput!(parsed));
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: opts.groupFolder }, line);
      }
      if (stderrTruncated) return;
      const remaining = opts.maxOutputSize - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: opts.groupName, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    // Helper: resolve outputChain with optional stall timer
    const settleOutputChain = (cb: () => void) => {
      const chainTimeoutMs = opts.outputChainTimeoutMs ?? 0;
      if (chainTimeoutMs > 0) {
        const chainTimer = setTimeout(() => {
          logger.warn(
            { group: opts.groupName, containerName: opts.containerName },
            'outputChain stalled after container close, force-resolving',
          );
          cb();
        }, chainTimeoutMs);
        outputChain
          .then(() => {
            clearTimeout(chainTimer);
            cb();
          })
          .catch((err) => {
            clearTimeout(chainTimer);
            logger.error(
              { group: opts.groupName, err },
              'outputChain rejected after container close',
            );
            cb();
          });
      } else {
        outputChain.then(() => cb());
      }
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      if (firstOutputTimer) { clearTimeout(firstOutputTimer); firstOutputTimer = null; }
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(opts.logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${opts.groupName}`,
            `Container: ${opts.containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        if (hadStreamingOutput) {
          logger.info(
            { group: opts.groupName, containerName: opts.containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          settleOutputChain(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        logger.error(
          { group: opts.groupName, containerName: opts.containerName, duration, code },
          'Container timed out with no output',
        );

        const errorMsg =
          opts.timeoutErrorMessage ??
          `Container timed out after ${opts.configTimeout}ms`;
        resolve({ status: 'error', result: null, error: errorMsg });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(opts.logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' ||
        process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${opts.groupName}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;
      const logInputObj = opts.logInput ?? opts.stdinData;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(logInputObj, null, 2),
          ``,
        );
        if (opts.verboseLogExtras) {
          logLines.push(...opts.verboseLogExtras);
        }
        logLines.push(
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        if (opts.summaryLogExtras) {
          logLines.push(...opts.summaryLogExtras);
        }
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        // Map well-known signal-based exit codes to human-readable descriptions
        const signalExits: Record<number, { signal: string; label: string }> = {
          137: { signal: 'SIGKILL', label: '⚠️ OOM KILLED — Container ran out of memory' },
          139: { signal: 'SIGSEGV', label: '⚠️ SEGFAULT — Container crashed (segmentation fault)' },
          134: { signal: 'SIGABRT', label: '⚠️ ABORTED — Container aborted' },
          143: { signal: 'SIGTERM', label: 'Container was terminated' },
        };

        const signalInfo = signalExits[code ?? -1];
        const isOomKill = code === 137;

        // If streaming output was already delivered, the crash happened during
        // cleanup or while waiting for more IPC input — treat as success.
        if (hadStreamingOutput) {
          logger.warn(
            {
              group: opts.groupName,
              code,
              duration,
              ...(signalInfo ? { signal: signalInfo.signal, isOomKill } : {}),
            },
            'Container crashed after streaming output was delivered, treating as success',
          );
          settleOutputChain(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        logger.error(
          {
            group: opts.groupName,
            code,
            duration,
            stderr,
            stdout,
            logFile,
            ...(signalInfo ? { signal: signalInfo.signal, isOomKill } : {}),
          },
          signalInfo ? signalInfo.label : 'Container exited with error',
        );

        let errorMsg: string;
        if (signalInfo) {
          const durationSec = Math.round(duration / 1000);
          errorMsg = `${signalInfo.label} (exit ${code}, ${signalInfo.signal}, ${durationSec}s)`;
        } else {
          const maxChars = opts.maxErrorStderrChars ?? 200;
          const stderrSnippet =
            maxChars > 0 ? stderr.slice(-maxChars) : stderr;
          errorMsg = `Container exited with code ${code}: ${stderrSnippet}`;
        }

        resolve({
          status: 'error',
          result: null,
          error: errorMsg,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle
      if (opts.onOutput) {
        settleOutputChain(() => {
          logger.info(
            { group: opts.groupName, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
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
            group: opts.groupName,
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
            group: opts.groupName,
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
      logger.error(
        { group: opts.groupName, containerName: opts.containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

// ── NanoClaw built-in runner ────────────────────────────────────────────

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const homeDir = getHomeDir();
  const projectRoot = process.cwd();

  if (isMain) {
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
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
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
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

  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({
    hostPath: agentRunnerSrc,
    containerPath: '/app/src',
    readonly: true,
  });

  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
}

function buildContainerArgs(mounts: VolumeMount[], containerName: string): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);
  const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;

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
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const secrets = readSecrets();
  const stdinData = { ...input, secrets };

  const mountLogLines = mounts.map(
    (m) => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
  );
  const mountSummaryLines = mounts.map(
    (m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
  );

  return runContainer({
    runtime: CONTAINER_RUNTIME_BIN,
    args: containerArgs,
    stdinData,
    groupName: group.name,
    groupFolder: group.folder,
    containerName,
    logsDir: path.join(GROUPS_DIR, group.folder, 'logs'),
    configTimeout,
    idleTimeout: IDLE_TIMEOUT,
    maxOutputSize: CONTAINER_MAX_OUTPUT_SIZE,
    onProcess,
    onOutput,
    stopCommand: stopContainer(containerName),
    logInput: input,
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
      `Prompt length: ${input.prompt.length} chars`,
      `Session ID: ${input.sessionId || 'new'}`,
      ``,
      `=== Mounts ===`,
      mountSummaryLines.join('\n'),
      ``,
    ],
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
