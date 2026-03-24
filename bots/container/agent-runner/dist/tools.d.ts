import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
    /** Override the Claude session JSONL directory (default: /home/node/.claude/projects). Used in tests. */
    sessionDir?: string;
}
export declare function registerInfiniClawTools(ctx: ToolRegistrationContext): void;
export {};
