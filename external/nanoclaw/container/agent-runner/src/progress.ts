/**
 * InfiniClaw progress tracking and tool output formatting.
 * Used by the agent runner to format tool calls as HTML details elements
 * for display in Matrix threads.
 */

export const GENERAL_PROGRESS_DEDUPE_MS = 5_000;

export function formatToolCallWithOutput(name: string, input: unknown, response: unknown): string {
  const label = escapeHtml(describeToolCall(name, input));
  const inputText = escapeHtml(formatToolInput(name, input));
  const outputText = escapeHtml(formatToolResponse(response));
  return `<details><summary><code>🔧 ${label}</code></summary><b>Input:</b><pre><code>${inputText}</code></pre><b>Output:</b><pre><code>${outputText}</code></pre></details>`;
}

function formatToolInput(name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (name === 'Bash' && typeof obj.command === 'string') return obj.command;
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
  if (response && typeof response === 'object') {
    // Handle array of content blocks from stream-json
    if (Array.isArray(response)) {
      const texts = response
        .filter((b: unknown) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text')
        .map((b: unknown) => (b as Record<string, string>).text);
      if (texts.length > 0) return texts.join('\n');
    }
    return expandMultilineJson(JSON.stringify(response, null, 2));
  }
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

  if (typeof obj.description === 'string' && obj.description.trim()) {
    return `${name} - ${obj.description.trim()}`;
  }

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
    const short = obj.command.replace(/\s+/g, ' ').trim().slice(0, 60);
    return `${name} - ${short}`;
  }
  if (typeof obj.skill === 'string') return `${name} - ${obj.skill}`;
  return name;
}
