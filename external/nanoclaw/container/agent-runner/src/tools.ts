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
import {
  capabilityKey,
  loadCapabilityState,
  saveCapabilityState,
  listCapabilityUsageLines,
} from './capability-budget.js';
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

      writeIpcFile(messagesDir, {
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

      writeIpcFile(messagesDir, {
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
      writeIpcFile(tasksDir, data);

      return {
        content: [{
          type: 'text' as const,
          text: `Brain mode update queued for ${args.bot} (${args.mode}/${args.model || (args.mode === 'anthropic' ? 'claude-sonnet-4-5' : 'devstral-small-2-fast:latest')}). Restart required.`,
        }],
      };
    },
  );

  // ── Capability budgets ──────────────────────────────────────────────

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
      bot: z.enum(['engineer', 'commander']).default(
        (process.env.ASSISTANT_ROLE || 'engineer').toLowerCase() as 'engineer' | 'commander',
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
          content: [{ type: 'text' as const, text: `Failed to read status: ${err instanceof Error ? err.message : String(err)}` }],
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
          content: [{ type: 'text' as const, text: `Failed to read brain modes: ${err instanceof Error ? err.message : String(err)}` }],
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
        return { content: [{ type: 'text' as const, text: `Failed to retrieve message: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  // ── Delegate tools ──────────────────────────────────────────────────

  registerDelegateTools(server, {
    writeIpcFile,
    messagesDir,
    chatJid,
    groupFolder,
    isMain,
  });
}
