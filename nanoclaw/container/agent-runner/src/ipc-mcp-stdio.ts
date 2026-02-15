/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
const DEFAULT_DELEGATE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_DELEGATE_TIMEOUT_MS = 60 * 60 * 1000;
const DELEGATE_CWD_ROOTS = ['/workspace/group', '/workspace/extra'];
const DELEGATE_CACHE_ROOT = '/workspace/cache';
const EXTRA_PATH_PREPEND = process.env.NANOCLAW_PATH_PREPEND || '';
const HOST_CERT_FALLBACK = '/workspace/host-certs/node_extra_ca_certs-corporate-certs.pem';
const CAPABILITY_STATE_FILE = '/workspace/cache/capability-budget-state.json';
type DelegateEnv = Record<string, string | undefined>;
type CapabilityState = {
  budgets: Record<string, number>;
  used: Record<string, number>;
};

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

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
    const parsed = JSON.parse(fs.readFileSync(CAPABILITY_STATE_FILE, 'utf-8')) as Partial<CapabilityState>;
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
  if (tokens <= 0) return;
  const key = capabilityKey(provider, model);
  const state = loadCapabilityState();
  state.used[key] = (state.used[key] || 0) + tokens;
  saveCapabilityState(state);
}

function listCapabilityUsageLines(): string[] {
  const state = loadCapabilityState();
  const keys = Array.from(
    new Set([...Object.keys(state.budgets), ...Object.keys(state.used)]),
  ).sort();
  if (keys.length === 0) {
    return ['No capability budgets configured yet.'];
  }
  return keys.map((key) => {
    const [provider, ...modelParts] = key.split(':');
    const model = modelParts.join(':');
    const used = state.used[key] || 0;
    const total = state.budgets[key];
    const remaining =
      typeof total === 'number' && total >= 0 ? Math.max(0, total - used) : null;
    return `${provider}/${model}: used=${used} tokens, remaining=${remaining === null ? 'unknown' : `${remaining} tokens`}`;
  });
}

function emitChatMessage(text: string, sender?: string): void {
  const data: Record<string, string | undefined> = {
    type: 'message',
    chatJid,
    text,
    sender: sender || undefined,
    groupFolder,
    timestamp: new Date().toISOString(),
  };
  writeIpcFile(MESSAGES_DIR, data);
}

function emitChatMessageTo(chatJidTarget: string, text: string, sender?: string): void {
  const data: Record<string, string | undefined> = {
    type: 'message',
    chatJid: chatJidTarget,
    text,
    sender: sender || undefined,
    groupFolder,
    timestamp: new Date().toISOString(),
  };
  writeIpcFile(MESSAGES_DIR, data);
}

function guessMimeTypeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

function resolveDelegateCwd(cwd?: string): { ok: true; cwd: string } | { ok: false; error: string } {
  const requested = cwd?.trim() || '/workspace/group';
  const resolved = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve('/workspace/group', requested);

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
      error:
        `cwd must be under ${DELEGATE_CWD_ROOTS.join(' or ')} (got: ${resolved})`,
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
  // Format: 💭 LobeName (Provider/model) in light grey
  const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
  return `<font color="#888888">💭 ${lobeName} <em>(${providerName}/${model})</em></font>`;
}

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

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    emitChatMessage(args.text, args.sender);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'delegate_commander',
  `Delegate an objective to the commander bot by sending a task message to the commander's chat.

Use this when acting as engineer infrastructure orchestrator.
Behavior:
- Sends a message to commander chat JID
- By default prefixes objective with "@commander " so commander trigger rules fire
- Returns an error if target chat JID is missing`,
  {
    objective: z.string().describe('Task/objective to hand off to commander'),
    target_chat_jid: z.string().optional().describe('Target chat JID for commander (defaults to ENGINEER_COMMANDER_CHAT_JID env if set)'),
    include_trigger: z.boolean().default(true).describe('If true, prefixes objective with "@commander "'),
    sender: z.string().default('engineer').describe('Sender label for the handoff message'),
  },
  async (args) => {
    const defaultTarget = process.env.ENGINEER_COMMANDER_CHAT_JID?.trim();
    const targetChatJid = (args.target_chat_jid || defaultTarget || '').trim();
    if (!targetChatJid) {
      return {
        content: [{ type: 'text' as const, text: 'Missing target chat JID. Set target_chat_jid or ENGINEER_COMMANDER_CHAT_JID.' }],
        isError: true,
      };
    }

    if (!isMain && targetChatJid !== chatJid) {
      return {
        content: [{ type: 'text' as const, text: 'Only MAIN can delegate to other chats. Run from main context.' }],
        isError: true,
      };
    }

    const body = args.include_trigger
      ? `@commander ${args.objective}`
      : args.objective;

    emitChatMessageTo(targetChatJid, body, args.sender);

    return {
      content: [{
        type: 'text' as const,
        text: `Delegated to commander (${targetChatJid}).`,
      }],
    };
  },
);

server.tool(
  'send_image',
  'Send an image file to the user or group. The file must exist in the container filesystem (e.g. /workspace/group/screenshot.png). Supports PNG, JPEG, GIF, WebP.',
  {
    file_path: z.string().describe('Absolute path to the image file in the container'),
    caption: z.string().optional().describe('Optional caption to display with the image'),
  },
  async (args) => {
    if (!fs.existsSync(args.file_path)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: ${args.file_path}` }],
        isError: true,
      };
    }

    const imageData = fs.readFileSync(args.file_path).toString('base64');
    const filename = path.basename(args.file_path);
    const mimetype = guessMimeTypeFromFilename(filename);

    writeIpcFile(MESSAGES_DIR, {
      type: 'image',
      chatJid,
      imageData,
      filename,
      mimetype,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text' as const, text: 'Image sent.' }] };
  },
);

server.tool(
  'send_file',
  'Send a file attachment to the user or group. The file must exist in the container filesystem (e.g. /workspace/group/report.pdf).',
  {
    file_path: z.string().describe('Absolute path to the file in the container'),
    caption: z.string().optional().describe('Optional message to send after the file'),
  },
  async (args) => {
    if (!fs.existsSync(args.file_path)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: ${args.file_path}` }],
        isError: true,
      };
    }

    const fileData = fs.readFileSync(args.file_path).toString('base64');
    const filename = path.basename(args.file_path);
    const mimetype = guessMimeTypeFromFilename(filename);

    writeIpcFile(MESSAGES_DIR, {
      type: 'file',
      chatJid,
      fileData,
      filename,
      mimetype,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text' as const, text: 'File sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'set_brain_mode',
  `Set InfiniClaw brain mode for a bot profile.

This updates profiles/<bot>/env in the InfiniClaw root and is intended for
operator use from engineer main context.

Modes:
- anthropic: clears base URL/auth token fields and sets model
- ollama: sets host Ollama base URL + auth token, and sets model

Note: bot restart is required for changes to take effect.`,
  {
    bot: z.enum(['engineer', 'commander']).describe('Bot profile to update'),
    mode: z.enum(['anthropic', 'ollama']).describe('Brain provider mode'),
    model: z.string().optional().describe('Optional model override for the selected mode'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only MAIN can change brain mode.' }],
        isError: true,
      };
    }

    const data = {
      type: 'set_brain_mode',
      bot: args.bot,
      mode: args.mode,
      model: args.model,
      chatJid,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{
        type: 'text' as const,
        text: `Brain mode update queued for ${args.bot} (${args.mode}). Restart required.`,
      }],
    };
  },
);

server.tool(
  'set_capability_budget',
  `Set approximate token budget for a provider/model capability.

These are local estimates for routing decisions, not provider-authoritative accounting.
`,
  {
    provider: z.string().describe('Capability provider name (e.g. anthropic, codex, gemini, ollama)'),
    model: z.string().describe('Model identifier'),
    total_tokens: z.number().int().positive().describe('Approximate total token budget'),
    reset_used: z.boolean().default(false).describe('Reset used token counter for this capability'),
  },
  async (args) => {
    const key = capabilityKey(args.provider, args.model);
    const state = loadCapabilityState();
    state.budgets[key] = args.total_tokens;
    if (args.reset_used) {
      state.used[key] = 0;
    }
    saveCapabilityState(state);
    return {
      content: [{
        type: 'text' as const,
        text: `Budget set for ${args.provider}/${args.model}: total=${args.total_tokens} tokens.`,
      }],
    };
  },
);

server.tool(
  'list_capability_budgets',
  `List approximate used and remaining tokens by provider/model capability.

Use this before delegation to choose the best provider/model given remaining budget.
`,
  {},
  async () => {
    const lines = listCapabilityUsageLines();
    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    };
  },
);

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
    const delegateHeader = formatDelegateSender(
      args.name,
      'codex',
      effectiveModel,
    );

    // Emit the lobe header and objective in one message
    const headerAndObjective = `${delegateHeader}\n<font color="#888888"><strong>Objective:</strong> ${args.objective}</font>`;
    emitChatMessage(headerAndObjective);

    const cwdResult = resolveDelegateCwd(args.cwd);
    if (!cwdResult.ok) {
      const unavailable = `unavailable: ${cwdResult.error}`;
      const redText = `<font color="#cc0000">${unavailable}</font>`;
      emitChatMessage(redText);
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
    codexArgs.push('--reasoning-effort', 'high');
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

      const pushMessage = (text: string) => {
        const normalized = text.replace(/\r/g, '').trim();
        if (!normalized) return;
        prefixedMessages.push(`codex: ${normalized}`);
        // Wrap lobe output in light grey
        const greyText = `<font color="#888888">${normalized}</font>`;
        emitChatMessage(greyText);
      };

      const failUnavailable = (reason: string) => {
        if (unavailableTriggered) return;
        unavailableTriggered = true;
        pushMessage(`unavailable: ${reason}`);
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
          // Non-JSON stdout line from Codex: pass through.
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
        emitChatMessage(redText);
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
    const delegateHeader = formatDelegateSender(
      args.name,
      'gemini',
      effectiveModel,
    );

    // Emit the lobe header and objective in one message
    const headerAndObjective = `${delegateHeader}\n<font color="#888888"><strong>Objective:</strong> ${args.objective}</font>`;
    emitChatMessage(headerAndObjective);

    const cwdResult = resolveDelegateCwd(args.cwd);
    if (!cwdResult.ok) {
      const unavailable = `unavailable: ${cwdResult.error}`;
      const redText = `<font color="#cc0000">${unavailable}</font>`;
      emitChatMessage(redText);
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

      const pushMessage = (text: string) => {
        const normalized = text.replace(/\r/g, '').trim();
        if (!normalized) return;
        prefixedMessages.push(`gemini: ${normalized}`);
        // Wrap lobe output in light grey
        const greyText = `<font color="#888888">${normalized}</font>`;
        emitChatMessage(greyText);
      };

      const failUnavailable = (reason: string) => {
        if (unavailableTriggered) return;
        unavailableTriggered = true;
        pushMessage(`unavailable: ${reason}`);
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
        emitChatMessage(redText);
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

const ollamaHost = process.env.OLLAMA_HOST || (process.env.NANOCLAW_IPC_DIR ? 'http://localhost:11434' : 'http://host.containers.internal:11434');

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
    const delegateHeader = formatDelegateSender(
      args.name,
      'ollama',
      args.model,
    );

    // Emit the lobe header and objective in one message
    const headerAndObjective = `${delegateHeader}\n<font color="#888888"><strong>Objective:</strong> ${args.objective}</font>`;
    emitChatMessage(headerAndObjective);

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
        emitChatMessage(redText);
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
        const greyText = `<font color="#888888">${doneText}</font>`;
        emitChatMessage(greyText);
        return {
          content: [{ type: 'text' as const, text: `ollama: ${doneText}` }],
        };
      }

      // Wrap lobe output in light grey
      const greyText = `<font color="#888888">${responseText}</font>`;
      emitChatMessage(greyText);
      return {
        content: [{ type: 'text' as const, text: `ollama: ${responseText}` }],
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const unavailable = `unavailable: ${reason}`;
      emitChatMessage(unavailable);
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

server.tool(
  'restart_self',
  `Request a graceful restart of the current bot process.

The host daemon will:
1. Stage your code changes and run \`tsc --noEmit\` to validate
2. If validation fails: stay running and report errors to chat — fix them and retry
3. If validation passes: send "restarting..." and exit for supervisor restart

Use this after making code changes that require a process restart.`,
  {
    bot: z.enum(['engineer', 'commander']).default('engineer').describe('Which bot to restart'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only MAIN can trigger restarts.' }],
        isError: true,
      };
    }

    const data = {
      type: 'restart_bot',
      bot: args.bot,
      chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Restart requested for ${args.bot}. The host daemon will handle the restart.` }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
