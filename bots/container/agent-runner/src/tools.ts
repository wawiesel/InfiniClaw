/**
 * InfiniClaw MCP tool registration.
 * All InfiniClaw-specific tools delegated from the base ipc-mcp-stdio.ts.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  guessMimeTypeFromFilename,
} from './bot-messaging.js';

import { registerDelegateTools } from './delegate-runner.js';

type WriteIpcFile = (dir: string, data: object) => string;

export interface ToolRegistrationContext {
  server: McpServer;
  writeIpcFile: WriteIpcFile;
  messagesDir: string;
  tasksDir: string;
  ipcDir: string;
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

/** Extract a human-readable message from an unknown error value. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerInfiniClawTools(ctx: ToolRegistrationContext): void {
  const { server, writeIpcFile, messagesDir, tasksDir, ipcDir, chatJid, groupFolder, isMain } = ctx;

  // ── Reactions ───────────────────────────────────────────────────────

  server.tool(
    'send_reaction',
    'React to a message with an emoji instead of sending a text reply. Use this when you have nothing substantive to add but want to acknowledge a message. Call get_last_event_id first to get the event ID.',
    {
      event_id: z.string().describe('Matrix event ID of the message to react to (e.g. $abc123)'),
      emoji: z.string().describe('Single emoji to react with (e.g. 👍, ✅, 🎉)'),
    },
    async (args) => {
      writeIpcFile(tasksDir, {
        type: 'send_reaction',
        chatJid,
        eventId: args.event_id,
        emoji: args.emoji,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `Reacted with ${args.emoji}` }] };
    },
  );

  // ── File sending ────────────────────────────────────────────────────

  function sendFileIpc(filePath: string, ipcType: 'image' | 'file', caption?: string): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
    if (!fs.existsSync(filePath)) {
      return { content: [{ type: 'text' as const, text: `File not found: ${filePath}` }], isError: true };
    }
    const data = fs.readFileSync(filePath).toString('base64');
    const filename = path.basename(filePath);
    const mimetype = guessMimeTypeFromFilename(filename);
    const dataKey = ipcType === 'image' ? 'imageData' : 'fileData';
    writeIpcFile(messagesDir, {
      type: ipcType,
      chatJid,
      [dataKey]: data,
      filename,
      mimetype,
      caption: caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `${ipcType === 'image' ? 'Image' : 'File'} sent.` }] };
  }

  server.tool(
    'send_image',
    'Send an image file to the user or group. The file must exist in the container filesystem (e.g. /workspace/persona/temp/screenshot.png). Supports PNG, JPEG, GIF, WebP.',
    {
      file_path: z.string().describe('Absolute path to the image file in the container'),
      caption: z.string().optional().describe('Optional caption to display with the image'),
    },
    async (args) => sendFileIpc(args.file_path, 'image', args.caption),
  );

  server.tool(
    'send_file',
    'Send a file attachment to the user or group. The file must exist in the container filesystem (e.g. /workspace/persona/temp/report.pdf).',
    {
      file_path: z.string().describe('Absolute path to the file in the container'),
      caption: z.string().optional().describe('Optional message to send after the file'),
    },
    async (args) => sendFileIpc(args.file_path, 'file', args.caption),
  );

  // ── Brain mode ──────────────────────────────────────────────────────

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
      bot: z.string().describe('Persona name of the bot (e.g. nora, cid, johnny5)'),
      mode: z.enum(['anthropic', 'ollama']).describe('Brain provider mode'),
      model: z.string().optional().describe('Optional model override for the selected mode'),
    },
    async (args) => {
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
      writeIpcFile(tasksDir, data);

      return {
        content: [{
          type: 'text' as const,
          text: `Brain mode update queued for ${args.bot} (${args.mode}/${args.model || (args.mode === 'anthropic' ? 'claude-sonnet-4-5' : 'devstral-small-2-fast:latest')}). Restart required.`,
        }],
      };
    },
  );

  // ── Bot management ──────────────────────────────────────────────────

  server.tool(
    'restart_self',
    `Request a graceful restart of the current bot process.

The host daemon will:
1. Stage your code changes and run \`tsc --noEmit\` to validate
2. If validation fails: stay running and report errors to chat — fix them and retry
3. If validation passes: send "restarting..." and exit for relay restart

Use this after making code changes that require a process restart.`,
    {
      bot: z.string().default(
        (process.env.INFINICLAW_ASSISTANT_NAME || 'bot').toLowerCase(),
      ).describe('Persona name of the bot to restart (e.g. nora, cid, johnny5)'),
    },
    async (args) => {
      if (!isMain) {
        return {
          content: [{ type: 'text' as const, text: 'Only MAIN can trigger restarts.' }],
          isError: true,
        };
      }

      const data = {
        type: 'refresh_bot',
        bot: args.bot,
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      };
      writeIpcFile(tasksDir, data);

      return {
        content: [{ type: 'text' as const, text: `Refresh requested for ${args.bot}. The host daemon will handle the refresh.` }],
      };
    },
  );

  server.tool(
    'get_brain_mode',
    'Get the current brain mode (anthropic or ollama) and model for each bot. Reads from the host status snapshot.',
    {},
    async () => {
      const statusPath = path.join(ipcDir, 'status.json');
      if (!fs.existsSync(statusPath)) {
        return {
          content: [{ type: 'text' as const, text: 'No status snapshot available yet.' }],
        };
      }

      try {
        const raw = fs.readFileSync(statusPath, 'utf-8');
        const status = JSON.parse(raw) as { brainModes?: Record<string, { mode: string; model: string }> };
        if (!status.brainModes) {
          return {
            content: [{ type: 'text' as const, text: 'Brain modes not available in status snapshot. Host may need restart.' }],
          };
        }
        const lines = Object.entries(status.brainModes).map(
          ([bot, info]) => `${bot}: ${info.mode} (${info.model || 'no model'})`,
        );
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to read brain modes: ${errMsg(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_last_event_id',
    'Get the Matrix event ID of the last message received in this room. Use this event ID as the thread_id parameter in send_message to create or reply in a Matrix thread.',
    {},
    async () => {
      const idsFile = path.join(ipcDir, 'last_event_ids.json');
      if (!fs.existsSync(idsFile)) {
        return {
          content: [{ type: 'text' as const, text: 'No event IDs recorded yet. Send or receive a Matrix message first.' }],
        };
      }
      try {
        const data = JSON.parse(fs.readFileSync(idsFile, 'utf-8')) as Record<string, string>;
        const lines: string[] = [];
        if (data.lastReceived) lines.push(`lastReceived: ${data.lastReceived}${data.lastReceivedAt ? ` (at ${data.lastReceivedAt})` : ''}`);
        if (data.lastSent) lines.push(`lastSent: ${data.lastSent}${data.lastSentAt ? ` (at ${data.lastSentAt})` : ''}`);
        if (lines.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No event IDs recorded yet.' }] };
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to read event IDs: ${errMsg(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_message',
    'Retrieve Matrix messages. Pass `id` to fetch a single event by ID. Omit `id` to fetch recent messages from the duty room (last `minutes` minutes, up to `limit` results).',
    {
      id: z.string().optional().describe('Matrix event ID (e.g. $abc123) — fetches that single message'),
      minutes: z.number().optional().describe('Time window in minutes for recent messages (default 30). Ignored when id is provided.'),
      limit: z.number().optional().describe('Max messages to return in time-range mode (default 50). Ignored when id is provided.'),
    },
    async (args) => {
      const homeserver = process.env.MATRIX_HOMESERVER;
      const accessToken = process.env.MATRIX_ACCESS_TOKEN;
      if (!homeserver || !accessToken) {
        return { content: [{ type: 'text' as const, text: 'Matrix credentials not available — MATRIX_HOMESERVER or MATRIX_ACCESS_TOKEN not set.' }], isError: true };
      }
      const roomId = chatJid.replace(/^matrix:/, '');
      try {
        if (args.id) {
          // Single-event lookup
          const url = `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(args.id)}`;
          const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (!res.ok) {
            const body = await res.text();
            return { content: [{ type: 'text' as const, text: `Matrix API error (${res.status}): ${body}` }], isError: true };
          }
          const event = await res.json() as { sender?: string; origin_server_ts?: number; content?: { body?: string; msgtype?: string; formatted_body?: string } };
          const sender = event.sender ?? 'unknown';
          const ts = event.origin_server_ts ? new Date(event.origin_server_ts).toISOString() : 'unknown';
          const content = event.content?.body ?? event.content?.formatted_body ?? JSON.stringify(event.content);
          return {
            content: [{ type: 'text' as const, text: `From: ${sender}\nTime: ${ts}\nContent: ${content}` }],
          };
        } else {
          // Time-range lookup: fetch backwards from now, filter by age
          const minutes = args.minutes ?? 30;
          const limit = args.limit ?? 50;
          const cutoff = Date.now() - minutes * 60 * 1000;
          const url = `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`;
          const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (!res.ok) {
            const body = await res.text();
            return { content: [{ type: 'text' as const, text: `Matrix API error (${res.status}): ${body}` }], isError: true };
          }
          type MsgEvent = { type?: string; sender?: string; origin_server_ts?: number; content?: { body?: string; msgtype?: string } };
          const data = await res.json() as { chunk?: MsgEvent[] };
          const events = (data.chunk ?? [])
            .filter((e) => e.type === 'm.room.message' && e.content?.msgtype === 'm.text' && (e.origin_server_ts ?? 0) >= cutoff)
            .reverse(); // oldest first
          if (events.length === 0) {
            return { content: [{ type: 'text' as const, text: `No messages in the last ${minutes} minute(s).` }] };
          }
          const lines = events.map((e) => {
            const ts = e.origin_server_ts ? new Date(e.origin_server_ts) : new Date();
            const hhmm = ts.toISOString().slice(11, 16);
            const senderLocal = (e.sender ?? 'unknown').replace(/^@([^:]+):.+$/, '$1');
            const body = e.content?.body ?? '';
            return `[${hhmm}] ${senderLocal}: ${body}`;
          });
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Failed to retrieve message(s): ${errMsg(err)}` }], isError: true };
      }
    },
  );

  // ── Holodeck management ────────────────────────────────────────────

  server.tool(
    'holodeck_create',
    `Create a holodeck test instance from a git branch.

Deploys the branch to an isolated instance that runs in terminal-only mode (no Matrix).
Use holodeck_send to inject test messages and holodeck_read to check responses.`,
    {
      bot: z.string().describe('Persona name of the bot to create a holodeck for'),
      branch: z.string().describe('Git branch name to deploy'),
    },
    async (args) => {
      if (!isMain) {
        return { content: [{ type: 'text' as const, text: 'Only MAIN can manage holodecks.' }], isError: true };
      }
      writeIpcFile(tasksDir, {
        type: 'holodeck_create',
        bot: args.bot,
        branch: args.branch,
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `Holodeck create queued for ${args.bot} (branch: ${args.branch}).` }] };
    },
  );

  server.tool(
    'holodeck_teardown',
    'Tear down a holodeck test instance. Stops the service, removes the instance and worktree.',
    {
      bot: z.string().describe('Persona name of the bot holodeck to tear down'),
    },
    async (args) => {
      if (!isMain) {
        return { content: [{ type: 'text' as const, text: 'Only MAIN can manage holodecks.' }], isError: true };
      }
      writeIpcFile(tasksDir, {
        type: 'holodeck_teardown',
        bot: args.bot,
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `Holodeck teardown queued for ${args.bot}.` }] };
    },
  );

  server.tool(
    'holodeck_promote',
    'Promote a holodeck instance — merges the feature branch into main and redeploys the live bot.',
    {
      bot: z.string().describe('Persona name of the bot holodeck to promote'),
    },
    async (args) => {
      if (!isMain) {
        return { content: [{ type: 'text' as const, text: 'Only MAIN can manage holodecks.' }], isError: true };
      }
      writeIpcFile(tasksDir, {
        type: 'holodeck_promote',
        bot: args.bot,
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `Holodeck promote queued for ${args.bot}.` }] };
    },
  );

  server.tool(
    'holodeck_send',
    'Send a test message to a holodeck bot instance. Injects the message into the holodeck bot\'s message database.',
    {
      bot: z.string().describe('Persona name of the bot holodeck to message'),
      message: z.string().describe('The message text to inject'),
    },
    async (args) => {
      if (!isMain) {
        return { content: [{ type: 'text' as const, text: 'Only MAIN can manage holodecks.' }], isError: true };
      }
      writeIpcFile(tasksDir, {
        type: 'holodeck_send',
        bot: args.bot,
        message: args.message,
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `Message queued for ${args.bot} holodeck.` }] };
    },
  );

  server.tool(
    'holodeck_read',
    'Read recent messages from a holodeck bot\'s message database. Returns the last N messages.',
    {
      bot: z.string().describe('Persona name of the bot holodeck to read from'),
      limit: z.number().int().positive().max(100).default(20).describe('Number of messages to read (default 20)'),
    },
    async (args) => {
      if (!isMain) {
        return { content: [{ type: 'text' as const, text: 'Only MAIN can manage holodecks.' }], isError: true };
      }
      writeIpcFile(tasksDir, {
        type: 'holodeck_read',
        bot: args.bot,
        limit: args.limit,
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `Holodeck read queued for ${args.bot} (last ${args.limit} messages).` }] };
    },
  );

  server.tool(
    'holodeck_status',
    'Check the status of a holodeck test instance — whether it\'s running, its instance path, and worktree info.',
    {
      bot: z.string().describe('Persona name of the bot holodeck to check'),
    },
    async (args) => {
      if (!isMain) {
        return { content: [{ type: 'text' as const, text: 'Only MAIN can manage holodecks.' }], isError: true };
      }
      writeIpcFile(tasksDir, {
        type: 'holodeck_status',
        bot: args.bot,
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `Holodeck status check queued for ${args.bot}.` }] };
    },
  );

  // ── Git operations ─────────────────────────────────────────────────

  server.tool(
    'git_push',
    'Push git commits to a remote repository from the InfiniClaw root.',
    {
      remote: z.string().default('origin').describe('Git remote name'),
      branches: z.array(z.string()).default(['main']).describe('Branch names to push'),
    },
    async (args) => {
      if (!isMain) {
        return {
          content: [{ type: 'text' as const, text: 'Only MAIN can push.' }],
          isError: true,
        };
      }
      writeIpcFile(tasksDir, {
        type: 'git_push',
        remote: args.remote,
        branches: args.branches,
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [{ type: 'text' as const, text: `Push queued: ${args.branches.join(', ')} → ${args.remote}` }],
      };
    },
  );

  server.tool(
    'git_pull',
    'Pull latest code from origin, rebuild, and deploy to all bot instances. Use when code sync is stale or broken.',
    {},
    async () => {
      if (!isMain) {
        return {
          content: [{ type: 'text' as const, text: 'Only MAIN can pull.' }],
          isError: true,
        };
      }
      writeIpcFile(tasksDir, {
        type: 'git_pull',
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [{ type: 'text' as const, text: 'git_pull queued — relay will fetch, rebuild, and deploy.' }],
      };
    },
  );

  server.tool(
    'restart_relay',
    'Restart the InfiniClaw relay process. Use when relay is stuck, sync is broken, or after code changes need to take effect.',
    {},
    async () => {
      if (!isMain) {
        return {
          content: [{ type: 'text' as const, text: 'Only MAIN can restart relay.' }],
          isError: true,
        };
      }
      writeIpcFile(tasksDir, {
        type: 'restart_relay',
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [{ type: 'text' as const, text: 'restart_relay queued — relay will restart shortly.' }],
      };
    },
  );

  // ── Cross-bot verification ──────────────────────────────────────────

  server.tool(
    'request_verification',
    `Request another bot to verify your completed work. The verifier must independently confirm the task meets the acceptance criteria before it can be considered done.

Use this after completing a task that requires cross-bot verification. The assigned verifier will receive a notification.`,
    {
      task_description: z.string().describe('What was done — clear description of the completed work'),
      criteria: z.string().describe('Acceptance criteria — what "done" looks like, how the verifier should check'),
      assigned_to: z.string().describe('Bot name to verify (e.g., "Albert", "Cid")'),
    },
    async (args) => {
      if (!isMain) {
        return { content: [{ type: 'text' as const, text: 'Verification requests can only be created from the main group.' }], isError: true };
      }
      const id = `v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(tasksDir, {
        type: 'request_verification',
        id,
        task_description: args.task_description,
        criteria: args.criteria,
        requested_by: process.env.INFINICLAW_ASSISTANT_NAME || 'unknown',
        assigned_to: args.assigned_to,
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [{ type: 'text' as const, text: `Verification requested: ${id}\nAssigned to: ${args.assigned_to}\nCriteria: ${args.criteria}` }],
      };
    },
  );

  server.tool(
    'submit_verification',
    `Submit a verification result for a pending verification request. Use after you have independently checked the work against the acceptance criteria.`,
    {
      verification_id: z.string().describe('The verification ID (e.g., "v-1234567890-abc123")'),
      passed: z.boolean().describe('true if the work meets all acceptance criteria, false if it does not'),
      evidence: z.string().describe('Evidence supporting your decision — what you checked and what you found'),
    },
    async (args) => {
      writeIpcFile(tasksDir, {
        type: 'submit_verification',
        id: args.verification_id,
        passed: args.passed,
        evidence: args.evidence,
        submitted_by: process.env.INFINICLAW_ASSISTANT_NAME || 'unknown',
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [{ type: 'text' as const, text: `Verification ${args.verification_id}: ${args.passed ? '✅ PASSED' : '❌ FAILED'}\nEvidence: ${args.evidence}` }],
      };
    },
  );

  server.tool(
    'check_verification',
    'Check the status of a specific verification request by ID.',
    {
      verification_id: z.string().describe('The verification ID to check'),
    },
    async (args) => {
      // Read from the shared verification status file
      const statusFile = '/workspace/project/data/verifications.json';
      try {
        const data = JSON.parse(fs.readFileSync(statusFile, 'utf-8')) as Array<{
          id: string; task_description: string; criteria: string;
          requested_by: string; assigned_to: string; status: string;
          evidence?: string; requested_at: string; resolved_at?: string;
        }>;
        const record = data.find((v) => v.id === args.verification_id);
        if (!record) {
          return { content: [{ type: 'text' as const, text: `Verification ${args.verification_id} not found.` }], isError: true };
        }
        const lines = [
          `**Verification ${record.id}**`,
          `Status: ${record.status}`,
          `Task: ${record.task_description}`,
          `Criteria: ${record.criteria}`,
          `Requested by: ${record.requested_by}`,
          `Assigned to: ${record.assigned_to}`,
          `Requested at: ${record.requested_at}`,
        ];
        if (record.evidence) lines.push(`Evidence: ${record.evidence}`);
        if (record.resolved_at) lines.push(`Resolved at: ${record.resolved_at}`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch {
        return { content: [{ type: 'text' as const, text: 'Verification data unavailable.' }], isError: true };
      }
    },
  );

  server.tool(
    'list_verifications',
    'List all verification requests, optionally filtered by status.',
    {
      status: z.enum(['pending', 'verified', 'failed', 'all']).default('all').describe('Filter by verification status'),
      assigned_to: z.string().optional().describe('Filter by assigned verifier bot name'),
    },
    async (args) => {
      const statusFile = '/workspace/project/data/verifications.json';
      try {
        let data = JSON.parse(fs.readFileSync(statusFile, 'utf-8')) as Array<{
          id: string; task_description: string; criteria: string;
          requested_by: string; assigned_to: string; status: string;
          evidence?: string; requested_at: string; resolved_at?: string;
        }>;
        if (args.status !== 'all') {
          data = data.filter((v) => v.status === args.status);
        }
        if (args.assigned_to) {
          const assignedTo = args.assigned_to;
          data = data.filter((v) => v.assigned_to.toLowerCase() === assignedTo.toLowerCase());
        }
        if (data.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No verification requests found matching criteria.' }] };
        }
        const lines = data.map((v) => {
          const icon = v.status === 'verified' ? '✅' : v.status === 'failed' ? '❌' : '⏳';
          return `${icon} **${v.id}** — ${v.task_description.slice(0, 60)}${v.task_description.length > 60 ? '...' : ''}\n   ${v.status} | by ${v.requested_by} → ${v.assigned_to}`;
        });
        return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
      } catch {
        return { content: [{ type: 'text' as const, text: 'No verification data available.' }] };
      }
    },
  );

  // ── WBS ──────────────────────────────────────────────────────────────

  const WBS_DATA_DIR = '/workspace/data';

  type WbsStatus = 'backlog' | 'ready' | 'in_progress' | 'done';
  interface WbsItem {
    id: string; title: string; source?: string;
    depends_on: string[]; assigned_to: string | null;
    status: WbsStatus; priority: number;
  }

  function inferRoom(): string {
    const role = (process.env.ASSISTANT_ROLE || '').toLowerCase();
    const map: Record<string, string> = { engineer: 'engineering', navigator: 'bridge', architect: 'astrometrics' };
    return map[role] || role;
  }

  function readWbsItems(room: string): WbsItem[] | null {
    const safe = room.replace(/[^a-zA-Z0-9_-]/g, '_');
    const p = path.join(WBS_DATA_DIR, `wbs-${safe}.json`);
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as { items?: unknown };
      return Array.isArray(parsed.items) ? (parsed.items as WbsItem[]) : [];
    } catch { return null; }
  }

  const STATUS_ICON: Record<WbsStatus, string> = {
    backlog: '⬜', ready: '🔵', in_progress: '🔄', done: '✅',
  };

  server.tool(
    'wbs_read',
    'Read the Work Breakdown Structure (WBS) for this room. Shows all tasks, their status, priority, and assignments.',
    {
      room: z.string().optional().describe('Room name (e.g. "engineering"). Defaults to your current role room.'),
      status: z.enum(['all', 'backlog', 'ready', 'in_progress', 'done']).default('all').describe('Filter by status'),
    },
    async (args) => {
      const room = args.room || inferRoom();
      const items = readWbsItems(room);
      if (items === null) {
        return { content: [{ type: 'text' as const, text: `No WBS file found for room: ${room}` }] };
      }
      const filtered = args.status === 'all' ? items : items.filter(i => i.status === args.status);
      if (filtered.length === 0) {
        return { content: [{ type: 'text' as const, text: `No items with status "${args.status}" in WBS for ${room}.` }] };
      }
      const lines = filtered.map(i => {
        const icon = STATUS_ICON[i.status] ?? '?';
        const assignee = i.assigned_to ? ` → ${i.assigned_to}` : '';
        const deps = i.depends_on.length > 0 ? ` [deps: ${i.depends_on.join(',')}]` : '';
        return `${icon} **${i.id}** p${i.priority} ${i.title}${assignee}${deps}`;
      });
      return { content: [{ type: 'text' as const, text: `**WBS: ${room}** (${filtered.length} items)\n\n${lines.join('\n')}` }] };
    },
  );

  server.tool(
    'wbs_get_assigned',
    'Get WBS tasks currently assigned to this bot (or another bot).',
    {
      bot: z.string().optional().describe('Bot name to query. Defaults to yourself.'),
      room: z.string().optional().describe('Room name. Defaults to your current role room.'),
    },
    async (args) => {
      const room = args.room || inferRoom();
      const bot = (args.bot || process.env.INFINICLAW_ASSISTANT_NAME || '').toLowerCase();
      const items = readWbsItems(room);
      if (items === null) {
        return { content: [{ type: 'text' as const, text: `No WBS file found for room: ${room}` }] };
      }
      const assigned = items.filter(i => i.assigned_to?.toLowerCase() === bot && i.status !== 'done');
      if (assigned.length === 0) {
        return { content: [{ type: 'text' as const, text: `No active WBS assignments for ${bot} in ${room}.` }] };
      }
      const lines = assigned.map(i => `🔄 **${i.id}** p${i.priority} ${i.title}`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'wbs_assign',
    'Assign a WBS task to a bot. Chief only. Marks the item in_progress.',
    {
      item_id: z.string().describe('WBS item ID (e.g. "3.1")'),
      assignee: z.string().optional().describe('Bot name to assign to. Defaults to yourself.'),
      room: z.string().optional().describe('Room name. Defaults to your current role room.'),
    },
    async (args) => {
      const room = args.room || inferRoom();
      const assignee = args.assignee || process.env.INFINICLAW_ASSISTANT_NAME || '';
      writeIpcFile(tasksDir, {
        type: 'wbs_assign',
        item_id: args.item_id,
        assignee,
        room,
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `WBS ${args.item_id} assigned to ${assignee} in ${room}.` }] };
    },
  );

  server.tool(
    'wbs_complete',
    'Mark a WBS task as done. Unblocks any dependent items. Chief only.',
    {
      item_id: z.string().describe('WBS item ID to mark complete (e.g. "3.1")'),
      room: z.string().optional().describe('Room name. Defaults to your current role room.'),
    },
    async (args) => {
      const room = args.room || inferRoom();
      writeIpcFile(tasksDir, {
        type: 'wbs_complete',
        item_id: args.item_id,
        room,
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `WBS ${args.item_id} marked complete in ${room}. Dependent items will be unblocked.` }] };
    },
  );

  server.tool(
    'wbs_write',
    `Create or update a WBS item. Chief only.

Use to add new tasks (upsert) or remove items (delete) from the Work Breakdown Structure.
- upsert: creates the item if it doesn't exist, or updates fields of an existing item
- delete: removes the item from the WBS

Item fields for upsert:
- id: hierarchical WBS code (e.g. "3.2.1")
- title: deliverable description
- priority: number, lower = higher priority (default 50)
- depends_on: list of item IDs that must be done first
- status: "backlog" | "ready" (default "backlog")
- source: optional GitHub issue/PR reference`,
    {
      op: z.enum(['upsert', 'delete']).describe('Operation: upsert (create/update) or delete'),
      room: z.string().optional().describe('Room name. Defaults to your current role room.'),
      item: z.object({
        id: z.string().describe('WBS item ID (e.g. "3.2.1")'),
        title: z.string().optional().describe('Deliverable title (required for upsert)'),
        priority: z.number().int().optional().describe('Priority — lower number = higher priority (default 50)'),
        depends_on: z.array(z.string()).optional().describe('IDs of items that must be done before this one'),
        status: z.enum(['backlog', 'ready']).optional().describe('Initial status (default: backlog)'),
        source: z.string().optional().describe('GitHub issue, PR, or Captain directive reference'),
      }).describe('Item to create/update/delete'),
    },
    async (args) => {
      const room = args.room || inferRoom();
      writeIpcFile(tasksDir, {
        type: 'wbs_write',
        op: args.op,
        item: args.item,
        room,
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      const msg = args.op === 'delete'
        ? `WBS ${args.item.id} delete queued in ${room}.`
        : `WBS ${args.item.id} upsert queued in ${room}.`;
      return { content: [{ type: 'text' as const, text: msg }] };
    },
  );

  // ── Metrics ─────────────────────────────────────────────────────────

  server.tool(
    'get_metrics',
    'Get this bot\'s own performance metrics: current status, model, active groups, last error, and token usage from session history.',
    {},
    async () => {
      const botName = process.env.INFINICLAW_ASSISTANT_NAME || 'unknown';
      const lines: string[] = [`**Metrics for ${botName}**`];

      // Read status snapshot written by main.ts every 30s
      const statusPath = path.join(ipcDir, 'status.json');
      let statusData: null | {
        timestamp?: string;
        bot?: string;
        role?: string;
        model?: string;
        provider?: string;
        groups?: Array<{
          name: string;
          active?: boolean;
          hasProcess?: boolean;
          currentObjective?: string;
          lastProgress?: string;
          lastProgressAt?: number;
          lastError?: string;
          lastErrorAt?: number;
          pendingMessages?: boolean;
          pendingTasks?: number;
        }>;
      } = null;

      try {
        statusData = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
      } catch { /* not yet written */ }

      if (statusData) {
        lines.push(`Snapshot: ${statusData.timestamp ?? 'unknown'}`);
        lines.push(`Model: ${statusData.model ?? '?'} (${statusData.provider ?? '?'})`);
        lines.push(`Role: ${statusData.role ?? '?'}`);
        lines.push('');

        for (const g of statusData.groups ?? []) {
          lines.push(`**Group: ${g.name}**`);
          lines.push(`  active=${g.active ?? false}  process=${g.hasProcess ?? false}  pendingTasks=${g.pendingTasks ?? 0}`);
          if (g.currentObjective) {
            const obj = g.currentObjective.length > 120 ? g.currentObjective.slice(0, 117) + '...' : g.currentObjective;
            lines.push(`  objective: ${obj}`);
          }
          if (g.lastProgress) {
            const prog = g.lastProgress.length > 120 ? g.lastProgress.slice(0, 117) + '...' : g.lastProgress;
            const agoMs = g.lastProgressAt ? Date.now() - g.lastProgressAt : null;
            const ago = agoMs != null ? ` (${Math.round(agoMs / 60000)}m ago)` : '';
            lines.push(`  last progress${ago}: ${prog}`);
          }
          if (g.lastError) {
            const err = g.lastError.length > 120 ? g.lastError.slice(0, 117) + '...' : g.lastError;
            const agoMs = g.lastErrorAt ? Date.now() - g.lastErrorAt : null;
            const ago = agoMs != null ? ` (${Math.round(agoMs / 60000)}m ago)` : '';
            lines.push(`  last error${ago}: ${err}`);
          }
        }
      } else {
        lines.push('Status snapshot unavailable (written every 30s).');
      }

      // Token usage from JSONL session files (mounted at /home/node/.claude/projects)
      const sessionDir = '/home/node/.claude/projects';
      const cutoff1d = Date.now() - 86_400_000;
      let totalTokens1d = 0;
      let hasTokenData = false;

      try {
        for (const projectDir of fs.readdirSync(sessionDir)) {
          const projectPath = path.join(sessionDir, projectDir);
          try { if (!fs.statSync(projectPath).isDirectory()) continue; } catch { continue; }
          for (const file of fs.readdirSync(projectPath)) {
            if (!file.endsWith('.jsonl')) continue;
            const filePath = path.join(projectPath, file);
            try { if (fs.statSync(filePath).mtimeMs < cutoff1d) continue; } catch { continue; }
            try {
              const content = fs.readFileSync(filePath, 'utf-8');
              for (const line of content.split('\n')) {
                if (!line.trim()) continue;
                try {
                  const d = JSON.parse(line) as {
                    timestamp?: string;
                    message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
                  };
                  if (!d.timestamp || !d.message?.usage) continue;
                  if (new Date(d.timestamp).getTime() < cutoff1d) continue;
                  const u = d.message.usage;
                  totalTokens1d += (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
                    + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
                  hasTokenData = true;
                } catch { /* skip bad lines */ }
              }
            } catch { /* skip unreadable files */ }
          }
        }
      } catch { /* sessionDir unavailable */ }

      lines.push('');
      if (hasTokenData) {
        lines.push(`Token usage (1d): ${totalTokens1d.toLocaleString()} tokens`);
      } else {
        lines.push('Token usage: no session data found.');
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  // ── Podman exec ───────────────────────────────────────────────────

  server.tool(
    'podman_exec',
    `Run a podman command on the host machine. Main group only.

Allowed subcommands: ps, images, logs, inspect, run, stop, rm, build, exec, pull, start.
Arguments are passed as an array (e.g. ["ps", "--filter", "name=nanoclaw"]).
Output is returned as text (truncated to 2000 chars).`,
    {
      args: z.array(z.string()).describe('Podman command arguments, e.g. ["ps", "--format", "{{.Names}}"]'),
    },
    async (toolArgs) => {
      if (!isMain) {
        return { content: [{ type: 'text' as const, text: 'podman_exec requires main group.' }], isError: true };
      }
      writeIpcFile(tasksDir, {
        type: 'podman_exec',
        args: toolArgs.args,
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return { content: [{ type: 'text' as const, text: `Queued: podman ${toolArgs.args.join(' ')}` }] };
    },
  );

  // ── Delegate tools ──────────────────────────────────────────────────

  registerDelegateTools(server, {
    writeIpcFile,
    messagesDir,
    tasksDir,
    ipcDir,
    chatJid,
    groupFolder,
    isMain,
  });
}
