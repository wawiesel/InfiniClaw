/**
 * InfiniClaw delegate tools: codex, gemini, ollama lobes + query_local_llm.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { estimateTokens, recordCapabilityUsage } from './capability-budget.js';

type WriteIpcFile = (dir: string, data: object) => string;
type DelegateEnv = Record<string, string | undefined>;

const DEFAULT_DELEGATE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_DELEGATE_TIMEOUT_MS = 60 * 60 * 1000;
const DELEGATE_CWD_ROOTS = ['/workspace', '/workspace/group', '/workspace/extra'];
const DELEGATE_CACHE_ROOT = '/workspace/cache';
const EXTRA_PATH_PREPEND = process.env.NANOCLAW_PATH_PREPEND || '';
const HOST_CERT_FALLBACK = '/workspace/host-certs/node_extra_ca_certs-corporate-certs.pem';

function firstSet(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    const s = v?.trim();
    if (s) return s;
  }
  return undefined;
}

function prependToPath(currentPath: string | undefined, prefix: string): string {
  if (!currentPath || currentPath.trim().length === 0) return prefix;
  const parts = currentPath.split(path.delimiter);
  if (parts.includes(prefix)) return currentPath;
  return `${prefix}${path.delimiter}${currentPath}`;
}

function resolveDelegateCwd(cwd?: string): { ok: true; cwd: string } | { ok: false; error: string } {
  const requested = cwd?.trim() || '/workspace';
  const resolved = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve('/workspace', requested);

  const allowed = DELEGATE_CWD_ROOTS.some((root) => {
    const normalizedRoot = path.resolve(root);
    return (
      resolved === normalizedRoot ||
      resolved.startsWith(`${normalizedRoot}${path.sep}`)
    );
  });

  if (!allowed) {
    return {
      ok: false,
      error: `cwd must be under ${DELEGATE_CWD_ROOTS.join(' or ')} (got: ${resolved})`,
    };
  }

  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `cwd does not exist: ${resolved}` };
  }
  if (!fs.statSync(resolved).isDirectory()) {
    return { ok: false, error: `cwd is not a directory: ${resolved}` };
  }

  return { ok: true, cwd: resolved };
}

function isProviderUnavailableError(line: string): boolean {
  const s = line.toLowerCase();
  return [
    'insufficient_quota',
    'insufficient quota',
    'rate limit',
    '429',
    'unauthorized',
    'forbidden',
    'authentication',
    'invalid api key',
    'api key',
    'not logged in',
    'login required',
    'token is not active',
    'credits',
    'billing',
    'usage limit',
  ].some((needle) => s.includes(needle));
}

function isIgnorableDelegateStderr(line: string): boolean {
  const s = line.toLowerCase();
  return (
    s.includes('node_tls_reject_unauthorized') &&
    s.includes('makes tls connections and https requests insecure')
  ) || s.includes('codex_core::rollout::list: state db missing rollout path for thread');
}

function formatDelegateSender(
  name: string,
  provider: 'codex' | 'gemini' | 'ollama' | 'claude',
  llm: string,
): string {
  const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
  return `💭 ${providerName}/${llm.trim()} - ${name.trim()}`;
}

function buildDelegateEnv(): DelegateEnv {
  const delegateEnv: DelegateEnv = {
    ...process.env,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || DELEGATE_CACHE_ROOT,
    PIP_CACHE_DIR: process.env.PIP_CACHE_DIR || `${DELEGATE_CACHE_ROOT}/pip`,
    UV_CACHE_DIR: process.env.UV_CACHE_DIR || `${DELEGATE_CACHE_ROOT}/uv`,
    HF_HOME: process.env.HF_HOME || `${DELEGATE_CACHE_ROOT}/huggingface`,
    TRANSFORMERS_CACHE:
      process.env.TRANSFORMERS_CACHE || `${DELEGATE_CACHE_ROOT}/huggingface`,
    VIRTUALENV_OVERRIDE_APP_DATA:
      process.env.VIRTUALENV_OVERRIDE_APP_DATA ||
      `${DELEGATE_CACHE_ROOT}/virtualenv`,
  };
  if (EXTRA_PATH_PREPEND.trim().length > 0) {
    delegateEnv.PATH = prependToPath(delegateEnv.PATH, EXTRA_PATH_PREPEND);
  }

  if (fs.existsSync(HOST_CERT_FALLBACK)) {
    if (!delegateEnv.NODE_EXTRA_CA_CERTS) {
      delegateEnv.NODE_EXTRA_CA_CERTS = HOST_CERT_FALLBACK;
    }
    if (!delegateEnv.SSL_CERT_FILE) {
      delegateEnv.SSL_CERT_FILE = HOST_CERT_FALLBACK;
    }
  }

  const certBundle = firstSet(
    delegateEnv.REQUESTS_CA_BUNDLE,
    delegateEnv.CURL_CA_BUNDLE,
    delegateEnv.GIT_SSL_CAINFO,
    delegateEnv.SSL_CERT_FILE,
    delegateEnv.NODE_EXTRA_CA_CERTS,
  );
  if (certBundle) {
    if (!delegateEnv.SSL_CERT_FILE) delegateEnv.SSL_CERT_FILE = certBundle;
    if (!delegateEnv.NODE_EXTRA_CA_CERTS) delegateEnv.NODE_EXTRA_CA_CERTS = certBundle;
    if (!delegateEnv.REQUESTS_CA_BUNDLE) delegateEnv.REQUESTS_CA_BUNDLE = certBundle;
    if (!delegateEnv.CURL_CA_BUNDLE) delegateEnv.CURL_CA_BUNDLE = certBundle;
    if (!delegateEnv.GIT_SSL_CAINFO) delegateEnv.GIT_SSL_CAINFO = certBundle;
  }

  fs.mkdirSync(DELEGATE_CACHE_ROOT, { recursive: true });
  return delegateEnv;
}

function spawnNpxDelegate(
  pkg: string,
  args: string[],
  cwd: string,
  env: DelegateEnv,
): ReturnType<typeof spawn> {
  return spawn('npx', ['-y', pkg, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function registerDelegateTools(
  server: McpServer,
  ctx: {
    writeIpcFile: WriteIpcFile;
    messagesDir: string;
    tasksDir: string;
    ipcDir: string;
    chatJid: string;
    groupFolder: string;
    isMain: boolean;
  },
): void {
  const emitChatMessageTo = (jid: string, text: string, threadId?: string): void => {
    ctx.writeIpcFile(ctx.messagesDir, {
      type: 'message',
      chatJid: jid,
      text,
      groupFolder: ctx.groupFolder,
      timestamp: new Date().toISOString(),
      ...(threadId ? { threadId } : {}),
    });
  };
  const emitDelegateMessage = (text: string, threadId?: string): void => {
    emitChatMessageTo(ctx.chatJid, text, threadId);
  };

  /** Send a message and wait up to timeoutMs for its Matrix event ID. */
  async function sendAndGetEventId(text: string, timeoutMs = 10000): Promise<string | null> {
    const idsFile = path.join(ctx.ipcDir, 'last_event_ids.json');
    const sentBefore = (() => {
      try {
        if (!fs.existsSync(idsFile)) return '';
        const d = JSON.parse(fs.readFileSync(idsFile, 'utf-8')) as Record<string, string>;
        return d.lastSentAt || '';
      } catch { return ''; }
    })();
    emitDelegateMessage(text);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 200));
      try {
        if (!fs.existsSync(idsFile)) continue;
        const d = JSON.parse(fs.readFileSync(idsFile, 'utf-8')) as Record<string, string>;
        if (d.lastSent && d.lastSentAt && d.lastSentAt !== sentBefore) {
          return d.lastSent;
        }
      } catch { /* keep polling */ }
    }
    return null;
  }

  /** Write a set_thread IPC task. Pass null to clear the thread. */
  function setThread(threadId: string | null): void {
    ctx.writeIpcFile(ctx.tasksDir, {
      type: 'set_thread',
      chatJid: ctx.chatJid,
      threadId: threadId || undefined,
      groupFolder: ctx.groupFolder,
      timestamp: new Date().toISOString(),
    });
  }

  const ollamaHost = process.env.OLLAMA_HOST || (process.env.NANOCLAW_IPC_DIR ? 'http://localhost:11434' : 'http://host.containers.internal:11434');

  server.tool(
    'delegate_codex',
    `Spawn a Codex lobe clone in the same mounted workspace.

Use this when the main brain wants a tightly scoped clone to directly read/write files and run commands (including Python) inside the container.

Behavior:
- Streams lobe output back to chat prefixed as "codex: ..."
- Returns the same prefixed text to the main brain for collapse/integration
- If Codex cannot run (auth/quota/rate-limit/provider errors), it fails immediately and emits:
  "codex: unavailable: ..."
`,
    {
      name: z.string().min(1).describe('Lobe name (chosen by the main brain, e.g. "Renamer").'),
      objective: z.string().describe('Task for Codex to execute'),
      cwd: z.string().optional().describe('Working directory (absolute, or relative to /workspace/group). Must stay under /workspace/group or /workspace/extra.'),
      model: z.string().optional().describe('Optional Codex model override (e.g. "o3").'),
      thread_id: z.string().optional().describe('Matrix thread root event ID. When provided, all output is posted into this thread instead of the main timeline.'),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_DELEGATE_TIMEOUT_MS)
        .default(DEFAULT_DELEGATE_TIMEOUT_MS)
        .describe('Hard timeout for the delegate run in milliseconds (default 900000, max 3600000).'),
    },
    async (args) => {
      const threadId = args.thread_id?.trim() || undefined;
      const effectiveModel =
        firstSet(args.model, process.env.CODEX_MODEL, process.env.OPENAI_MODEL) ||
        'gpt-5-codex';
      const delegateHeader = formatDelegateSender(args.name, 'codex', effectiveModel);
      emitDelegateMessage(delegateHeader, threadId);
      if (threadId) emitDelegateMessage(args.objective, threadId);

      const cwdResult = resolveDelegateCwd(args.cwd);
      if (!cwdResult.ok) {
        const unavailable = `unavailable: ${cwdResult.error}`;
        const redText = `<font color="#cc0000">${unavailable}</font>`;
        emitDelegateMessage(redText, threadId);
        return {
          content: [{ type: 'text' as const, text: `codex: ${unavailable}` }],
          isError: true,
        };
      }

      const timeoutMs = Math.max(
        1000,
        Math.min(args.timeout_ms ?? DEFAULT_DELEGATE_TIMEOUT_MS, MAX_DELEGATE_TIMEOUT_MS),
      );

      const codexArgs = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '--cd',
        cwdResult.cwd,
      ];
      codexArgs.push('--model', effectiveModel);
      const delegatedObjective = [
        'Execution constraints:',
        '- Do NOT create Python virtual environments inside /workspace/group or /workspace/extra.',
        '- If a Python environment is required, create it under /workspace/cache/venvs.',
        '- Route large model/package caches under /workspace/cache.',
        '',
        'Objective:',
        args.objective,
      ].join('\n');
      codexArgs.push(delegatedObjective);

      return await new Promise<
        { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
      >((resolve) => {
        const prefixedMessages: string[] = [];
        const stderrLines: string[] = [];
        let stdoutBuffer = '';
        let stderrBuffer = '';
        let finalized = false;
        let unavailableTriggered = false;
        let timedOut = false;
        let proc: ReturnType<typeof spawn> | null = null;

        const finalize = (
          payload: { content: Array<{ type: 'text'; text: string }>; isError?: boolean },
        ) => {
          if (finalized) return;
          const estimatedTokens =
            estimateTokens(args.objective) +
            estimateTokens(prefixedMessages.join('\n\n'));
          recordCapabilityUsage('codex', effectiveModel, estimatedTokens);
          finalized = true;
          resolve(payload);
        };

        const pushMessage = (text: string, isStatus = false) => {
          const normalized = text.replace(/\r/g, '').trim();
          if (!normalized) return;
          prefixedMessages.push(`codex: ${normalized}`);
          const formatted = isStatus ? `<font color="#888888"><em>${normalized}</em></font>` : normalized;
          emitDelegateMessage(formatted, threadId);
        };

        const failUnavailable = (reason: string) => {
          if (unavailableTriggered) return;
          unavailableTriggered = true;
          pushMessage(`unavailable: ${reason}`, true);
          if (proc && proc.exitCode === null) {
            proc.kill('SIGTERM');
          }
        };

        const handleStdoutLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          try {
            const event = JSON.parse(trimmed) as {
              type?: string;
              message?: string;
              item?: { type?: string; text?: string };
            };
            if (
              event.type === 'item.completed' &&
              event.item?.type === 'agent_message' &&
              typeof event.item.text === 'string'
            ) {
              pushMessage(event.item.text);
              return;
            }
            if (
              event.type === 'error' &&
              typeof event.message === 'string'
            ) {
              failUnavailable(event.message);
              return;
            }
          } catch {
            pushMessage(trimmed);
            return;
          }
        };

        const handleStderrLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          if (isIgnorableDelegateStderr(trimmed)) return;
          stderrLines.push(trimmed);
          if (stderrLines.length > 100) stderrLines.shift();
          if (!unavailableTriggered && isProviderUnavailableError(trimmed)) {
            failUnavailable(trimmed);
          }
        };

        try {
          const delegateEnv = buildDelegateEnv();
          proc = spawnNpxDelegate(
            '@openai/codex',
            codexArgs,
            cwdResult.cwd,
            delegateEnv,
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          const unavailable = `unavailable: ${reason}`;
          const redText = `<font color="#cc0000">${unavailable}</font>`;
          emitDelegateMessage(redText, threadId);
          finalize({
            content: [{ type: 'text', text: `codex: ${unavailable}` }],
            isError: true,
          });
          return;
        }

        const timer = setTimeout(() => {
          timedOut = true;
          failUnavailable(`timed out after ${timeoutMs}ms`);
        }, timeoutMs);

        proc.stdout!.on('data', (chunk: Buffer | string) => {
          stdoutBuffer += chunk.toString();
          while (true) {
            const idx = stdoutBuffer.indexOf('\n');
            if (idx === -1) break;
            const line = stdoutBuffer.slice(0, idx);
            stdoutBuffer = stdoutBuffer.slice(idx + 1);
            handleStdoutLine(line);
          }
        });

        proc.stderr!.on('data', (chunk: Buffer | string) => {
          stderrBuffer += chunk.toString();
          while (true) {
            const idx = stderrBuffer.indexOf('\n');
            if (idx === -1) break;
            const line = stderrBuffer.slice(0, idx);
            stderrBuffer = stderrBuffer.slice(idx + 1);
            handleStderrLine(line);
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          failUnavailable(err.message);
          finalize({
            content: [
              {
                type: 'text',
                text:
                  prefixedMessages.join('\n\n') ||
                  `codex: unavailable: ${err.message}`,
              },
            ],
            isError: true,
          });
        });

        proc.on('close', (code, signal) => {
          clearTimeout(timer);

          if (stdoutBuffer.trim()) handleStdoutLine(stdoutBuffer);
          if (stderrBuffer.trim()) handleStderrLine(stderrBuffer);

          if (timedOut || unavailableTriggered) {
            finalize({
              content: [
                {
                  type: 'text',
                  text:
                    prefixedMessages.join('\n\n') ||
                    'codex: unavailable',
                },
              ],
              isError: true,
            });
            return;
          }

          if (code !== 0) {
            const detail =
              stderrLines[stderrLines.length - 1] ||
              `codex exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`;
            failUnavailable(detail);
            finalize({
              content: [{ type: 'text', text: prefixedMessages.join('\n\n') }],
              isError: true,
            });
            return;
          }

          if (prefixedMessages.length === 0) {
            prefixedMessages.push('codex: completed with no textual output.');
          }

          finalize({
            content: [{ type: 'text', text: prefixedMessages.join('\n\n') }],
          });
        });
      });
    },
  );

  server.tool(
    'delegate_gemini',
    `Spawn a Gemini lobe clone in the same mounted workspace.

Use this when the main brain wants a tightly scoped clone to directly read/write files and run commands (including Python) inside the container.

Behavior:
- Streams lobe output back to chat prefixed as "gemini: ..."
- Returns the same prefixed text to the main brain for collapse/integration
- If Gemini cannot run (auth/quota/rate-limit/provider errors), it fails immediately and emits:
  "gemini: unavailable: ..."
`,
    {
      name: z.string().min(1).describe('Lobe name (chosen by the main brain, e.g. "Reviewer").'),
      objective: z.string().describe('Task for Gemini to execute'),
      cwd: z.string().optional().describe('Working directory (absolute, or relative to /workspace/group). Must stay under /workspace/group or /workspace/extra.'),
      model: z.string().optional().describe('Optional Gemini model override (e.g. "gemini-2.5-pro").'),
      thread_id: z.string().optional().describe('Matrix thread root event ID. When provided, all output is posted into this thread instead of the main timeline.'),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_DELEGATE_TIMEOUT_MS)
        .default(DEFAULT_DELEGATE_TIMEOUT_MS)
        .describe('Hard timeout for the delegate run in milliseconds (default 900000, max 3600000).'),
    },
    async (args) => {
      const threadId = args.thread_id?.trim() || undefined;
      const effectiveModel =
        firstSet(args.model, process.env.GEMINI_MODEL) || 'gemini-2.5-pro';
      const delegateHeader = formatDelegateSender(args.name, 'gemini', effectiveModel);
      emitDelegateMessage(delegateHeader, threadId);
      if (threadId) emitDelegateMessage(args.objective, threadId);

      const cwdResult = resolveDelegateCwd(args.cwd);
      if (!cwdResult.ok) {
        const unavailable = `unavailable: ${cwdResult.error}`;
        const redText = `<font color="#cc0000">${unavailable}</font>`;
        emitDelegateMessage(redText, threadId);
        return {
          content: [{ type: 'text' as const, text: `gemini: ${unavailable}` }],
          isError: true,
        };
      }

      const timeoutMs = Math.max(
        1000,
        Math.min(args.timeout_ms ?? DEFAULT_DELEGATE_TIMEOUT_MS, MAX_DELEGATE_TIMEOUT_MS),
      );

      const delegatedObjective = [
        'Execution constraints:',
        '- Do NOT create Python virtual environments inside /workspace/group or /workspace/extra.',
        '- If a Python environment is required, create it under /workspace/cache/venvs.',
        '- Route large model/package caches under /workspace/cache.',
        '',
        'Objective:',
        args.objective,
      ].join('\n');

      const geminiArgs = [
        '--prompt',
        delegatedObjective,
        '--yolo',
        '--output-format',
        'text',
      ];
      geminiArgs.push('--model', effectiveModel);

      return await new Promise<
        { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
      >((resolve) => {
        const prefixedMessages: string[] = [];
        const stderrLines: string[] = [];
        let stdoutBuffer = '';
        let stderrBuffer = '';
        let finalized = false;
        let unavailableTriggered = false;
        let timedOut = false;
        let proc: ReturnType<typeof spawn> | null = null;

        const finalize = (
          payload: { content: Array<{ type: 'text'; text: string }>; isError?: boolean },
        ) => {
          if (finalized) return;
          const estimatedTokens =
            estimateTokens(args.objective) +
            estimateTokens(prefixedMessages.join('\n\n'));
          recordCapabilityUsage('gemini', effectiveModel, estimatedTokens);
          finalized = true;
          resolve(payload);
        };

        const pushMessage = (text: string, isStatus = false) => {
          const normalized = text.replace(/\r/g, '').trim();
          if (!normalized) return;
          prefixedMessages.push(`gemini: ${normalized}`);
          const formatted = isStatus ? `<font color="#888888"><em>${normalized}</em></font>` : normalized;
          emitDelegateMessage(formatted, threadId);
        };

        const failUnavailable = (reason: string) => {
          if (unavailableTriggered) return;
          unavailableTriggered = true;
          pushMessage(`unavailable: ${reason}`, true);
          if (proc && proc.exitCode === null) {
            proc.kill('SIGTERM');
          }
        };

        const handleStdoutLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          pushMessage(trimmed);
        };

        const handleStderrLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          if (isIgnorableDelegateStderr(trimmed)) return;
          stderrLines.push(trimmed);
          if (stderrLines.length > 100) stderrLines.shift();
          if (!unavailableTriggered && isProviderUnavailableError(trimmed)) {
            failUnavailable(trimmed);
          }
        };

        try {
          const delegateEnv = buildDelegateEnv();
          proc = spawnNpxDelegate(
            '@google/gemini-cli',
            geminiArgs,
            cwdResult.cwd,
            delegateEnv,
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          const unavailable = `unavailable: ${reason}`;
          const redText = `<font color="#cc0000">${unavailable}</font>`;
          emitDelegateMessage(redText, threadId);
          finalize({
            content: [{ type: 'text', text: `gemini: ${unavailable}` }],
            isError: true,
          });
          return;
        }

        const timer = setTimeout(() => {
          timedOut = true;
          failUnavailable(`timed out after ${timeoutMs}ms`);
        }, timeoutMs);

        proc.stdout!.on('data', (chunk: Buffer | string) => {
          stdoutBuffer += chunk.toString();
          while (true) {
            const idx = stdoutBuffer.indexOf('\n');
            if (idx === -1) break;
            const line = stdoutBuffer.slice(0, idx);
            stdoutBuffer = stdoutBuffer.slice(idx + 1);
            handleStdoutLine(line);
          }
        });

        proc.stderr!.on('data', (chunk: Buffer | string) => {
          stderrBuffer += chunk.toString();
          while (true) {
            const idx = stderrBuffer.indexOf('\n');
            if (idx === -1) break;
            const line = stderrBuffer.slice(0, idx);
            stderrBuffer = stderrBuffer.slice(idx + 1);
            handleStderrLine(line);
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          failUnavailable(err.message);
          finalize({
            content: [
              {
                type: 'text',
                text:
                  prefixedMessages.join('\n\n') ||
                  `gemini: unavailable: ${err.message}`,
              },
            ],
            isError: true,
          });
        });

        proc.on('close', (code, signal) => {
          clearTimeout(timer);

          if (stdoutBuffer.trim()) handleStdoutLine(stdoutBuffer);
          if (stderrBuffer.trim()) handleStderrLine(stderrBuffer);

          if (timedOut || unavailableTriggered) {
            finalize({
              content: [
                {
                  type: 'text',
                  text:
                    prefixedMessages.join('\n\n') ||
                    'gemini: unavailable',
                },
              ],
              isError: true,
            });
            return;
          }

          if (code !== 0) {
            const detail =
              stderrLines[stderrLines.length - 1] ||
              `gemini exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`;
            failUnavailable(detail);
            finalize({
              content: [{ type: 'text', text: prefixedMessages.join('\n\n') }],
              isError: true,
            });
            return;
          }

          if (prefixedMessages.length === 0) {
            prefixedMessages.push('gemini: completed with no textual output.');
          }

          finalize({
            content: [{ type: 'text', text: prefixedMessages.join('\n\n') }],
          });
        });
      });
    },
  );

  server.tool(
    'delegate_ollama',
    `Spawn an Ollama lobe clone on the host machine.

Behavior:
- Sends the objective to Ollama as a tightly scoped lobe and returns output prefixed as "ollama: ..."
- Emits the same prefixed text to chat immediately
- On connection/auth/runtime errors, returns:
  "ollama: unavailable: ..."
`,
    {
      name: z.string().min(1).describe('Lobe name (chosen by the main brain, e.g. "Summarizer").'),
      objective: z.string().describe('Task/objective for Ollama to execute'),
      model: z.string().default('llama3.2').describe('Ollama model name'),
      system: z.string().optional().describe('Optional system prompt'),
      thread_id: z.string().optional().describe('Matrix thread root event ID. When provided, all output is posted into this thread instead of the main timeline.'),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_DELEGATE_TIMEOUT_MS)
        .default(DEFAULT_DELEGATE_TIMEOUT_MS)
        .describe('Hard timeout for the delegate run in milliseconds (default 900000, max 3600000).'),
    },
    async (args) => {
      const threadId = args.thread_id?.trim() || undefined;
      const delegateHeader = formatDelegateSender(args.name, 'ollama', args.model);
      emitDelegateMessage(delegateHeader, threadId);
      if (threadId) emitDelegateMessage(args.objective, threadId);

      const timeoutMs = Math.max(
        1000,
        Math.min(args.timeout_ms ?? DEFAULT_DELEGATE_TIMEOUT_MS, MAX_DELEGATE_TIMEOUT_MS),
      );

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const body: Record<string, unknown> = {
          model: args.model,
          prompt: args.objective,
          stream: false,
        };
        if (args.system) body.system = args.system;

        const res = await fetch(`${ollamaHost}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text();
          const unavailable = `unavailable: Ollama error (${res.status}): ${text}`;
          const redText = `<font color="#cc0000">${unavailable}</font>`;
          emitDelegateMessage(redText, threadId);
          return {
            content: [{ type: 'text' as const, text: `ollama: ${unavailable}` }],
            isError: true,
          };
        }

        const data = await res.json() as { response?: string };
        const responseText = (data.response || '').trim();
        recordCapabilityUsage(
          'ollama',
          args.model,
          estimateTokens(args.objective) + estimateTokens(responseText),
        );
        if (!responseText) {
          const doneText = 'completed with no textual output.';
          emitDelegateMessage(`<font color="#888888"><em>${doneText}</em></font>`, threadId);
          return {
            content: [{ type: 'text' as const, text: `ollama: ${doneText}` }],
          };
        }

        emitDelegateMessage(responseText, threadId);
        return {
          content: [{ type: 'text' as const, text: `ollama: ${responseText}` }],
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const unavailable = `unavailable: ${reason}`;
        emitDelegateMessage(unavailable, threadId);
        return {
          content: [{ type: 'text' as const, text: `ollama: ${unavailable}` }],
          isError: true,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  );

  server.tool(
    'delegate_claude',
    `Spawn a Claude lobe clone in the same mounted workspace.

Use this when the main brain wants to spawn a parallel Claude instance for reasoning tasks that don't need the full context of the current conversation.

Behavior:
- Streams lobe output back to chat prefixed as "claude: ..."
- Returns the same prefixed text to the main brain for collapse/integration
- If Claude cannot run (auth/quota/rate-limit/provider errors), it fails immediately and emits:
  "claude: unavailable: ..."
`,
    {
      name: z.string().min(1).describe('Lobe name (chosen by the main brain, e.g. "Reviewer").'),
      objective: z.string().describe('Task for Claude to execute'),
      cwd: z.string().optional().describe('Working directory (absolute, or relative to /workspace/group). Must stay under /workspace/group or /workspace/extra.'),
      model: z.string().optional().describe('Optional Claude model override (e.g. "opus", "sonnet", "haiku").'),
      thread_id: z.string().optional().describe('Matrix thread root event ID. When provided, all output is posted into this thread instead of the main timeline.'),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_DELEGATE_TIMEOUT_MS)
        .default(DEFAULT_DELEGATE_TIMEOUT_MS)
        .describe('Hard timeout for the delegate run in milliseconds (default 900000, max 3600000).'),
    },
    async (args) => {
      const threadId = args.thread_id?.trim() || undefined;
      const effectiveModel =
        firstSet(args.model, process.env.ANTHROPIC_MODEL, process.env.CLAUDE_MODEL) ||
        'sonnet';
      const delegateHeader = formatDelegateSender(args.name, 'claude', effectiveModel);
      emitDelegateMessage(delegateHeader, threadId);
      if (threadId) emitDelegateMessage(args.objective, threadId);

      const cwdResult = resolveDelegateCwd(args.cwd);
      if (!cwdResult.ok) {
        const unavailable = `unavailable: ${cwdResult.error}`;
        const redText = `<font color="#cc0000">${unavailable}</font>`;
        emitDelegateMessage(redText, threadId);
        return {
          content: [{ type: 'text' as const, text: `claude: ${unavailable}` }],
          isError: true,
        };
      }

      const timeoutMs = Math.max(
        1000,
        Math.min(args.timeout_ms ?? DEFAULT_DELEGATE_TIMEOUT_MS, MAX_DELEGATE_TIMEOUT_MS),
      );

      const claudeArgs = [
        '--print',
        '--verbose',
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        '--model', effectiveModel,
        '--add-dir', cwdResult.cwd,
      ];

      const delegatedObjective = [
        'Execution constraints:',
        '- Do NOT create Python virtual environments inside /workspace/group or /workspace/extra.',
        '- If a Python environment is required, create it under /workspace/cache/venvs.',
        '- Route large model/package caches under /workspace/cache.',
        '',
        'Objective:',
        args.objective,
      ].join('\n');
      // Note: objective is piped to stdin, not passed as CLI arg

      return await new Promise<
        { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
      >((resolve) => {
        const prefixedMessages: string[] = [];
        const stderrLines: string[] = [];
        let stdoutBuffer = '';
        let stderrBuffer = '';
        let finalized = false;
        let unavailableTriggered = false;
        let timedOut = false;
        let proc: ReturnType<typeof spawn> | null = null;

        const finalize = (
          payload: { content: Array<{ type: 'text'; text: string }>; isError?: boolean },
        ) => {
          if (finalized) return;
          const estimatedTokens =
            estimateTokens(args.objective) +
            estimateTokens(prefixedMessages.join('\n\n'));
          recordCapabilityUsage('anthropic', effectiveModel, estimatedTokens);
          finalized = true;
          resolve(payload);
        };

        const pushMessage = (text: string, isStatus = false) => {
          const normalized = text.replace(/\r/g, '').trim();
          if (!normalized) return;
          prefixedMessages.push(`claude: ${normalized}`);
          const formatted = isStatus ? `<font color="#888888"><em>${normalized}</em></font>` : normalized;
          emitDelegateMessage(formatted, threadId);
        };

        const failUnavailable = (reason: string) => {
          if (unavailableTriggered) return;
          unavailableTriggered = true;
          pushMessage(`unavailable: ${reason}`, true);
          if (proc && proc.exitCode === null) {
            proc.kill('SIGTERM');
          }
        };

        const handleStdoutLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          try {
            const event = JSON.parse(trimmed) as {
              type?: string;
              message?: string;
              content?: string;
              result?: string;
            };
            // Claude stream-json emits various event types
            // Look for assistant messages and results
            if (event.type === 'assistant' && typeof event.content === 'string') {
              pushMessage(event.content);
              return;
            }
            if (event.type === 'result' && typeof event.result === 'string') {
              pushMessage(event.result);
              return;
            }
            if (event.type === 'error' && typeof event.message === 'string') {
              failUnavailable(event.message);
              return;
            }
            // For content_block_delta events (streaming)
            if (event.type === 'content_block_delta') {
              const delta = (event as Record<string, unknown>).delta as { type?: string; text?: string } | undefined;
              if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                // Don't push partial deltas, they accumulate
                return;
              }
            }
          } catch {
            // Non-JSON lines get pushed directly
            pushMessage(trimmed);
            return;
          }
        };

        const handleStderrLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          if (isIgnorableDelegateStderr(trimmed)) return;
          stderrLines.push(trimmed);
          if (stderrLines.length > 100) stderrLines.shift();
          if (!unavailableTriggered && isProviderUnavailableError(trimmed)) {
            failUnavailable(trimmed);
          }
        };

        try {
          const delegateEnv = buildDelegateEnv();
          proc = spawn('claude', claudeArgs, {
            cwd: cwdResult.cwd,
            env: delegateEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          // Pipe objective to stdin
          proc.stdin!.write(delegatedObjective);
          proc.stdin!.end();
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          const unavailable = `unavailable: ${reason}`;
          const redText = `<font color="#cc0000">${unavailable}</font>`;
          emitDelegateMessage(redText, threadId);
          finalize({
            content: [{ type: 'text', text: `claude: ${unavailable}` }],
            isError: true,
          });
          return;
        }

        const timer = setTimeout(() => {
          timedOut = true;
          failUnavailable(`timed out after ${timeoutMs}ms`);
        }, timeoutMs);

        proc.stdout!.on('data', (chunk: Buffer | string) => {
          stdoutBuffer += chunk.toString();
          while (true) {
            const idx = stdoutBuffer.indexOf('\n');
            if (idx === -1) break;
            const line = stdoutBuffer.slice(0, idx);
            stdoutBuffer = stdoutBuffer.slice(idx + 1);
            handleStdoutLine(line);
          }
        });

        proc.stderr!.on('data', (chunk: Buffer | string) => {
          stderrBuffer += chunk.toString();
          while (true) {
            const idx = stderrBuffer.indexOf('\n');
            if (idx === -1) break;
            const line = stderrBuffer.slice(0, idx);
            stderrBuffer = stderrBuffer.slice(idx + 1);
            handleStderrLine(line);
          }
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          failUnavailable(err.message);
          finalize({
            content: [
              {
                type: 'text',
                text:
                  prefixedMessages.join('\n\n') ||
                  `claude: unavailable: ${err.message}`,
              },
            ],
            isError: true,
          });
        });

        proc.on('close', (code, signal) => {
          clearTimeout(timer);

          if (stdoutBuffer.trim()) handleStdoutLine(stdoutBuffer);
          if (stderrBuffer.trim()) handleStderrLine(stderrBuffer);

          if (timedOut || unavailableTriggered) {
            finalize({
              content: [
                {
                  type: 'text',
                  text:
                    prefixedMessages.join('\n\n') ||
                    'claude: unavailable',
                },
              ],
              isError: true,
            });
            return;
          }

          if (code !== 0) {
            const detail =
              stderrLines[stderrLines.length - 1] ||
              `claude exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`;
            failUnavailable(detail);
            finalize({
              content: [{ type: 'text', text: prefixedMessages.join('\n\n') }],
              isError: true,
            });
            return;
          }

          if (prefixedMessages.length === 0) {
            prefixedMessages.push('claude: completed with no textual output.');
          }

          finalize({
            content: [{ type: 'text', text: prefixedMessages.join('\n\n') }],
          });
        });
      });
    },
  );

  server.tool(
    'query_local_llm',
    `Query a local Ollama LLM running on the host machine. Use this for tasks that don't need Claude's full reasoning — summarization, formatting, extraction, classification, translation, or simple Q&A. Much faster and free.`,
    {
      prompt: z.string().describe('The prompt to send to the local LLM'),
      model: z.string().default('llama3.2').describe('Ollama model name (e.g., "llama3.2", "mistral", "gemma2")'),
      system: z.string().optional().describe('Optional system prompt'),
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = {
          model: args.model,
          prompt: args.prompt,
          stream: false,
        };
        if (args.system) body.system = args.system;

        const res = await fetch(`${ollamaHost}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const text = await res.text();
          return {
            content: [{ type: 'text' as const, text: `Ollama error (${res.status}): ${text}` }],
            isError: true,
          };
        }

        const data = await res.json() as { response: string };
        return { content: [{ type: 'text' as const, text: data.response }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to reach Ollama at ${ollamaHost}: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── delegate_to_lobe ─────────────────────────────────────────────────

  server.tool(
    'delegate_to_lobe',
    `Atomically delegate a task to a lobe (Codex, Gemini, or Claude) with correct Matrix threading.

The tool handles the entire flow:
1. Posts "💭 Provider/model - {reason}" to the main timeline (e.g. "💭 Gemini/gemini-2.5-pro - capitals")
2. Captures that message's event ID
3. Posts the objective in the thread
4. Runs the lobe subprocess with the objective
5. Posts the lobe response in the thread
6. Returns the thread to the main timeline
7. Returns the lobe output to the calling agent

You never need to call send_message, set_thread, or get_last_event_id manually for delegations.`,
    {
      reason: z.string().min(1).describe('Short reason shown on the main timeline, e.g. "Save memory: threading fix"'),
      objective: z.string().describe('Full detailed prompt/objective for the lobe to execute'),
      lobe: z.enum(['codex', 'gemini', 'claude']).default('codex').describe('Which lobe to use (default: codex)'),
      cwd: z.string().optional().describe('Working directory. Must be under /workspace/group or /workspace/extra.'),
      model: z.string().optional().describe('Optional model override for the lobe.'),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_DELEGATE_TIMEOUT_MS)
        .default(DEFAULT_DELEGATE_TIMEOUT_MS)
        .describe('Hard timeout for the lobe run in milliseconds (default 900000, max 3600000).'),
    },
    async (args) => {
      // Resolve lobe and model first (needed for summary)
      const lobe = args.lobe ?? 'codex';
      const effectiveModel = (() => {
        if (args.model) return args.model;
        if (lobe === 'gemini') return firstSet(process.env.GEMINI_MODEL) || 'gemini-2.5-pro';
        if (lobe === 'claude') return firstSet(process.env.ANTHROPIC_MODEL, process.env.CLAUDE_MODEL) || 'sonnet';
        return firstSet(process.env.CODEX_MODEL, process.env.OPENAI_MODEL) || 'gpt-5-codex';
      })();
      const providerName = lobe.charAt(0).toUpperCase() + lobe.slice(1);

      // Step 1+2: Post summary to main timeline and capture event ID
      // Format: 💭 Gemini/gemini-2.5-pro - reason
      const summaryText = `💭 ${providerName}/${effectiveModel} - ${args.reason}`;
      const threadId = await sendAndGetEventId(summaryText, 10000);

      // Step 3: Post the objective in the thread with markdown formatting
      emitDelegateMessage(args.objective, threadId ?? undefined);

      // Step 4+5: Resolve cwd and run the lobe
      const cwdResult = resolveDelegateCwd(args.cwd);
      if (!cwdResult.ok) {
        const errText = `<font color="#cc0000">unavailable: ${cwdResult.error}</font>`;
        emitDelegateMessage(errText, threadId ?? undefined);
        if (threadId) setThread(null);
        return {
          content: [{ type: 'text' as const, text: `${lobe}: unavailable: ${cwdResult.error}` }],
          isError: true,
        };
      }

      const timeoutMs = Math.max(1000, Math.min(args.timeout_ms ?? DEFAULT_DELEGATE_TIMEOUT_MS, MAX_DELEGATE_TIMEOUT_MS));
      const delegatedObjective = [
        'Execution constraints:',
        '- Do NOT create Python virtual environments inside /workspace/group or /workspace/extra.',
        '- If a Python environment is required, create it under /workspace/cache/venvs.',
        '- Route large model/package caches under /workspace/cache.',
        '',
        'Objective:',
        args.objective,
      ].join('\n');

      const result = await new Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>((resolve) => {
        const prefixedMessages: string[] = [];
        const stderrLines: string[] = [];
        let stdoutBuffer = '';
        let stderrBuffer = '';
        let finalized = false;
        let unavailableTriggered = false;
        let timedOut = false;
        let proc: ReturnType<typeof spawn> | null = null;

        const finalize = (payload: { content: Array<{ type: 'text'; text: string }>; isError?: boolean }) => {
          if (finalized) return;
          const estimatedTokens = estimateTokens(args.objective) + estimateTokens(prefixedMessages.join('\n\n'));
          const budgetProvider = lobe === 'claude' ? 'anthropic' : lobe;
          recordCapabilityUsage(budgetProvider, effectiveModel, estimatedTokens);
          finalized = true;
          resolve(payload);
        };

        const pushMessage = (text: string, isStatus = false) => {
          const normalized = text.replace(/\r/g, '').trim();
          if (!normalized) return;
          prefixedMessages.push(`${lobe}: ${normalized}`);
          const formatted = isStatus ? `<font color="#888888"><em>${normalized}</em></font>` : normalized;
          emitDelegateMessage(formatted, threadId ?? undefined);
        };

        const failUnavailable = (reason: string) => {
          if (unavailableTriggered) return;
          unavailableTriggered = true;
          pushMessage(`unavailable: ${reason}`, true);
          if (proc && proc.exitCode === null) proc.kill('SIGTERM');
        };

        const handleStdoutLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          if (lobe === 'codex') {
            try {
              const event = JSON.parse(trimmed) as { type?: string; message?: string; item?: { type?: string; text?: string } };
              if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
                pushMessage(event.item.text);
                return;
              }
              if (event.type === 'error' && typeof event.message === 'string') {
                failUnavailable(event.message);
                return;
              }
            } catch { pushMessage(trimmed); return; }
          } else if (lobe === 'claude') {
            try {
              const event = JSON.parse(trimmed) as { type?: string; message?: string; content?: string; result?: string };
              if (event.type === 'assistant' && typeof event.content === 'string') {
                pushMessage(event.content);
                return;
              }
              if (event.type === 'result' && typeof event.result === 'string') {
                pushMessage(event.result);
                return;
              }
              if (event.type === 'error' && typeof event.message === 'string') {
                failUnavailable(event.message);
                return;
              }
            } catch { pushMessage(trimmed); return; }
          } else {
            pushMessage(trimmed);
          }
        };

        const handleStderrLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          if (isIgnorableDelegateStderr(trimmed)) return;
          stderrLines.push(trimmed);
          if (stderrLines.length > 100) stderrLines.shift();
          if (!unavailableTriggered && isProviderUnavailableError(trimmed)) failUnavailable(trimmed);
        };

        try {
          const delegateEnv = buildDelegateEnv();
          if (lobe === 'codex') {
            const codexArgs = [
              'exec', '--json', '--skip-git-repo-check',
              '--dangerously-bypass-approvals-and-sandbox',
              '--cd', cwdResult.cwd,
              '--model', effectiveModel,
              delegatedObjective,
            ];
            proc = spawnNpxDelegate('@openai/codex', codexArgs, cwdResult.cwd, delegateEnv);
          } else if (lobe === 'claude') {
            const claudeArgs = [
              '--print',
              '--verbose',
              '--output-format', 'stream-json',
              '--dangerously-skip-permissions',
              '--model', effectiveModel,
              '--add-dir', cwdResult.cwd,
            ];
            proc = spawn('claude', claudeArgs, {
              cwd: cwdResult.cwd,
              env: delegateEnv,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            // Pipe objective to stdin (Claude CLI requires stdin input with --print)
            proc.stdin!.write(delegatedObjective);
            proc.stdin!.end();
          } else {
            const geminiArgs = ['--prompt', delegatedObjective, '--yolo', '--output-format', 'text', '--model', effectiveModel];
            proc = spawnNpxDelegate('@google/gemini-cli', geminiArgs, cwdResult.cwd, delegateEnv);
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          emitDelegateMessage(`<font color="#cc0000">unavailable: ${reason}</font>`, threadId ?? undefined);
          finalize({ content: [{ type: 'text', text: `${lobe}: unavailable: ${reason}` }], isError: true });
          return;
        }

        const timer = setTimeout(() => { timedOut = true; failUnavailable(`timed out after ${timeoutMs}ms`); }, timeoutMs);

        proc.stdout!.on('data', (chunk: Buffer | string) => {
          stdoutBuffer += chunk.toString();
          while (true) { const idx = stdoutBuffer.indexOf('\n'); if (idx === -1) break; handleStdoutLine(stdoutBuffer.slice(0, idx)); stdoutBuffer = stdoutBuffer.slice(idx + 1); }
        });
        proc.stderr!.on('data', (chunk: Buffer | string) => {
          stderrBuffer += chunk.toString();
          while (true) { const idx = stderrBuffer.indexOf('\n'); if (idx === -1) break; handleStderrLine(stderrBuffer.slice(0, idx)); stderrBuffer = stderrBuffer.slice(idx + 1); }
        });
        proc.on('error', (err) => { clearTimeout(timer); failUnavailable(err.message); finalize({ content: [{ type: 'text', text: prefixedMessages.join('\n\n') || `${lobe}: unavailable: ${err.message}` }], isError: true }); });
        proc.on('close', (code, signal) => {
          clearTimeout(timer);
          if (stdoutBuffer.trim()) handleStdoutLine(stdoutBuffer);
          if (stderrBuffer.trim()) handleStderrLine(stderrBuffer);
          if (timedOut || unavailableTriggered) { finalize({ content: [{ type: 'text', text: prefixedMessages.join('\n\n') || `${lobe}: unavailable` }], isError: true }); return; }
          if (code !== 0) { failUnavailable(stderrLines[stderrLines.length - 1] || `${lobe} exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`); finalize({ content: [{ type: 'text', text: prefixedMessages.join('\n\n') }], isError: true }); return; }
          if (prefixedMessages.length === 0) prefixedMessages.push(`${lobe}: completed with no textual output.`);
          finalize({ content: [{ type: 'text', text: prefixedMessages.join('\n\n') }] });
        });
      });

      // Step 6: Clear thread back to main timeline
      if (threadId) setThread(null);

      return result;
    },
  );
}
