/**
 * NanoClaw Agent Runner — Claude Code CLI Runtime
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 * Spawns `claude` CLI instead of using the Agent SDK directly.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: interrupt-<ts>.json — checked during claude run, triggers SIGTERM
 *          Files: message-<ts>.json  — drained between runs
 *          Files: context-<ts>.json  — drained between runs (lower priority)
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (progress, final result).
 *   Final marker after loop ends signals completion.
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { formatToolCallWithOutput, GENERAL_PROGRESS_DEDUPE_MS } from './progress.js';
import { getRequestedMainModel } from './model-selection.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
  mcpServers?: Record<string, Record<string, unknown>>;
  disallowedTools?: string[];
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  isProgress?: boolean;
  model?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

// --- IPC helpers ---

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

interface IpcMessage {
  type: 'interrupt' | 'message' | 'context';
  text: string;
}

/**
 * Check for interrupt IPC files (interrupt-*.json).
 * Returns the first interrupt found, or null.
 */
function checkForInterrupt(): IpcMessage | null {
  try {
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.startsWith('interrupt-') && f.endsWith('.json'))
      .sort();

    if (files.length === 0) return null;

    const filePath = path.join(IPC_INPUT_DIR, files[0]);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as IpcMessage;
    fs.unlinkSync(filePath);

    // Clean up remaining interrupts — only the first matters
    for (let i = 1; i < files.length; i++) {
      try { fs.unlinkSync(path.join(IPC_INPUT_DIR, files[i])); } catch { /* ignore */ }
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Drain all pending IPC input messages (message-*.json and context-*.json).
 * Returns messages in priority order: messages first, then context.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const allFiles = fs.readdirSync(IPC_INPUT_DIR).sort();

    // Also check for interrupts that arrived while idle
    const interruptFiles = allFiles.filter(f => f.startsWith('interrupt-') && f.endsWith('.json'));
    const messageFiles = allFiles.filter(f => f.startsWith('message-') && f.endsWith('.json'));
    const contextFiles = allFiles.filter(f => f.startsWith('context-') && f.endsWith('.json'));
    // Legacy format: plain timestamp-random.json files
    const legacyFiles = allFiles.filter(f => f.endsWith('.json') &&
      !f.startsWith('interrupt-') && !f.startsWith('message-') &&
      !f.startsWith('context-') && !f.startsWith('0-'));

    const orderedFiles = [...interruptFiles, ...messageFiles, ...legacyFiles, ...contextFiles];

    const messages: string[] = [];
    for (const file of orderedFiles) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.text) {
          messages.push(data.text);
        } else if (data.type === 'message' && typeof data.text === 'undefined') {
          // Legacy format with just {type: "message", text: "..."}
          continue;
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      // Drain messages BEFORE checking close sentinel so pre-close
      // injected messages (e.g. memory-save prompts) are not lost.
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      if (shouldClose()) {
        resolve(null);
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// --- Claude CLI spawning ---

interface ClaudeRunResult {
  sessionId?: string;
  result?: string;
  interrupted: boolean;
  interruptMessage?: IpcMessage;
  closedDuringRun: boolean;
  exitCode: number | null;
}

/**
 * Spawn claude CLI and stream results.
 * Polls for interrupts during the run — sends SIGTERM if interrupt found.
 */
function runClaude(
  prompt: string,
  sessionId: string | undefined,
  model: string | undefined,
  disallowedTools: string[] | undefined,
  env: Record<string, string | undefined>,
  emitProgress: (text: string) => void,
): Promise<ClaudeRunResult> {
  return new Promise((resolve) => {
    const args = [
      '--print', '--verbose',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
    ];
    if (model) args.push('--model', model);
    if (sessionId) args.push('--resume', sessionId);
    if (disallowedTools?.length) args.push('--disallowed-tools', disallowedTools.join(','));

    log(`Spawning claude: ${args.join(' ')}`);

    const proc = spawn('claude', args, {
      cwd: '/workspace/persona/temp',
      env: env as Record<string, string>,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdin!.write(prompt);
    proc.stdin!.end();

    let newSessionId: string | undefined;
    let result: string | undefined;
    let interrupted = false;
    let interruptMessage: IpcMessage | undefined;
    let closedDuringRun = false;
    let stdoutBuffer = '';
    let stderrLines: string[] = [];

    // Track tool calls for progress emission
    let currentToolName: string | undefined;
    let currentToolInput: unknown;

    // Poll for interrupts while claude is running
    let polling = true;
    const pollInterrupts = () => {
      if (!polling) return;

      // Check close sentinel
      if (shouldClose()) {
        log('Close sentinel detected during claude run');
        closedDuringRun = true;
        proc.kill('SIGTERM');
        polling = false;
        return;
      }

      // Check for interrupt messages
      const interrupt = checkForInterrupt();
      if (interrupt) {
        log(`Interrupt received: ${interrupt.text.slice(0, 100)}`);
        interrupted = true;
        interruptMessage = interrupt;
        proc.kill('SIGTERM');
        polling = false;
        return;
      }

      setTimeout(pollInterrupts, IPC_POLL_MS);
    };
    setTimeout(pollInterrupts, IPC_POLL_MS);

    const handleStdoutLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const event = JSON.parse(trimmed);

        // System init — capture session ID
        if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
          newSessionId = event.session_id;
          log(`Session initialized: ${newSessionId}`);
          return;
        }

        // Tool use — capture for progress
        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'tool_use') {
              currentToolName = block.name;
              currentToolInput = block.input;
            }
          }
          return;
        }

        // Tool result — emit progress
        if (event.type === 'tool_result') {
          if (currentToolName) {
            const formatted = formatToolCallWithOutput(
              currentToolName,
              currentToolInput,
              event.content,
            );
            emitProgress(formatted);
          }
          currentToolName = undefined;
          currentToolInput = undefined;
          return;
        }

        // Final result
        if (event.type === 'result' && typeof event.result === 'string') {
          result = event.result;
          return;
        }

        // Skip content_block_delta (streaming fragments)
        if (event.type === 'content_block_delta') return;

        // Error
        if (event.type === 'error') {
          log(`Claude error event: ${event.message || JSON.stringify(event)}`);
          return;
        }
      } catch {
        // Not JSON — log as plain text
        log(`Claude stdout: ${trimmed.slice(0, 200)}`);
      }
    };

    proc.stdout!.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      while (true) {
        const idx = stdoutBuffer.indexOf('\n');
        if (idx === -1) break;
        handleStdoutLine(stdoutBuffer.slice(0, idx));
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
      }
    });

    proc.stderr!.on('data', (chunk: Buffer | string) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        stderrLines.push(trimmed);
        if (stderrLines.length > 100) stderrLines.shift();
      }
    });

    proc.on('error', (err) => {
      polling = false;
      log(`Claude spawn error: ${err.message}`);
      resolve({
        sessionId: newSessionId,
        interrupted: false,
        closedDuringRun: false,
        exitCode: null,
      });
    });

    proc.on('close', (code, signal) => {
      polling = false;
      // Process any remaining stdout
      if (stdoutBuffer.trim()) handleStdoutLine(stdoutBuffer);

      if (code !== 0 && !interrupted && !closedDuringRun) {
        log(`Claude exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`);
        if (stderrLines.length > 0) {
          log(`Last stderr: ${stderrLines.slice(-5).join('\n')}`);
        }
      }

      resolve({
        sessionId: newSessionId,
        result,
        interrupted,
        interruptMessage,
        closedDuringRun,
        exitCode: code,
      });
    });
  });
}

// --- MCP config ---

function writeMcpConfig(containerInput: ContainerInput, env: Record<string, string | undefined>): void {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  const nanoclaw: Record<string, unknown> = {
    command: 'node',
    args: [mcpServerPath],
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    } as Record<string, string>,
  };

  // Forward proxy/cert vars to MCP server
  const nanocrawEnv = nanoclaw.env as Record<string, string>;
  const forwardVars = [
    'ASSISTANT_NAME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
    'GIT_SSL_CAINFO', 'INFINICLAW_ROOT', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NANOCLAW_DB_PATH',
  ];
  for (const key of forwardVars) {
    const val = env[key] || env[`NANOCLAW_${key}`];
    if (val) {
      const envKey = key === 'ASSISTANT_NAME' ? 'NANOCLAW_ASSISTANT_NAME' : key;
      nanocrawEnv[envKey] = val;
    }
  }

  const mcpServers: Record<string, unknown> = {
    nanoclaw,
  };

  // Add validated external MCP servers
  if (containerInput.mcpServers) {
    for (const [name, config] of Object.entries(containerInput.mcpServers)) {
      mcpServers[name] = config;
    }
  }

  // Write to Claude Code's settings
  const settingsDir = path.join(process.env.HOME || '/home/node', '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, 'settings.json');

  let settings: Record<string, unknown> = {};
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch { /* start fresh */ }

  settings.mcpServers = mcpServers;

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  log(`Wrote MCP config with servers: ${Object.keys(mcpServers).join(', ')}`);
}

// --- Stdin reader ---

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// --- Main ---

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Build env: merge secrets into a clean env for the claude subprocess.
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    env[key] = value;
  }

  // Write MCP config before first claude spawn
  writeMcpConfig(containerInput, env);

  const model = getRequestedMainModel(env);
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Progress dedup state
  let lastProgressText = '';
  let lastProgressAt = 0;
  const emitProgress = (text: string): void => {
    const cleaned = text.replace(/\r/g, '').trim();
    if (!cleaned) return;
    const dedup = cleaned.replace(/\s+/g, ' ');
    const now = Date.now();
    if (dedup === lastProgressText && now - lastProgressAt < GENERAL_PROGRESS_DEDUPE_MS) {
      return;
    }
    lastProgressText = dedup;
    lastProgressAt = now;
    writeOutput({
      status: 'success',
      result: cleaned,
      isProgress: true,
      newSessionId: sessionId,
      model,
    });
  };

  // Session ID — Claude Code manages sessions, we just track the ID for the host
  let sessionId = containerInput.sessionId;

  // Main loop: run claude -> check for messages -> resume
  try {
    while (true) {
      log(`Starting claude (session: ${sessionId || 'new'})...`);

      const runResult = await runClaude(
        prompt, sessionId, model,
        containerInput.disallowedTools, env, emitProgress,
      );

      // Update session ID from the run
      if (runResult.sessionId) {
        sessionId = runResult.sessionId;
      }

      // Emit result if we got one
      if (runResult.result) {
        writeOutput({
          status: 'success',
          result: runResult.result,
          newSessionId: sessionId,
          model,
        });
      }

      // Close sentinel consumed during run — exit immediately
      if (runResult.closedDuringRun) {
        log('Close sentinel consumed during run, exiting');
        break;
      }

      // Interrupted — resume immediately with interrupt message
      if (runResult.interrupted && runResult.interruptMessage) {
        log('Resuming with interrupt message');
        prompt = runResult.interruptMessage.text;
        continue;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Claude finished, waiting for next IPC message...');

      // Drain any queued messages
      const queued = drainIpcInput();
      if (queued.length > 0) {
        log(`Found ${queued.length} queued messages, resuming`);
        prompt = queued.join('\n');
        continue;
      }

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), resuming`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
