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
  provider: 'codex' | 'gemini' | 'ollama',
  llm: string,
): string {
  const lobeName = name.trim();
  const model = llm.trim();
  const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
  return `<font color="#888888">💭 ${lobeName} <em>(${providerName}/${model})</em></font>`;
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
    chatJid: string;
    groupFolder: string;
    isMain: boolean;
  },
): void {
  const emitChatMessageTo = (jid: string, text: string): void => {
    ctx.writeIpcFile(ctx.messagesDir, {
      type: 'message',
      chatJid: jid,
      text,
      groupFolder: ctx.groupFolder,
      timestamp: new Date().toISOString(),
    });
  };
  const emitDelegateMessage = (text: string): void => {
    emitChatMessageTo(ctx.chatJid, text);
  };

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
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_DELEGATE_TIMEOUT_MS)
        .default(DEFAULT_DELEGATE_TIMEOUT_MS)
        .describe('Hard timeout for the delegate run in milliseconds (default 900000, max 3600000).'),
    },
    async (args) => {
      const effectiveModel =
        firstSet(args.model, process.env.CODEX_MODEL, process.env.OPENAI_MODEL) ||
        'gpt-5-codex';
      const delegateHeader = formatDelegateSender(args.name, 'codex', effectiveModel);

      const headerAndObjective = `${delegateHeader}<br><font color="#888888"><strong>Objective:</strong> ${args.objective}</font>`;
      emitDelegateMessage(headerAndObjective);

      const cwdResult = resolveDelegateCwd(args.cwd);
      if (!cwdResult.ok) {
        const unavailable = `unavailable: ${cwdResult.error}`;
        const redText = `<font color="#cc0000">${unavailable}</font>`;
        emitDelegateMessage(redText);
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
          emitDelegateMessage(formatted);
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
          emitDelegateMessage(redText);
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
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_DELEGATE_TIMEOUT_MS)
        .default(DEFAULT_DELEGATE_TIMEOUT_MS)
        .describe('Hard timeout for the delegate run in milliseconds (default 900000, max 3600000).'),
    },
    async (args) => {
      const effectiveModel =
        firstSet(args.model, process.env.GEMINI_MODEL) || 'gemini-2.5-pro';
      const delegateHeader = formatDelegateSender(args.name, 'gemini', effectiveModel);

      const headerAndObjective = `${delegateHeader}<br><font color="#888888"><strong>Objective:</strong> ${args.objective}</font>`;
      emitDelegateMessage(headerAndObjective);

      const cwdResult = resolveDelegateCwd(args.cwd);
      if (!cwdResult.ok) {
        const unavailable = `unavailable: ${cwdResult.error}`;
        const redText = `<font color="#cc0000">${unavailable}</font>`;
        emitDelegateMessage(redText);
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
          emitDelegateMessage(formatted);
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
          emitDelegateMessage(redText);
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
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_DELEGATE_TIMEOUT_MS)
        .default(DEFAULT_DELEGATE_TIMEOUT_MS)
        .describe('Hard timeout for the delegate run in milliseconds (default 900000, max 3600000).'),
    },
    async (args) => {
      const delegateHeader = formatDelegateSender(args.name, 'ollama', args.model);

      const headerAndObjective = `${delegateHeader}<br><font color="#888888"><strong>Objective:</strong> ${args.objective}</font>`;
      emitDelegateMessage(headerAndObjective);

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
          emitDelegateMessage(redText);
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
          emitDelegateMessage(`<font color="#888888"><em>${doneText}</em></font>`);
          return {
            content: [{ type: 'text' as const, text: `ollama: ${doneText}` }],
          };
        }

        emitDelegateMessage(responseText);
        return {
          content: [{ type: 'text' as const, text: `ollama: ${responseText}` }],
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const unavailable = `unavailable: ${reason}`;
        emitDelegateMessage(unavailable);
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
}
