/**
 * InfiniClaw delegate tools: delegate_to_lobe + query_local_llm.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';


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

  /**
   * Read the current work thread ID from last_event_ids.json.
   * Returns the workThreadId if set, or null if none.
   * Used by delegate_to_lobe to save and restore thread context.
   */
  function readCurrentWorkThread(): string | null {
    const idsFile = path.join(ctx.ipcDir, 'last_event_ids.json');
    try {
      if (!fs.existsSync(idsFile)) return null;
      const d = JSON.parse(fs.readFileSync(idsFile, 'utf-8')) as Record<string, string>;
      return typeof d.workThreadId === 'string' && d.workThreadId ? d.workThreadId : null;
    } catch { return null; }
  }

  const ollamaHost = process.env.OLLAMA_HOST || (process.env.NANOCLAW_IPC_DIR ? 'http://localhost:11434' : 'http://host.containers.internal:11434');

  // ── query_local_llm ───────────────────────────────────────────────────

  server.tool(
    'query_local_llm',
    `Query a local Ollama LLM running on the host machine. Use this for tasks that don't need Claude's full reasoning — summarization, formatting, extraction, classification, translation, or simple Q&A. Much faster and free.`,
    {
      prompt: z.string().describe('The prompt to send to the local LLM'),
      model: z.string().default('qwen3:14b').describe('Ollama model name (e.g., "qwen3:14b", "qwen3:30b-thinking", "devstral-small-2:24b")'),
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

  // ── delegate_to_lobe ──────────────────────────────────────────────────

  server.tool(
    'delegate_to_lobe',
    `Atomically delegate a task to a lobe (Codex, Gemini, Claude, or Ollama) with correct Matrix threading.

Available lobes and models:
- codex (default): gpt-5.3-codex (default), o3, o4-mini — file ops, code edits, shell commands
- gemini: gemini-3.1-pro-preview (default), gemini-2.5-flash — long-context analysis, research
- claude: sonnet (default), opus, haiku — parallel reasoning, supports effort param
- ollama: qwen3:30b-thinking (default, 30.5B reasoning), qwen3:14b (14.8B fast), devstral-small-2:24b (24B coding), devstral-2:latest (125B heavy), gpt-oss:20b (20.9B), nemotron-3-nano:30b (31.6B) — free local LLM, last resort fallback only

The tool handles the entire flow:
1. Posts summary to the main timeline
2. Captures that message's event ID for threading
3. Posts the objective in the thread
4. Runs the lobe subprocess with the objective
5. Posts the lobe response in the thread
6. Restores the previous work thread (or clears if none was active)
7. Returns the lobe output to the calling agent

You never need to call send_message, set_thread, or get_last_event_id manually for delegations.`,
    {
      reason: z.string().min(1).describe('Short reason shown on the main timeline, e.g. "Save memory: threading fix"'),
      objective: z.string().describe('Full detailed prompt/objective for the lobe to execute'),
      lobe: z.enum(['codex', 'gemini', 'claude', 'ollama']).default('codex').describe('Which lobe to use (default: codex)'),
      cwd: z.string().optional().describe('Working directory. Must be under /workspace/group or /workspace/extra.'),
      model: z.string().optional().describe('Optional model override for the lobe.'),
      effort: z.enum(['low', 'medium', 'high']).optional().describe('Thinking effort level (Claude only).'),
      system: z.string().optional().describe('Optional system prompt (Ollama only).'),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_DELEGATE_TIMEOUT_MS)
        .default(DEFAULT_DELEGATE_TIMEOUT_MS)
        .describe('Hard timeout for the lobe run in milliseconds (default 900000, max 3600000).'),
    },
    async (args) => {
      // Validate lobe-specific params
      const lobe = args.lobe ?? 'codex';
      if (args.effort && lobe !== 'claude') {
        return {
          content: [{ type: 'text' as const, text: `effort parameter is only supported for claude lobe, not ${lobe}` }],
          isError: true,
        };
      }
      if (args.system && lobe !== 'ollama') {
        return {
          content: [{ type: 'text' as const, text: `system parameter is only supported for ollama lobe, not ${lobe}` }],
          isError: true,
        };
      }

      // Save the active work thread before delegation so we can restore it after.
      // delegate_to_lobe always posts to the main timeline regardless of thread context,
      // and restores the previous thread when done rather than clearing it.
      const previousWorkThread = readCurrentWorkThread();

      // Resolve lobe and model first (needed for summary)
      const effectiveModel = (() => {
        if (args.model) return args.model;
        if (lobe === 'gemini') return firstSet(process.env.GEMINI_MODEL) || 'gemini-3.1-pro-preview';
        if (lobe === 'claude') return firstSet(process.env.ANTHROPIC_MODEL, process.env.CLAUDE_MODEL) || 'sonnet';
        if (lobe === 'ollama') return 'qwen3:14b';
        return firstSet(process.env.CODEX_MODEL, process.env.OPENAI_MODEL) || 'gpt-5.3-codex';
      })();
      const providerName = lobe.charAt(0).toUpperCase() + lobe.slice(1);

      // Step 1+2: Post summary to main timeline and capture event ID
      const summaryText = `\u{1F4AD} ${providerName}/${effectiveModel} - ${args.reason}`;
      const threadId = await sendAndGetEventId(summaryText, 10000);

      // Step 3: Post the objective in the thread with markdown formatting
      emitDelegateMessage(args.objective, threadId ?? undefined);

      // Step 4+5: Resolve cwd and run the lobe
      const cwdResult = resolveDelegateCwd(args.cwd);
      if (!cwdResult.ok) {
        const errText = `<font color="#cc0000">unavailable: ${cwdResult.error}</font>`;
        emitDelegateMessage(errText, threadId ?? undefined);
        if (threadId) setThread(previousWorkThread);
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

      // Ollama uses HTTP, not subprocess — handle before the subprocess promise
      if (lobe === 'ollama') {
        const prefixedMessages: string[] = [];
        let unavailableTriggered = false;
        const pushMsg = (text: string, isStatus = false) => {
          const normalized = text.replace(/\r/g, '').trim();
          if (!normalized) return;
          prefixedMessages.push(`${lobe}: ${normalized}`);
          const formatted = isStatus ? `<font color="#888888"><em>${normalized}</em></font>` : normalized;
          emitDelegateMessage(formatted, threadId ?? undefined);
        };
        const controller = new AbortController();
        const ollamaTimer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const body: Record<string, unknown> = {
            model: effectiveModel,
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
            unavailableTriggered = true;
            pushMsg(`unavailable: Ollama error (${res.status}): ${text}`, true);
          } else {
            const data = await res.json() as { response?: string };
            const responseText = (data.response || '').trim();
            if (responseText) {
              pushMsg(responseText);
            } else {
              pushMsg('completed with no textual output.', true);
            }
          }
        } catch (err) {
          unavailableTriggered = true;
          pushMsg(`unavailable: ${err instanceof Error ? err.message : String(err)}`, true);
        } finally {
          clearTimeout(ollamaTimer);
        }
        const ollamaResult: { content: Array<{ type: 'text'; text: string }>; isError?: boolean } = {
          content: [{ type: 'text' as const, text: prefixedMessages.join('\n\n') || `${lobe}: unavailable` }],
        };
        if (unavailableTriggered) ollamaResult.isError = true;
        if (threadId) setThread(previousWorkThread);
        return ollamaResult;
      }

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
              // Skip partial streaming deltas — they accumulate into final result
              if (event.type === 'content_block_delta') return;
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
            if (args.effort) claudeArgs.push('--effort', args.effort);
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

      // Step 6: Restore previous work thread (or clear if none was active).
      // This ensures the bot returns to its prior thread context after delegation,
      // rather than always landing on the main timeline.
      if (threadId) setThread(previousWorkThread);

      return result;
    },
  );
}
