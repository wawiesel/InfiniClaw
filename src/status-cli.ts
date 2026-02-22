#!/usr/bin/env tsx
/**
 * NanoClaw Status CLI & MCP Server
 *
 * Usage:
 *   npx tsx src/status-cli.ts          # print once and exit
 *   npx tsx src/status-cli.ts --watch  # refresh every 5s
 *   npx tsx src/status-cli.ts --json   # JSON output
 *   npx tsx src/status-cli.ts --mcp    # stdio MCP server
 */
import path from 'path';

import { getSystemStatus, getRecentLogLines, getBotActivity, type SystemStatus, type BotStatus } from './status.js';

const ROOT_DIR = process.env.INFINICLAW_ROOT || path.resolve(process.cwd(), '..');

// ── CLI formatting ─────────────────────────────────────────────────

function relativeTime(iso: string | undefined): string {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 0) return 'in the future';
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string, max = 120): string {
  const stripped = stripHtml(text);
  return stripped.length > max ? stripped.slice(0, max - 3) + '...' : stripped;
}

function displayPath(p: string): string {
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

function serviceIndicator(s: 'running' | 'stopped'): string {
  return s === 'running' ? '\u25cf running' : '\u25cb stopped';
}

function formatBot(bot: BotStatus): string {
  const lines: string[] = [];
  const modelTag = bot.model ? ` (${bot.model})` : '';
  const pidTag = bot.pid ? `  PID ${bot.pid}` : '';
  const nameDisplay = bot.name.charAt(0).toUpperCase() + bot.name.slice(1);
  const heartbeatTag = bot.heartbeatStale
    ? '  \u26a0 STALE HEARTBEAT'
    : bot.lastHeartbeat
      ? `  heartbeat ${relativeTime(bot.lastHeartbeat)}`
      : '';
  lines.push(`${nameDisplay}${modelTag}     ${serviceIndicator(bot.service)}${pidTag}${heartbeatTag}`);

  // Containers
  if (bot.containers.length > 0) {
    for (const c of bot.containers) {
      lines.push(`  Container: ${c.name}  ${c.uptime}`);
    }
  } else {
    lines.push('  No active containers');
  }

  // Groups
  for (const g of bot.groups) {
    const activity = g.lastActivity ? relativeTime(g.lastActivity) : 'no activity';
    const objective = g.currentObjective ? ` \u2014 "${truncate(g.currentObjective, 80)}"` : '';
    lines.push(`  Group: ${g.name} (${activity})${objective}`);
    if (g.lastProgress) {
      const ago = g.lastProgressAt ? ` (${relativeTime(g.lastProgressAt)})` : '';
      lines.push(`    Last progress${ago}: ${truncate(g.lastProgress)}`);
    }
    if (g.lastError) {
      const ago = g.lastErrorAt ? ` (${relativeTime(g.lastErrorAt)})` : '';
      lines.push(`    Last error${ago}: ${truncate(g.lastError)}`);
    }
    if (g.containerLogDir) {
      lines.push(`    Container logs: ${displayPath(g.containerLogDir)}`);
    }
  }

  // Tasks
  const activeTasks = bot.tasks.filter((t) => t.status === 'active');
  const pausedTasks = bot.tasks.filter((t) => t.status === 'paused');
  const taskParts: string[] = [];
  if (activeTasks.length > 0) taskParts.push(`${activeTasks.length} active`);
  if (pausedTasks.length > 0) taskParts.push(`${pausedTasks.length} paused`);
  if (taskParts.length > 0) {
    lines.push(`  Tasks: ${taskParts.join(', ')}`);
  }

  // Token usage
  if (bot.tokenUsage && bot.tokenUsage.length > 0) {
    for (const t of bot.tokenUsage) {
      lines.push(`  Tokens (${t.model}): ${formatTokens(t.inputTokens)} in / ${formatTokens(t.outputTokens)} out / ${formatTokens(t.cacheReadTokens)} cache`);
    }
  }

  // Log files
  lines.push(`  Logs: ${displayPath(bot.logFiles.stderr)}`);
  lines.push(`         ${displayPath(bot.logFiles.stdout)}`);
  lines.push(`  DB:   ${displayPath(bot.logFiles.db)}`);

  return lines.join('\n');
}

function formatStatus(status: SystemStatus): string {
  const ts = new Date(status.timestamp).toLocaleString();
  const lines: string[] = [
    `InfiniClaw Status \u2014 ${ts}`,
    '\u2550'.repeat(50),
    '',
  ];

  if (!status.podmanRunning) {
    lines.push('\u26a0  Podman is not running!');
    lines.push('');
  }

  for (const bot of status.bots) {
    lines.push(formatBot(bot));
    lines.push('');
  }

  // Recent errors summary
  const hasErrors = status.bots.some((b) => b.recentErrors.length > 0);
  if (hasErrors) {
    lines.push('Recent Errors:');
    for (const bot of status.bots) {
      if (bot.recentErrors.length > 0) {
        const lastAt = bot.lastErrorAt ? ` (last: ${relativeTime(bot.lastErrorAt)})` : '';
        lines.push(`  [${bot.name}]${lastAt}`);
        for (const err of bot.recentErrors.slice(-3)) {
          // Strip ANSI codes and truncate
          const cleaned = err.replace(/\x1B\[[0-9;]*m/g, '').trim();
          const truncated = cleaned.length > 120 ? cleaned.slice(0, 117) + '...' : cleaned;
          lines.push(`    ${truncated}`);
        }
        lines.push(`    \u2192 ${displayPath(bot.logFiles.stderr)}`);
      }
    }
  } else {
    lines.push('Recent Errors: none');
  }

  return lines.join('\n');
}

// ── Mode: print once ───────────────────────────────────────────────

function printOnce(json: boolean): void {
  const status = getSystemStatus(ROOT_DIR);
  if (json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(formatStatus(status));
  }
}

// ── Mode: watch ────────────────────────────────────────────────────

function startWatch(json: boolean): void {
  const refresh = () => {
    const status = getSystemStatus(ROOT_DIR);
    // Clear screen
    process.stdout.write('\x1B[2J\x1B[H');
    if (json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(formatStatus(status));
      console.log('\nRefreshing every 5s. Press Ctrl+C to exit.');
    }
  };

  refresh();
  setInterval(refresh, 5000);
}

// ── Mode: MCP server ───────────────────────────────────────────────

async function startMcpServer(): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');

  const server = new McpServer({
    name: 'nanoclaw-status',
    version: '1.0.0',
  });

  server.tool(
    'get_status',
    'Get full system status: bot services, containers, groups, tasks, token usage, errors.',
    {},
    async () => {
      const status = getSystemStatus(ROOT_DIR);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
      };
    },
  );

  server.tool(
    'get_logs',
    'Get recent log lines from a bot.',
    {
      bot: z.enum(['engineer', 'commander']).describe('Which bot'),
      log_type: z.enum(['error', 'stdout']).default('error').describe('Log type'),
      lines: z.number().int().min(1).max(200).default(50).describe('Number of lines'),
    },
    async (args) => {
      const logLines = getRecentLogLines(ROOT_DIR, args.bot, args.log_type, args.lines);
      if (logLines.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No log entries found.' }] };
      }
      return {
        content: [{ type: 'text' as const, text: logLines.join('\n') }],
      };
    },
  );

  server.tool(
    'get_activity',
    'Get current activity for each bot — what they are working on right now.',
    {},
    async () => {
      const activities = getBotActivity(ROOT_DIR);
      const formatted = activities
        .map((a) => `[${a.bot}]\n${a.activity}`)
        .join('\n\n');
      return {
        content: [{ type: 'text' as const, text: formatted }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ── Main ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isMcp = args.includes('--mcp');
const isWatch = args.includes('--watch');
const isJson = args.includes('--json');

if (isMcp) {
  startMcpServer().catch((err) => {
    console.error('MCP server error:', err);
    process.exit(1);
  });
} else if (isWatch) {
  startWatch(isJson);
} else {
  printOnce(isJson);
}
