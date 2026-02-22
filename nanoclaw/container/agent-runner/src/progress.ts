/**
 * InfiniClaw progress tracking and tool hooks for the agent runner.
 * Tool output formatting, progress dedup, blocked tool enforcement.
 */
import type { HookCallback, PreToolUseHookInput, PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

// Secrets to strip from Bash tool subprocess environments.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
export const SANITIZE_PREFIX = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;

export const TOOL_PROGRESS_EMIT_MS = 15_000;
export const GENERAL_PROGRESS_DEDUPE_MS = 5_000;

const BLOCKED_TOOLS = new Set(['SendMessage', 'TeamCreate', 'TeamDelete']);

export function createToolProgressHook(emitFn: (text: string) => void): HookCallback {
  return async (input, _toolUseId, _context) => {
    const postInput = input as PostToolUseHookInput;
    const formatted = formatToolCallWithOutput(
      postInput.tool_name,
      postInput.tool_input,
      postInput.tool_response,
    );
    emitFn(formatted);
    return {};
  };
}

export function createBlockBuiltinToolsHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const toolName = preInput.tool_name;
    if (BLOCKED_TOOLS.has(toolName)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          decision: 'block',
          reason: `${toolName} is disabled. Use mcp__nanoclaw__send_message with the recipient parameter instead.`,
        },
      };
    }
    return {};
  };
}

function formatToolCallWithOutput(name: string, input: unknown, response: unknown): string {
  const label = escapeHtml(describeToolCall(name, input));
  const inputText = escapeHtml(formatToolInput(name, input));
  const outputText = escapeHtml(formatToolResponse(response));
  return `<details><summary><code>🔧 ${label}</code></summary><b>Input:</b><pre><code>${inputText}</code></pre><b>Output:</b><pre><code>${outputText}</code></pre></details>`;
}

function formatToolInput(name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (name === 'Bash' && typeof obj.command === 'string') {
      const cmd = obj.command;
      return cmd.startsWith(SANITIZE_PREFIX) ? cmd.slice(SANITIZE_PREFIX.length) : cmd;
    }
    if (name === 'Read' && typeof obj.file_path === 'string') return obj.file_path;
    if ((name === 'Edit' || name === 'Write') && typeof obj.file_path === 'string') return obj.file_path;
    if ((name === 'Grep' || name === 'Glob') && typeof obj.pattern === 'string') return obj.pattern;
    if (name === 'WebFetch' && typeof obj.url === 'string') return obj.url;
    if (name === 'WebSearch' && typeof obj.query === 'string') return obj.query;
    if (name === 'Task' && typeof obj.prompt === 'string') return obj.prompt;
    return expandMultilineJson(JSON.stringify(input, null, 2));
  }
  return String(input || '');
}

function formatToolResponse(response: unknown): string {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') return expandMultilineJson(JSON.stringify(response, null, 2));
  return String(response || '');
}

/** Expand escaped newlines in JSON string values into real newlines for readability. */
function expandMultilineJson(json: string): string {
  return json.replace(/"((?:[^"\\]|\\.)*)"/g, (_match, inner: string) => {
    if (!inner.includes('\\n')) return _match;
    return '"' + inner.replace(/\\n/g, '\n') + '"';
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function describeToolCall(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name;
  const obj = input as Record<string, unknown>;

  // Tools with an explicit description field
  if (typeof obj.description === 'string' && obj.description.trim()) {
    return `${name} - ${obj.description.trim()}`;
  }

  // Derive from input for other tools
  if (typeof obj.file_path === 'string') {
    const basename = obj.file_path.split('/').pop() || obj.file_path;
    return `${name} - ${basename}`;
  }
  if (typeof obj.pattern === 'string') return `${name} - ${obj.pattern}`;
  if (typeof obj.query === 'string') return `${name} - ${obj.query}`;
  if (typeof obj.url === 'string') {
    try { return `${name} - ${new URL(obj.url).hostname}`; } catch {}
  }
  if (typeof obj.prompt === 'string') {
    const short = obj.prompt.replace(/\s+/g, ' ').trim().slice(0, 60);
    return `${name} - ${short}`;
  }
  if (typeof obj.command === 'string') {
    let cmd = obj.command;
    if (cmd.startsWith(SANITIZE_PREFIX)) cmd = cmd.slice(SANITIZE_PREFIX.length);
    const short = cmd.replace(/\s+/g, ' ').trim().slice(0, 60);
    return `${name} - ${short}`;
  }
  if (typeof obj.skill === 'string') return `${name} - ${obj.skill}`;
  return name;
}
