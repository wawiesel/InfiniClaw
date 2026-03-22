/**
 * Tests for the get_metrics MCP tool.
 *
 * The tool reads from:
 *  - ipcDir/status.json  (written by main.ts every 30s)
 *  - sessionDir/*.jsonl  (Claude Code session history for token counting)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerInfiniClawTools } from '../tools.js';

// ── test helpers ───────────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

/**
 * Create a minimal mock McpServer that captures registered tools by name.
 */
function makeMockServer(): { server: McpServer; handlers: Record<string, ToolHandler> } {
  const handlers: Record<string, ToolHandler> = {};
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  return { server, handlers };
}

/**
 * Register all tools with a temp ipcDir and optional sessionDir, return the handler map.
 */
function setupTools(ipcDir: string, sessionDir: string): Record<string, ToolHandler> {
  const { server, handlers } = makeMockServer();
  const noop = () => '';
  registerInfiniClawTools({
    server,
    writeIpcFile: noop,
    messagesDir: path.join(ipcDir, 'messages'),
    tasksDir: path.join(ipcDir, 'tasks'),
    ipcDir,
    chatJid: '!test:matrix.org',
    groupFolder: 'test',
    isMain: false,
    sessionDir,
  });
  return handlers;
}

/**
 * Call the get_metrics tool and return the text output.
 */
async function callGetMetrics(handlers: Record<string, ToolHandler>): Promise<string> {
  const result = await handlers['get_metrics']({});
  return result.content[0].text;
}

// ── fixtures ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let ipcDir: string;
let sessionDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'get-metrics-test-'));
  ipcDir = path.join(tmpDir, 'ipc');
  sessionDir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(ipcDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── tests ──────────────────────────────────────────────────────────────────────

describe('get_metrics', () => {
  it('returns unavailable message when status.json does not exist', async () => {
    const handlers = setupTools(ipcDir, sessionDir);
    const text = await callGetMetrics(handlers);
    expect(text).toContain('Status snapshot unavailable');
  });

  it('shows model, provider, and role from status.json', async () => {
    fs.writeFileSync(path.join(ipcDir, 'status.json'), JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      bot: 'testbot',
      role: 'engineer',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      groups: [],
    }));
    const handlers = setupTools(ipcDir, sessionDir);
    const text = await callGetMetrics(handlers);
    expect(text).toContain('claude-sonnet-4-6');
    expect(text).toContain('anthropic');
    expect(text).toContain('engineer');
  });

  it('shows active group with pendingTasks and no error', async () => {
    fs.writeFileSync(path.join(ipcDir, 'status.json'), JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      role: 'engineer',
      groups: [{
        name: 'engineering',
        active: true,
        hasProcess: true,
        pendingTasks: 3,
        currentObjective: 'implement feature X',
      }],
    }));
    const handlers = setupTools(ipcDir, sessionDir);
    const text = await callGetMetrics(handlers);
    expect(text).toContain('Group: engineering');
    expect(text).toContain('active=true');
    expect(text).toContain('pendingTasks=3');
    expect(text).toContain('objective: implement feature X');
  });

  it('shows last error with truncation at 120 chars', async () => {
    const longError = 'E'.repeat(130);
    fs.writeFileSync(path.join(ipcDir, 'status.json'), JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      model: 'm',
      provider: 'p',
      role: 'r',
      groups: [{
        name: 'engineering',
        active: false,
        lastError: longError,
        lastErrorAt: Date.now() - 60_000,
      }],
    }));
    const handlers = setupTools(ipcDir, sessionDir);
    const text = await callGetMetrics(handlers);
    expect(text).toContain('last error');
    expect(text).toContain('...');
    // Should show "(1m ago)" approximately
    expect(text).toMatch(/\(\d+m ago\)/);
  });

  it('shows verifications summary when present in status.json', async () => {
    fs.writeFileSync(path.join(ipcDir, 'status.json'), JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      model: 'm',
      provider: 'p',
      role: 'r',
      groups: [],
      verifications: { pending: 2, verified: 5, failed: 1, total: 8 },
    }));
    const handlers = setupTools(ipcDir, sessionDir);
    const text = await callGetMetrics(handlers);
    expect(text).toContain('Verifications:');
    expect(text).toContain('2 pending');
    expect(text).toContain('5 verified');
    expect(text).toContain('1 failed');
    expect(text).toContain('8 total');
  });

  it('omits verifications section when not in status.json', async () => {
    fs.writeFileSync(path.join(ipcDir, 'status.json'), JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      model: 'm',
      provider: 'p',
      role: 'r',
      groups: [],
    }));
    const handlers = setupTools(ipcDir, sessionDir);
    const text = await callGetMetrics(handlers);
    expect(text).not.toContain('Verifications:');
  });

  it('counts tokens from JSONL session files in the last 24h', async () => {
    const projectDir = path.join(sessionDir, '-workspace-test');
    fs.mkdirSync(projectDir, { recursive: true });
    const recentTs = new Date(Date.now() - 3_600_000).toISOString(); // 1h ago
    const entries = [
      { timestamp: recentTs, message: { usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
      { timestamp: recentTs, message: { usage: { input_tokens: 200, output_tokens: 80, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 } } },
    ];
    fs.writeFileSync(path.join(projectDir, 'session.jsonl'), entries.map(e => JSON.stringify(e)).join('\n'));

    const handlers = setupTools(ipcDir, sessionDir);
    const text = await callGetMetrics(handlers);
    // 100+50+0+0 + 200+80+10+5 = 445
    expect(text).toContain('445');
    expect(text).toContain('Token usage (1d)');
  });

  it('ignores JSONL entries older than 24h', async () => {
    const projectDir = path.join(sessionDir, '-workspace-test');
    fs.mkdirSync(projectDir, { recursive: true });
    const oldTs = new Date(Date.now() - 25 * 3_600_000).toISOString(); // 25h ago
    const entries = [
      { timestamp: oldTs, message: { usage: { input_tokens: 999, output_tokens: 999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ];
    fs.writeFileSync(path.join(projectDir, 'session.jsonl'), entries.map(e => JSON.stringify(e)).join('\n'));

    const handlers = setupTools(ipcDir, sessionDir);
    const text = await callGetMetrics(handlers);
    expect(text).toContain('Token usage: no session data found.');
  });

  it('shows no session data when sessionDir is empty', async () => {
    const handlers = setupTools(ipcDir, sessionDir);
    const text = await callGetMetrics(handlers);
    expect(text).toContain('Token usage: no session data found.');
  });

  it('shows snapshot timestamp', async () => {
    const ts = '2026-03-22T10:00:00.000Z';
    fs.writeFileSync(path.join(ipcDir, 'status.json'), JSON.stringify({
      timestamp: ts,
      model: 'm',
      provider: 'p',
      role: 'r',
      groups: [],
    }));
    const handlers = setupTools(ipcDir, sessionDir);
    const text = await callGetMetrics(handlers);
    expect(text).toContain(ts);
  });
});
