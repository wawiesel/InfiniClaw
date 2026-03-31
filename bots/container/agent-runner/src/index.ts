/**
 * InfiniClaw Agent Runner — Claude Code CLI Runtime
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

import { spawn, execSync, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { formatToolCallWithOutput, GENERAL_PROGRESS_DEDUPE_MS } from './progress.js';
import { getRequestedMainModel } from './model-selection.js';

const ALLOWED_SLASH_COMMANDS = new Set(['/compact', '/clear', '/status']);

/**
 * Run a slash command via tmux. Claude Code only processes slash commands
 * from an interactive TTY — tmux provides the pseudo-TTY.
 *
 * 1. Start tmux session with `claude --resume`
 * 2. Wait for the interactive prompt (❯)
 * 3. send-keys the slash command
 * 4. Wait for completion (prompt reappears)
 * 5. Kill the tmux session
 */
async function runSlashCommand(
  command: string,
  sessionId: string | undefined,
  env: Record<string, string | undefined>,
): Promise<{ ok: boolean; output: string }> {
  if (!ALLOWED_SLASH_COMMANDS.has(command)) {
    return { ok: false, output: `rejected: ${command} not in allowlist` };
  }
  if (!sessionId) {
    return { ok: false, output: 'no session to compact' };
  }

  const tmuxSession = 'slash-cmd';
  const cwd = '/workspace/persona/temp';

  try {
    // Write env to a file so the tmux shell can source it (tmux can't inherit Node process env).
    // All auth, config, and credentials are already set up by the main startup code.
    const envFile = '/tmp/slash-cmd-env.sh';
    const envLines: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined && k.match(/^[A-Z_][A-Z0-9_]*$/)) {
        envLines.push(`export ${k}=${JSON.stringify(v)}`);
      }
    }
    fs.writeFileSync(envFile, envLines.join('\n'));

    // Launch script: source env, then call claude the same way the main process does
    const launchScript = '/tmp/slash-cmd-launch.sh';
    fs.writeFileSync(launchScript, `#!/bin/bash\nsource ${envFile}\ncd ${cwd}\nexec claude --resume ${sessionId} --dangerously-skip-permissions\n`);
    fs.chmodSync(launchScript, 0o755);

    // Kill any leftover session
    try { execSync(`tmux kill-session -t ${tmuxSession} 2>/dev/null`, { env: env as Record<string, string> }); } catch { /* */ }

    // Start tmux with the launch script
    execSync(`tmux new-session -d -s ${tmuxSession} ${launchScript}`, {
      env: env as Record<string, string>,
      timeout: 10_000,
    });

    // Wait for interactive prompt (❯)
    const waitForPrompt = async (timeoutMs: number): Promise<boolean> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const pane = execSync(`tmux capture-pane -t ${tmuxSession} -p`, {
            env: env as Record<string, string>,
            timeout: 5_000,
          }).toString();
          if (pane.includes('❯')) return true;
        } catch { /* tmux not ready */ }
        await new Promise(r => setTimeout(r, 500));
      }
      return false;
    };

    const ready = await waitForPrompt(60_000);
    if (!ready) {
      try { execSync(`tmux kill-session -t ${tmuxSession}`, { env: env as Record<string, string> }); } catch { /* */ }
      return { ok: false, output: 'timeout waiting for claude prompt' };
    }

    // Send the slash command
    execSync(`tmux send-keys -t ${tmuxSession} '${command}' Enter`, {
      env: env as Record<string, string>,
      timeout: 5_000,
    });

    // Wait for command to process, then ask for confirmation
    await new Promise(r => setTimeout(r, 3_000));

    // Wait for prompt to return after slash command
    const promptBack = await waitForPrompt(120_000);
    if (!promptBack) {
      try { execSync(`tmux kill-session -t ${tmuxSession}`, { env: env as Record<string, string> }); } catch { /* */ }
      return { ok: false, output: 'timeout waiting for slash command to finish' };
    }

    // Send confirmation request
    const confirmMsg = 'When you are finished compacting, reply with "DONE COMPACTING"';
    execSync(`tmux send-keys -t ${tmuxSession} '${confirmMsg}' Enter`, {
      env: env as Record<string, string>,
      timeout: 5_000,
    });

    // Poll for DONE COMPACTING in pane output (5 min timeout)
    const waitForConfirmation = async (timeoutMs: number): Promise<{ done: boolean; output: string }> => {
      const start = Date.now();
      let lastOutput = '';
      while (Date.now() - start < timeoutMs) {
        try {
          const pane = execSync(`tmux capture-pane -t ${tmuxSession} -p -S -100`, {
            env: env as Record<string, string>,
            timeout: 5_000,
          }).toString();
          lastOutput = pane;
          if (pane.includes('DONE COMPACTING')) return { done: true, output: pane };
        } catch { /* tmux not ready */ }
        await new Promise(r => setTimeout(r, 2_000));
      }
      return { done: false, output: lastOutput };
    };

    const result = await waitForConfirmation(300_000); // 5 min timeout

    // Capture final output
    let output = result.output.slice(-1000);

    // Kill session
    try { execSync(`tmux kill-session -t ${tmuxSession}`, { env: env as Record<string, string> }); } catch { /* */ }

    const verified = output.includes('DONE COMPACTING');
    return { ok: result.done && verified, output: output.slice(-500) };
  } catch (err) {
    try { execSync(`tmux kill-session -t ${tmuxSession}`, { env: env as Record<string, string> }); } catch { /* */ }
    return { ok: false, output: String(err) };
  }
}

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  forkSession?: boolean;
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
  isSessionError?: boolean;
  model?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

// Truncate older JSONL entries when session file exceeds this size (default 2MB).
// Prevents V8 heap spikes on --resume of large sessions (deserialization is 2-5x file size).
// Keeps session metadata (queue-operation, summary, last-prompt) and recent conversation turns.
const SESSION_MAX_BYTES = parseInt(process.env.SESSION_MAX_BYTES || String(2 * 1024 * 1024), 10);

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

// Locate a Claude Code session JSONL file by session ID.
function findSessionFile(sessionId: string): string | null {
  const projectsDir = path.join(process.env.HOME || '/home/node', '.claude', 'projects');
  try {
    if (!fs.existsSync(projectsDir)) return null;
    for (const dir of fs.readdirSync(projectsDir)) {
      const filePath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(filePath)) return filePath;
    }
  } catch { /* ignore */ }
  return null;
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
  forkSession: boolean | undefined,
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
    if (sessionId) {
      args.push('--resume', sessionId);
      if (forkSession) args.push('--fork-session');
    }
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
          let assistantText = '';
          for (const block of event.message.content) {
            if (block.type === 'tool_use') {
              currentToolName = block.name;
              currentToolInput = block.input;
              // In BB mode, emit tool activity so thread shows what BB is doing
              if (forkSession) emitProgress(`🔧 ${block.name}`);
            } else if (block.type === 'text' && typeof block.text === 'string') {
              assistantText += block.text;
            }
          }
          const trimmed = assistantText.trim();
          if (forkSession && trimmed) {
            // BB mode: emit full assistant text as progress for thread posting
            emitProgress(trimmed);
          } else if (trimmed && event.message.content.some((b: { type: string }) => b.type === 'tool_use')) {
            // Main brain: emit as thread-title hint (not displayed)
            emitProgress('\x00TITLE:' + trimmed.slice(0, 200));
          }
          return;
        }

        // Tool result — emit progress
        // Claude Code stream-json wraps tool results as: {"type":"user","message":{"content":[{"type":"tool_result",...}]}}
        if (event.type === 'user' && event.message?.content) {
          const blocks = Array.isArray(event.message.content) ? event.message.content : [];
          for (const block of blocks) {
            if (block.type === 'tool_result' && currentToolName) {
              const formatted = formatToolCallWithOutput(
                currentToolName,
                currentToolInput,
                block.content,
              );
              emitProgress(formatted);
              currentToolName = undefined;
              currentToolInput = undefined;
            }
          }
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

  const mcpConfig: Record<string, unknown> = {
    command: 'node',
    args: [mcpServerPath],
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    } as Record<string, string>,
  };

  // Forward proxy/cert vars to MCP server
  const mcpEnv = mcpConfig.env as Record<string, string>;
  const forwardVars = [
    'ASSISTANT_NAME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
    'GIT_SSL_CAINFO', 'INFINICLAW_ROOT', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NANOCLAW_DB_PATH',
  ];
  for (const key of forwardVars) {
    const val = env[key] || env[`NANOCLAW_${key}`];
    if (val) {
      const envKey = key === 'ASSISTANT_NAME' ? 'INFINICLAW_ASSISTANT_NAME' : key;
      mcpEnv[envKey] = val;
    }
  }

  const mcpServers: Record<string, unknown> = {
    infiniclaw: mcpConfig,
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
  // Set theme to prevent onboarding theme picker in tmux /compact sessions
  if (!settings.theme) settings.theme = 'dark';

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  // Also write project-level .mcp.json so Claude Code picks up the latest
  // chatJid even when enableAllProjectMcpServers is true (project-level
  // overrides global settings.json).
  const cwd = process.cwd();
  const projectMcpPath = path.join(cwd, '.mcp.json');
  fs.writeFileSync(projectMcpPath, JSON.stringify({ mcpServers }, null, 2));

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

  // Ensure ~/.claude.json exists — Claude Code refuses to start without it
  const claudeJsonPath = path.join(process.env.HOME || '/home/node', '.claude.json');
  if (!fs.existsSync(claudeJsonPath)) {
    // Restore from backup if available, otherwise create minimal config
    const backupDir = path.join(process.env.HOME || '/home/node', '.claude', 'backups');
    let restored = false;
    try {
      const backups = fs.readdirSync(backupDir).filter(f => f.startsWith('.claude.json.backup.')).sort();
      if (backups.length > 0) {
        fs.copyFileSync(path.join(backupDir, backups[backups.length - 1]), claudeJsonPath);
        log(`Restored .claude.json from backup: ${backups[backups.length - 1]}`);
        restored = true;
      }
    } catch { /* no backups */ }
    if (!restored) {
      fs.writeFileSync(claudeJsonPath, JSON.stringify({ firstStartTime: new Date().toISOString() }));
      log('Created minimal .claude.json');
    }
  }

  // Mark onboarding complete and trust the working directory — interactive mode
  // (tmux slash commands) shows prompts for these if missing. --print mode skips
  // them but doesn't persist the flags, so we set them here for both paths.
  try {
    const cj = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    let changed = false;
    if (!cj.hasCompletedOnboarding) {
      cj.hasCompletedOnboarding = true;
      cj.lastOnboardingVersion = '2.1.76';
      changed = true;
    }
    // Pre-approve the working directory so interactive mode doesn't prompt
    const cwd = '/workspace/persona/temp';
    if (!cj.projects?.[cwd]) {
      if (!cj.projects) cj.projects = {};
      cj.projects[cwd] = { allowedTools: [], hasTrustDialogAccepted: true };
      changed = true;
    }
    if (changed) fs.writeFileSync(claudeJsonPath, JSON.stringify(cj));
  } catch { /* best effort */ }

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
      // Rotate session if JSONL file exceeds size limit — prevents OOM on --resume.
      // Old session file is left on disk; a fresh session starts with a context note.
      if (sessionId && SESSION_MAX_BYTES > 0) {
        const sessionFile = findSessionFile(sessionId);
        if (sessionFile) {
          try {
            const { size } = fs.statSync(sessionFile);
            if (size > SESSION_MAX_BYTES) {
              const sizeKb = Math.round(size / 1024);
              const limitKb = Math.round(SESSION_MAX_BYTES / 1024);
              log(`Session file ${sizeKb}KB > ${limitKb}KB limit — rotating to new session (old session ${sessionId} left on disk)`);
              prompt = `[System note: previous session exceeded the ${limitKb}KB size limit and has been archived. A new session is starting. Continue from current task.]\n\n${prompt}`;
              sessionId = undefined;
              writeOutput({ status: 'success', result: null, newSessionId: undefined, isSessionError: true });
            }
          } catch { /* stat failed — proceed as-is */ }
        }
      }

      log(`Starting claude (session: ${sessionId || 'new'})...`);

      let runResult = await runClaude(
        prompt, sessionId, model,
        containerInput.disallowedTools, containerInput.forkSession, env, emitProgress,
      );

      // If claude failed with a session ID (stale session), retry without resume
      if (runResult.exitCode !== 0 && !runResult.result && !runResult.interrupted && sessionId) {
        log('Claude failed with session ID, retrying without --resume (stale session)');
        sessionId = undefined;
        writeOutput({ status: 'success', result: null, newSessionId: undefined, isSessionError: true });
        runResult = await runClaude(
          prompt, sessionId, model,
          containerInput.disallowedTools, false, env, emitProgress,
        );
      }

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

      // BB mode (forkSession): single run, no message loop
      if (containerInput.forkSession) {
        log('Branch brain mode — single run complete, exiting');
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
        // Check for slash commands — handle via tmux, not regular spawn
        const slashCmds = queued.filter(m => ALLOWED_SLASH_COMMANDS.has(m.trim()));
        const regularMsgs = queued.filter(m => !ALLOWED_SLASH_COMMANDS.has(m.trim()));
        for (const cmd of slashCmds) {
          log(`Running slash command via tmux: ${cmd}`);
          const result = await runSlashCommand(cmd.trim(), sessionId, env);
          log(`Slash command result: ok=${result.ok} output=${result.output.slice(0, 200)}`);
        }
        if (regularMsgs.length > 0) {
          log(`Found ${regularMsgs.length} queued messages, resuming`);
          prompt = regularMsgs.join('\n');
          continue;
        }
        // Only slash commands were queued — wait for more
      }

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      // Check if it's a slash command
      if (ALLOWED_SLASH_COMMANDS.has(nextMessage.trim())) {
        log(`Running slash command via tmux: ${nextMessage}`);
        const result = await runSlashCommand(nextMessage.trim(), sessionId, env);
        log(`Slash command result: ok=${result.ok} output=${result.output.slice(0, 200)}`);
        continue; // back to waiting
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
