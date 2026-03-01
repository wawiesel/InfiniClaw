/**
 * InfiniClaw MCP tool registration.
 * All InfiniClaw-specific tools delegated from the base ipc-mcp-stdio.ts.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  loadBotDirectory,
  resolveRecipientJid,
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

  const emitChatMessageTo = (chatJidTarget: string, text: string, sender?: string, threadId?: string): void => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid: chatJidTarget,
      text,
      sender: sender || undefined,
      threadId: threadId || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(messagesDir, data);
  };

  // ── Bot directory & messaging ───────────────────────────────────────

  server.tool(
    'list_recipients',
    'List available message recipients (other bots you can send messages to).',
    {},
    async () => {
      const dir = loadBotDirectory(ipcDir);
      const selfName = process.env.NANOCLAW_ASSISTANT_NAME || '';
      const recipients = Object.keys(dir).filter((name) => name !== selfName);
      if (recipients.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No other bots available.' }] };
      }
      const lines = recipients.map((name) => `- ${name}`);
      return { content: [{ type: 'text' as const, text: `Available recipients:\n${lines.join('\n')}` }] };
    },
  );

  server.tool(
    'send_message',
    'Send a text message. Defaults to the current chat room. Use recipient to send to another bot by name (e.g., "Johnny5" or "Cid"). Use thread_id to reply within a Matrix thread.',
    {
      text: z.string().describe('The message text to send'),
      recipient: z.string().optional().describe('Bot name to send to (e.g., "Johnny5", "Cid"). Omit to send to current chat.'),
      thread_id: z.string().optional().describe('Matrix thread root event ID to reply in a thread (MSC3440)'),
    },
    async (args) => {
      let targetJid = chatJid;
      if (args.recipient) {
        const resolved = resolveRecipientJid(args.recipient, ipcDir);
        if (!resolved) {
          const dir = loadBotDirectory(ipcDir);
          const available = Object.keys(dir).join(', ') || 'none';
          return {
            content: [{ type: 'text' as const, text: `Unknown recipient "${args.recipient}". Available: ${available}` }],
            isError: true,
          };
        }
        targetJid = resolved;
      }
      emitChatMessageTo(targetJid, args.text, undefined, args.thread_id);
      return { content: [{ type: 'text' as const, text: args.recipient ? `Message sent to ${args.recipient}.` : 'Message sent.' }] };
    },
  );

  server.tool(
    'send_and_open_thread',
    `Send a message to the main timeline and return its Matrix event ID so you can immediately use it as thread_id in a delegate tool or follow-up send_message.

Use this when you want to post a brief summary line (e.g. "💭 Lobe delegation - reason") and then put all detail/output in a thread. Returns { event_id } on success.`,
    {
      text: z.string().describe('The message text to post on the main timeline'),
      timeout_ms: z.number().int().positive().max(15000).default(8000).describe('How long to wait for the event ID to be written (default 8s)'),
    },
    async (args) => {
      const idsFile = path.join(ipcDir, 'last_event_ids.json');
      const sentBefore = (() => {
        try {
          if (!fs.existsSync(idsFile)) return '';
          const d = JSON.parse(fs.readFileSync(idsFile, 'utf-8')) as Record<string, string>;
          return d.lastSentAt || '';
        } catch { return ''; }
      })();

      emitChatMessageTo(chatJid, args.text);

      const timeoutMs = Math.max(1000, Math.min(args.timeout_ms ?? 8000, 15000));
      const deadline = Date.now() + timeoutMs;
      const pollIntervalMs = 200;

      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
        try {
          if (!fs.existsSync(idsFile)) continue;
          const d = JSON.parse(fs.readFileSync(idsFile, 'utf-8')) as Record<string, string>;
          if (d.lastSent && d.lastSentAt && d.lastSentAt !== sentBefore) {
            return {
              content: [{ type: 'text' as const, text: `event_id: ${d.lastSent}` }],
            };
          }
        } catch { /* keep polling */ }
      }

      return {
        content: [{ type: 'text' as const, text: 'send_and_open_thread: timed out waiting for event ID. Message was sent but thread_id unavailable.' }],
        isError: true,
      };
    },
  );

  server.tool(
    'set_thread',
    'Set a persistent work thread for all future replies in this group. Pass thread_id to route replies into a Matrix thread, or omit it to clear and reply on the main timeline.',
    {
      thread_id: z.string().optional().describe('Matrix thread root event ID (MSC3440). Omit or pass empty string to clear.'),
    },
    async (args) => {
      const data: Record<string, string | undefined> = {
        type: 'set_thread',
        chatJid,
        threadId: args.thread_id || undefined,
        groupFolder,
        timestamp: new Date().toISOString(),
      };
      writeIpcFile(tasksDir, data);
      const action = args.thread_id ? `set to ${args.thread_id}` : 'cleared';
      return { content: [{ type: 'text' as const, text: `Work thread ${action}.` }] };
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
    'Send an image file to the user or group. The file must exist in the container filesystem (e.g. /workspace/group/screenshot.png). Supports PNG, JPEG, GIF, WebP.',
    {
      file_path: z.string().describe('Absolute path to the image file in the container'),
      caption: z.string().optional().describe('Optional caption to display with the image'),
    },
    async (args) => sendFileIpc(args.file_path, 'image', args.caption),
  );

  server.tool(
    'send_file',
    'Send a file attachment to the user or group. The file must exist in the container filesystem (e.g. /workspace/group/report.pdf).',
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
      bot: z.enum(['engineer', 'commander', 'architect']).describe('Bot profile to update'),
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
3. If validation passes: send "restarting..." and exit for supervisor restart

Use this after making code changes that require a process restart.`,
    {
      bot: z.enum(['engineer', 'commander', 'architect']).default(
        (process.env.ASSISTANT_ROLE || 'engineer').toLowerCase() as 'engineer' | 'commander' | 'architect',
      ).describe('Which bot to restart'),
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
      writeIpcFile(tasksDir, data);

      return {
        content: [{ type: 'text' as const, text: `Restart requested for ${args.bot}. The host daemon will handle the restart.` }],
      };
    },
  );

  server.tool(
    'restart_wksm',
    'Restart the WKSM (WKS MCP Server) SSE proxy on the host. Use when wksm is down or returning errors.',
    {},
    async () => {
      if (!isMain) {
        return {
          content: [{ type: 'text' as const, text: 'Only MAIN can restart wksm.' }],
          isError: true,
        };
      }
      writeIpcFile(tasksDir, {
        type: 'restart_wksm',
        chatJid,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [{ type: 'text' as const, text: 'WKSM restart requested. The host daemon will kill the old process and start a new one on port 8765.' }],
      };
    },
  );

  server.tool(
    'check_health',
    'Check the host system health and status. Returns bot status, active containers, group activity, and queue state. The host writes this snapshot every 30 seconds.',
    {},
    async () => {
      const statusPath = path.join(ipcDir, 'status.json');
      if (!fs.existsSync(statusPath)) {
        return {
          content: [{ type: 'text' as const, text: 'No status snapshot available yet. The host writes status.json every 30s.' }],
        };
      }

      try {
        const raw = fs.readFileSync(statusPath, 'utf-8');
        const status = JSON.parse(raw);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to read status: ${errMsg(err)}` }],
          isError: true,
        };
      }
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
    'Retrieve content for a Matrix message by its event ID. Use this to look up the full text of a message that was reacted to.',
    {
      id: z.string().describe('The Matrix event ID of the message (e.g. $abc123)'),
    },
    async (args) => {
      const dbPath = process.env.NANOCLAW_DB_PATH;
      if (!dbPath || !fs.existsSync(dbPath)) {
        return { content: [{ type: 'text' as const, text: 'Message store not available.' }], isError: true };
      }
      try {
        const { execSync } = await import('child_process');
        const script = `
          const Database = require('better-sqlite3');
          const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
          const row = db.prepare('SELECT id, chat_jid, sender, sender_name, content, timestamp FROM messages WHERE id = ?').get(${JSON.stringify(args.id)});
          db.close();
          console.log(JSON.stringify(row || null));
        `;
        const result = execSync(`node -e ${JSON.stringify(script)}`, { encoding: 'utf-8', timeout: 5000 }).trim();
        const row = JSON.parse(result);
        if (!row) {
          return { content: [{ type: 'text' as const, text: `Message not found: ${args.id}` }] };
        }
        return {
          content: [{
            type: 'text' as const,
            text: `From: ${row.sender_name} (${row.sender})\nTime: ${row.timestamp}\nContent: ${row.content}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Failed to retrieve message: ${errMsg(err)}` }], isError: true };
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
      bot: z.enum(['engineer', 'commander', 'architect']).describe('Which bot to create a holodeck for'),
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
      bot: z.enum(['engineer', 'commander', 'architect']).describe('Which bot holodeck to tear down'),
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
      bot: z.enum(['engineer', 'commander', 'architect']).describe('Which bot holodeck to promote'),
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
      bot: z.enum(['engineer', 'commander', 'architect']).describe('Which bot holodeck to message'),
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
      bot: z.enum(['engineer', 'commander', 'architect']).describe('Which bot holodeck to read from'),
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
      bot: z.enum(['engineer', 'commander', 'architect']).describe('Which bot holodeck to check'),
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
