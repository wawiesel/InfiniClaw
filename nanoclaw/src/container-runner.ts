/**
 * Container Runner for NanoClaw
 * Spawns agent execution in the configured container runtime and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_CPUS,
  CONTAINER_MEMORY_MB,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ASSISTANT_NAME,
} from './config.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { saveSkillsToPersona, loadSkillsToSession } from './skill-sync.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

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
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  isProgress?: boolean;
  newSessionId?: string;
  model?: string;
  error?: string;
}

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
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'OLLAMA_HOST',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'INFINICLAW_ROOT',
  'PERSONA_NAME',
  // Network/TLS passthrough for environments with corporate proxies/certs.
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
const CERT_PATH_ENV_VARS = [
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
] as const;

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;
  const key = match[1];
  let value = match[2];
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

function collectContainerSecrets(projectRoot: string): Record<string, string> {
  const secrets: Record<string, string> = {};

  // Launchd/runtime env takes precedence.
  for (const key of ALLOWED_ENV_VARS) {
    const value = process.env[key];
    if (value && value.trim().length > 0) {
      secrets[key] = value;
    }
  }

  // Fill missing values from project .env if present.
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

function isOllamaAnthropicBaseUrl(baseUrl: string | undefined): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return false;

  const normalized = trimmed.toLowerCase();
  if (normalized.includes('ollama')) return true;

  try {
    const parsed = new URL(trimmed);
    const port =
      parsed.port ||
      (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '');
    return port === '11434';
  } catch {
    return false;
  }
}

function normalizeProviderSecrets(
  secrets: Record<string, string>,
): Record<string, string> {
  const normalized = { ...secrets };
  if (!isOllamaAnthropicBaseUrl(normalized.ANTHROPIC_BASE_URL)) {
    return normalized;
  }

  // In Ollama mode, force Claude SDK to use Anthropic-compatible endpoint auth.
  // Passing account OAuth here can cause SDK to ignore base URL routing.
  delete normalized.CLAUDE_CODE_OAUTH_TOKEN;
  delete normalized.ANTHROPIC_API_KEY;

  const explicitModel = normalized.ANTHROPIC_MODEL?.trim();
  if (explicitModel) {
    normalized.ANTHROPIC_MODEL = explicitModel;
    // Force all SDK model slots to the same ollama model so haiku/sonnet
    // fallbacks never try models ollama doesn't have.
    normalized.ANTHROPIC_SMALL_FAST_MODEL = explicitModel;
    normalized.ANTHROPIC_DEFAULT_SONNET_MODEL = explicitModel;
  }

  if (!normalized.ANTHROPIC_AUTH_TOKEN?.trim()) {
    normalized.ANTHROPIC_AUTH_TOKEN = 'ollama';
  }

  // SDK runtime knobs for local models:
  // - Skip token counting API (ollama has no /v1/messages/count_tokens)
  // - Cap context window to match local model limits
  // - Reduce max output tokens so input context has room (32K - 4K = 28K input)
  normalized.NANOCLAW_SKIP_TOKEN_COUNTING = '1';
  normalized.NANOCLAW_CONTEXT_WINDOW = '32000';
  normalized.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '4096';

  return normalized;
}

function redactSecrets(
  secrets: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!secrets || Object.keys(secrets).length === 0) return undefined;
  return Object.fromEntries(
    Object.keys(secrets).map((k) => [k, '[REDACTED]']),
  );
}

function mapCertPathSecretsToContainer(
  secrets: Record<string, string>,
  mounts: VolumeMount[],
): Record<string, string> {
  const mapped = { ...secrets };
  const certMountRoot = '/workspace/host-certs';

  for (const key of CERT_PATH_ENV_VARS) {
    const value = mapped[key];
    if (!value) continue;
    if (!path.isAbsolute(value) || !fs.existsSync(value)) continue;

    const safeName = path.basename(value).replace(/[^a-zA-Z0-9._-]/g, '_');
    const containerPath = `${certMountRoot}/${key.toLowerCase()}-${safeName}`;

    if (
      !mounts.some(
        (m) => m.hostPath === value && m.containerPath === containerPath,
      )
    ) {
      mounts.push({
        hostPath: value,
        containerPath,
        readonly: true,
      });
    }

    mapped[key] = containerPath;
  }

  // Normalize CA bundle env so Node, Python/requests, curl, and git all see
  // the same trust anchor even if only one variable is provided by the host.
  const certBundle =
    mapped.SSL_CERT_FILE ||
    mapped.NODE_EXTRA_CA_CERTS ||
    mapped.REQUESTS_CA_BUNDLE ||
    mapped.CURL_CA_BUNDLE ||
    mapped.GIT_SSL_CAINFO;
  if (certBundle) {
    if (!mapped.SSL_CERT_FILE) mapped.SSL_CERT_FILE = certBundle;
    if (!mapped.NODE_EXTRA_CA_CERTS) mapped.NODE_EXTRA_CA_CERTS = certBundle;
    if (!mapped.REQUESTS_CA_BUNDLE) mapped.REQUESTS_CA_BUNDLE = certBundle;
    if (!mapped.CURL_CA_BUNDLE) mapped.CURL_CA_BUNDLE = certBundle;
    if (!mapped.GIT_SSL_CAINFO) mapped.GIT_SSL_CAINFO = certBundle;
  }

  return mapped;
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
  const homeDir = getHomeDir();
  const projectRoot = process.cwd();

  if (isMain) {
    // Main gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
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
  // Auto-approve all MCP servers from .mcp.json (no interactive prompt in containers)
  settings.enableAllProjectMcpServers = true;
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');

  // Sync skills: save session → persona (replace), then rebuild session from shared + persona
  const skillsDst = path.join(groupSessionsDir, 'skills');
  const rootDir = process.env.INFINICLAW_ROOT;
  const personaName = process.env.PERSONA_NAME;
  const sharedSkillsSrc = path.join(process.cwd(), 'container', 'skills');

  // Load persona container config (version-controlled alongside env/skills)
  let personaConfig: Record<string, unknown> = {};
  if (rootDir && personaName) {
    const personaConfigPath = path.join(rootDir, 'bots', 'personas', personaName, 'container-config.json');
    try {
      if (fs.existsSync(personaConfigPath)) {
        personaConfig = JSON.parse(fs.readFileSync(personaConfigPath, 'utf-8'));
      }
    } catch (err) {
      logger.warn({ personaConfigPath, error: err }, 'Failed to load persona container config');
    }
  }

  if (rootDir && personaName) {
    const personaBaseDir = path.join(rootDir, 'bots', 'personas', personaName);
    const personaSkillsDir = path.join(personaBaseDir, 'skills');
    saveSkillsToPersona(skillsDst, personaSkillsDir, sharedSkillsSrc);
    loadSkillsToSession(skillsDst, personaSkillsDir, sharedSkillsSrc);

    // Two-way sync .mcp.json: save-back container → persona, then restore persona → container
    const groupDir = path.join(GROUPS_DIR, group.folder);
    const containerMcpJson = path.join(groupDir, '.mcp.json');
    const personaGroupDir = path.join(personaBaseDir, 'groups', group.folder);
    const personaMcpJson = path.join(personaGroupDir, '.mcp.json');
    // Save-back: if container has .mcp.json, copy to persona
    if (fs.existsSync(containerMcpJson)) {
      fs.mkdirSync(personaGroupDir, { recursive: true });
      fs.copyFileSync(containerMcpJson, personaMcpJson);
    }
    // Restore: if persona has .mcp.json, copy to container
    if (fs.existsSync(personaMcpJson)) {
      fs.copyFileSync(personaMcpJson, containerMcpJson);
    }

    // Mount persona dir writable so bots can edit their own CLAUDE.md (two-way sync)
    mounts.push({
      hostPath: personaBaseDir,
      containerPath: `/workspace/extra/${personaName}-persona`,
      readonly: false,
    });
  }

  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Share host Codex login state with container delegate_codex runs.
  // This enables `codex` inside the container to reuse the host's auth.json.
  const hostCodexDir = path.join(homeDir, '.codex');
  if (fs.existsSync(hostCodexDir)) {
    mounts.push({
      hostPath: hostCodexDir,
      containerPath: '/home/node/.codex',
      readonly: false,
    });
  }

  // Share host Gemini login/config with container delegate_gemini runs.
  const hostGeminiDir = path.join(homeDir, '.gemini');
  if (fs.existsSync(hostGeminiDir)) {
    mounts.push({
      hostPath: hostGeminiDir,
      containerPath: '/home/node/.gemini',
      readonly: false,
    });
  }

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Environment file directory (mounted as /workspace/env-dir for the entrypoint to source)
  // Only expose specific auth variables needed by Claude Code, not the entire .env
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

  // Per-group persistent cache for model/tool downloads (docling, huggingface, pip, etc.).
  // Keeps heavy artifacts out of mounted user data like /workspace/extra/home/_vault.
  const cacheDir = path.join(DATA_DIR, 'cache', group.folder);
  fs.mkdirSync(cacheDir, { recursive: true });
  mounts.push({
    hostPath: cacheDir,
    containerPath: '/workspace/cache',
    readonly: false,
  });

  // Mount agent-runner source from host — recompiled on container startup.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({
    hostPath: agentRunnerSrc,
    containerPath: '/app/src',
    readonly: true,
  });

  // Additional mounts: merge persona container-config.json with group DB config.
  const allAdditionalMounts = [
    ...(group.containerConfig?.additionalMounts || []),
    ...((personaConfig.additionalMounts as Array<{hostPath: string; containerPath?: string; readonly?: boolean}>) || []),
  ];
  if (allAdditionalMounts.length > 0) {
    const validatedMounts = validateAdditionalMounts(
      allAdditionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(mounts: VolumeMount[], containerName: string): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Podman-only runtime.
  args.push('--pull=never');
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

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  const projectRoot = process.cwd();
  const secrets = normalizeProviderSecrets(collectContainerSecrets(projectRoot));
  const mounts = buildVolumeMounts(group, input.isMain, secrets);
  const mappedSecrets = mapCertPathSecretsToContainer(secrets, mounts);
  // Read .mcp.json from group dir for inline SDK passthrough
  let mcpServers: Record<string, Record<string, unknown>> | undefined;
  const mcpJsonPath = path.join(groupDir, '.mcp.json');
  try {
    if (fs.existsSync(mcpJsonPath)) {
      const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
      if (mcpJson.mcpServers && Object.keys(mcpJson.mcpServers).length > 0) {
        mcpServers = mcpJson.mcpServers;
      }
    }
  } catch { /* ignore */ }
  const effectiveInput: ContainerInput = {
    ...input,
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
  const containerArgs = buildContainerArgs(mounts, containerName);

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

    // Write input and close stdin so the runtime can flush/finish reading.
    container.stdin.write(JSON.stringify(effectiveInput));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
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

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

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
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
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
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
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
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, containerName }, 'Container timeout, stopping gracefully');
      exec(`podman stop ${containerName}`, { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn({ group: group.name, containerName, err }, 'Graceful stop failed, force killing');
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
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

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
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

      // Streaming mode: wait for output chain to settle, return completion marker
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

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
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
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
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

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
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
