import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from 'nanoclaw/types.js';
export interface MatrixChannelOpts {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
    /** Display name to set on connect (e.g. "Nora ⭐" for commanding officer). */
    displayName?: string;
}
export declare function toFormattedBodyWithMarkdownAndMath(text: string): {
    formattedBody: string;
    hasRichFormatting: boolean;
};
export declare class MatrixChannel implements Channel {
    name: string;
    prefixAssistantName: boolean;
    private client;
    private _connected;
    private botUserId;
    private opts;
    private lastMessageEventId;
    private recentBotEventIds;
    private senderNameCache;
    private roomNameCache;
    private _sendQueue;
    private _sendQueueRunning;
    constructor(opts: MatrixChannelOpts);
    /** Track the last N bot-sent event IDs per room for reaction matching. */
    private trackBotEvent;
    /**
     * Queue a Matrix API call for sequential execution.
     * Prevents concurrent sends from racing — no rate limit handling needed
     * since the private homeserver (Continuwuity) has no rate limits.
     */
    private enqueueSend;
    private drainSendQueue;
    private readStored;
    private storeTokens;
    private postMatrixJson;
    private refreshAccessToken;
    private passwordLoginWithRefresh;
    private isAuthFailure;
    private isTooLargeError;
    private markDisconnected;
    private createAuthedClient;
    connect(): Promise<void>;
    /** Update the bot's Matrix display name (e.g. for CO badge changes). */
    setDisplayName(name: string): Promise<void>;
    private sendTextReturningId;
    sendMessage(jid: string, text: string, threadId?: string): Promise<void>;
    sendReaction(jid: string, eventId: string, emoji: string): Promise<void>;
    sendMessageReturningId(jid: string, text: string, threadId?: string): Promise<string | undefined>;
    editMessage(jid: string, eventId: string, newText: string): Promise<void>;
    redactMessage(jid: string, eventId: string): Promise<void>;
    isConnected(): boolean;
    ownsJid(jid: string): boolean;
    disconnect(): Promise<void>;
    checkHealth(): Promise<boolean>;
    sendImage(jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string): Promise<void>;
    sendFile(jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string): Promise<void>;
    private sendMedia;
    setPresenceStatus(state: string, statusMessage?: string): Promise<void>;
    setStatusPip(_jid: string, _emoji: string): Promise<void>;
    setTyping(jid: string, isTyping: boolean): Promise<void>;
    private downloadMedia;
    private getSenderName;
    private getRoomName;
}
