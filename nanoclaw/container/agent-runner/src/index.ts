/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  model?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const EXTRA_PATH_PREPEND = process.env.NANOCLAW_PATH_PREPEND || '';
const CAPABILITY_STATE_FILE = '/workspace/cache/capability-budget-state.json';
const MAIN_MODEL_ENV_KEY = 'ANTHROPIC_MODEL';
const TOOL_PROGRESS_EMIT_MS = 15_000;
const GENERAL_PROGRESS_DEDUPE_MS = 5_000;
const SDK_PROCESS_ENV_KEYS = [
  'ASSISTANT_NAME',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'INFINICLAW_ROOT',
  'ENGINEER_COMMANDER_CHAT_JID',
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
] as const;
const MAIN_DELEGATE_POLICY = `Main brain / lobe policy:
- You are one brain identity operating multiple lobes.
- Delegation means lobe cloning, not autonomous handoff.
- Each lobe gets a tightly-scoped objective with acceptance criteria and reports back for integration.
- MAIN brain stays user-responsive while lobes execute.
- For multi-step or long-running execution, launch lobes via mcp__nanoclaw__delegate_codex, mcp__nanoclaw__delegate_gemini, or mcp__nanoclaw__delegate_ollama.
- Lobe outputs are intermediate cognition. Collapse and integrate results back into one coherent MAIN response.
- Own final quality: verify lobe outputs, correct drift, and take responsibility for final results.
- Keep lobe control explicit: use delegate_list/delegate_status/delegate_cancel/delegate_amend to monitor and correct active runs.
- If user asks "what are you doing" during active work, provide concrete state (completed, running, next) immediately.`;

type CapabilityState = {
  budgets: Record<string, number>;
  used: Record<string, number>;
};

function capabilityKey(provider: string, model: string): string {
  return `${provider.trim().toLowerCase()}:${model.trim()}`;
}

function estimateTokens(text: string): number {
  const normalized = (text || '').trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function loadCapabilityState(): CapabilityState {
  try {
    if (!fs.existsSync(CAPABILITY_STATE_FILE)) {
      return { budgets: {}, used: {} };
    }
    const parsed = JSON.parse(
      fs.readFileSync(CAPABILITY_STATE_FILE, 'utf-8'),
    ) as Partial<CapabilityState>;
    return {
      budgets: parsed.budgets || {},
      used: parsed.used || {},
    };
  } catch {
    return { budgets: {}, used: {} };
  }
}

function saveCapabilityState(state: CapabilityState): void {
  fs.mkdirSync(path.dirname(CAPABILITY_STATE_FILE), { recursive: true });
  const tmp = `${CAPABILITY_STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, CAPABILITY_STATE_FILE);
}

function recordCapabilityUsage(provider: string, model: string, tokens: number): void {
  if (!model || tokens <= 0) return;
  const key = capabilityKey(provider, model);
  const state = loadCapabilityState();
  state.used[key] = (state.used[key] || 0) + tokens;
  saveCapabilityState(state);
}

const DEFAULT_ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
] as const;

// MAIN can do direct exploratory work, then delegate scale-out.
const MAIN_ALLOWED_TOOLS = DEFAULT_ALLOWED_TOOLS;

function getAllowedTools(isMainGroup: boolean): readonly string[] {
  return isMainGroup ? MAIN_ALLOWED_TOOLS : DEFAULT_ALLOWED_TOOLS;
}

function firstSet(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    const s = v?.trim();
    if (s) return s;
  }
  return undefined;
}

function getRequestedMainModel(env: Record<string, string | undefined>): string | undefined {
  return firstSet(env[MAIN_MODEL_ENV_KEY]);
}

function claudeModelFamily(model: string): 'opus' | 'sonnet' | 'haiku' | 'unknown' {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes('opus')) return 'opus';
  if (normalized.includes('sonnet')) return 'sonnet';
  if (normalized.includes('haiku')) return 'haiku';
  return 'unknown';
}

function modelMatchesRequest(requested: string, actual: string): boolean {
  const req = requested.trim().toLowerCase();
  const act = actual.trim().toLowerCase();
  if (!req || !act) return false;
  if (req === act) return true;

  // Allow family aliases (opus/sonnet/haiku) to match concrete dated models.
  const reqFamily = claudeModelFamily(req);
  const actFamily = claudeModelFamily(act);
  if (reqFamily !== 'unknown' && actFamily !== 'unknown' && reqFamily === actFamily) {
    return true;
  }

  return false;
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

function prependToPath(currentPath: string | undefined, prefix: string): string {
  if (!currentPath || currentPath.trim().length === 0) return prefix;
  const parts = currentPath.split(path.delimiter);
  if (parts.includes(prefix)) return currentPath;
  return `${prefix}${path.delimiter}${currentPath}`;
}

function applySdkProcessEnv(
  sdkEnv: Record<string, string | undefined>,
): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const key of SDK_PROCESS_ENV_KEYS) {
    previous[key] = process.env[key];
    const next = sdkEnv[key];
    if (typeof next === 'string' && next.length > 0) {
      process.env[key] = next;
    } else {
      delete process.env[key];
    }
  }

  return () => {
    for (const key of SDK_PROCESS_ENV_KEYS) {
      const prior = previous[key];
      if (typeof prior === 'string') {
        process.env[key] = prior;
      } else {
        delete process.env[key];
      }
    }
  };
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

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

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';

  const record = message as Record<string, unknown>;
  const fromEnvelope = record.message;
  const payload =
    fromEnvelope && typeof fromEnvelope === 'object'
      ? (fromEnvelope as Record<string, unknown>).content
      : record.content;

  if (typeof payload === 'string') {
    return payload.trim();
  }

  if (!Array.isArray(payload)) return '';

  const parts: string[] = [];
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue;
    const chunk = item as Record<string, unknown>;
    if (chunk.type !== 'text') continue;
    if (typeof chunk.text === 'string' && chunk.text.trim()) {
      parts.push(chunk.text.trim());
    }
  }

  return parts.join('\n').trim();
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
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
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  model?: string;
  closedDuringQuery: boolean;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let activeModel: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  const lastToolProgressAt = new Map<string, number>();
  let lastProgressText = '';
  let lastProgressAt = 0;
  let lastAssistantText = '';

  const emitProgress = (text: string): void => {
    const normalized = text.replace(/\r/g, '').replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    const now = Date.now();
    if (
      normalized === lastProgressText &&
      now - lastProgressAt < GENERAL_PROGRESS_DEDUPE_MS
    ) {
      return;
    }
    lastProgressText = normalized;
    lastProgressAt = now;
    writeOutput({
      status: 'success',
      result: normalized,
      newSessionId,
      model: activeModel,
    });
  };

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }
  const systemPromptAppend = [
    globalClaudeMd,
    containerInput.isMain ? MAIN_DELEGATE_POLICY : undefined,
  ]
    .filter((x): x is string => !!x && x.trim().length > 0)
    .join('\n\n');

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  const anthropicBaseUrl = sdkEnv.ANTHROPIC_BASE_URL;
  const configuredMainModel = getRequestedMainModel(sdkEnv);
  const mainIsClaude =
    containerInput.isMain && !isOllamaAnthropicBaseUrl(anthropicBaseUrl);
  if (mainIsClaude && !configuredMainModel) {
    throw new Error(
      `${MAIN_MODEL_ENV_KEY} is required for MAIN Claude runs`,
    );
  }
  const mainModel = mainIsClaude ? configuredMainModel : undefined;

  const restoreSdkProcessEnv = applySdkProcessEnv(sdkEnv);
  try {
    for await (const message of query({
      prompt: stream,
      options: {
        cwd: '/workspace/group',
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: sessionId,
        resumeSessionAt: resumeAt,
        systemPrompt: systemPromptAppend
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: systemPromptAppend }
          : undefined,
        model: mainModel,
        allowedTools: [...getAllowedTools(containerInput.isMain)],
        env: sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: {
          nanoclaw: {
            command: 'node',
            args: [mcpServerPath],
            env: {
              NANOCLAW_CHAT_JID: containerInput.chatJid,
              NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
              NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
              ...(sdkEnv.ASSISTANT_NAME
                ? { NANOCLAW_ASSISTANT_NAME: sdkEnv.ASSISTANT_NAME }
                : {}),
              ...(sdkEnv.HTTP_PROXY
                ? { HTTP_PROXY: sdkEnv.HTTP_PROXY }
                : {}),
              ...(sdkEnv.HTTPS_PROXY
                ? { HTTPS_PROXY: sdkEnv.HTTPS_PROXY }
                : {}),
              ...(sdkEnv.ALL_PROXY ? { ALL_PROXY: sdkEnv.ALL_PROXY } : {}),
              ...(sdkEnv.NO_PROXY ? { NO_PROXY: sdkEnv.NO_PROXY } : {}),
              ...(sdkEnv.SSL_CERT_FILE
                ? { SSL_CERT_FILE: sdkEnv.SSL_CERT_FILE }
                : {}),
              ...(sdkEnv.NODE_EXTRA_CA_CERTS
                ? { NODE_EXTRA_CA_CERTS: sdkEnv.NODE_EXTRA_CA_CERTS }
                : {}),
              ...(sdkEnv.REQUESTS_CA_BUNDLE
                ? { REQUESTS_CA_BUNDLE: sdkEnv.REQUESTS_CA_BUNDLE }
                : {}),
              ...(sdkEnv.CURL_CA_BUNDLE
                ? { CURL_CA_BUNDLE: sdkEnv.CURL_CA_BUNDLE }
                : {}),
              ...(sdkEnv.GIT_SSL_CAINFO
                ? { GIT_SSL_CAINFO: sdkEnv.GIT_SSL_CAINFO }
                : {}),
              ...(sdkEnv.INFINICLAW_ROOT
                ? { INFINICLAW_ROOT: sdkEnv.INFINICLAW_ROOT }
                : {}),
              ...(sdkEnv.ENGINEER_COMMANDER_CHAT_JID
                ? { ENGINEER_COMMANDER_CHAT_JID: sdkEnv.ENGINEER_COMMANDER_CHAT_JID }
                : {}),
              ...(sdkEnv.NODE_TLS_REJECT_UNAUTHORIZED
                ? {
                    NODE_TLS_REJECT_UNAUTHORIZED:
                      sdkEnv.NODE_TLS_REJECT_UNAUTHORIZED,
                  }
                : {}),
            },
          },
        },
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook()] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
        },
      }
    })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'assistant') {
      const assistantText = extractAssistantText(message);
      if (assistantText && assistantText !== lastAssistantText) {
        lastAssistantText = assistantText;
        emitProgress(assistantText);
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      activeModel = (message as { model?: string }).model?.trim() || activeModel;
      log(`Session initialized: ${newSessionId}`);
      if (
        containerInput.isMain &&
        configuredMainModel &&
        activeModel &&
        !modelMatchesRequest(configuredMainModel, activeModel)
      ) {
        throw new Error(
          `MAIN model mismatch: requested "${configuredMainModel}" but runtime initialized "${activeModel}"`,
        );
      }
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
      const summary = tn.summary?.trim();
      emitProgress(
        summary
          ? `task ${tn.status}: ${summary}`
          : `task ${tn.task_id} ${tn.status}`,
      );
    }

    if (message.type === 'system' && message.subtype === 'status') {
      const statusText = (message as { status?: string | null }).status?.trim();
      if (statusText) {
        emitProgress(`status: ${statusText}`);
      }
    }

    if (message.type === 'tool_progress') {
      const progress = message as {
        tool_use_id: string;
        tool_name: string;
        elapsed_time_seconds: number;
      };
      const toolUseId = progress.tool_use_id?.trim() || '';
      const now = Date.now();
      const lastEmittedAt = toolUseId ? (lastToolProgressAt.get(toolUseId) || 0) : 0;
      if (!toolUseId || now - lastEmittedAt >= TOOL_PROGRESS_EMIT_MS) {
        if (toolUseId) lastToolProgressAt.set(toolUseId, now);
        const elapsedSeconds = Math.max(
          1,
          Math.floor(progress.elapsed_time_seconds || 0),
        );
        emitProgress(
          `tool ${progress.tool_name} running (${elapsedSeconds}s)`,
        );
      }
    }

    if (message.type === 'tool_use_summary') {
      const summary = (message as { summary?: string }).summary?.trim();
      if (summary) {
        emitProgress(summary);
      }
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      const normalizedResult = (textResult || '')
        .replace(/\r/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (normalizedResult && normalizedResult === lastProgressText) {
        writeOutput({
          status: 'success',
          result: null,
          newSessionId,
          model: activeModel,
        });
        continue;
      }
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
        model: activeModel,
      });
    }
  }
  } finally {
    restoreSdkProcessEnv();
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, model: activeModel, closedDuringQuery };
}

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

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }
  if (EXTRA_PATH_PREPEND.trim().length > 0) {
    sdkEnv.PATH = prependToPath(sdkEnv.PATH, EXTRA_PATH_PREPEND);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  let activeModel: string | undefined;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.model) {
        activeModel = queryResult.model;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: sessionId,
        model: activeModel,
      });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      model: activeModel,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
