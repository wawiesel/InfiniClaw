import type { RegisteredGroup } from 'nanoclaw/types.js';
export interface InfiniClawIpcContext {
    isMain: boolean;
    sourceGroup: string;
    sendMessage: (jid: string, text: string, threadId?: string) => Promise<void>;
    registeredGroups: () => Record<string, RegisteredGroup>;
    setWorkThread: (chatJid: string, threadId: string | null) => void;
    /** Clear the auto-thread entry for this source group (called when set_thread clears the thread) */
    clearDelegateThread: (sourceGroup: string) => void;
}
export interface InfiniClawMessageContext {
    authorized: boolean;
    sourceGroup: string;
    sendImage: (jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string) => Promise<void>;
    sendFile: (jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string) => Promise<void>;
}
interface CommandData {
    type: string;
    bot?: string;
    mode?: string;
    model?: string;
    chatJid?: string;
    threadId?: string;
    remote?: string;
    branches?: string[];
    branch?: string;
    message?: string;
    room?: string;
    limit?: number;
    id?: string;
    task_description?: string;
    criteria?: string;
    requested_by?: string;
    assigned_to?: string;
    timestamp?: string;
    groupFolder?: string;
    passed?: boolean;
    evidence?: string;
    submitted_by?: string;
    [key: string]: unknown;
}
export declare function readBrainMode(bot: string): {
    mode: 'anthropic' | 'ollama' | 'unknown';
    model: string;
};
/**
 * Handle InfiniClaw-specific IPC message types (image, file).
 * Returns true if the message type was handled, false otherwise.
 */
export declare function handleInfiniClawMessage(data: {
    type: string;
    chatJid?: string;
    imageData?: string;
    fileData?: string;
    filename?: string;
    mimetype?: string;
    caption?: string;
}, ctx: InfiniClawMessageContext): Promise<boolean>;
export declare function handleInfiniClawCommand(data: CommandData, ctx: InfiniClawIpcContext): Promise<boolean>;
export {};
