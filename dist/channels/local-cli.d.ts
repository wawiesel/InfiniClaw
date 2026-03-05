import { Channel, OnChatMetadata, OnInboundMessage } from 'nanoclaw/types.js';
export interface LocalCliChannelOpts {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    mirrorToMatrix?: (text: string) => Promise<void>;
}
export declare class LocalCliChannel implements Channel {
    private readonly opts;
    name: string;
    private connected;
    private rl;
    private msgSeq;
    private readonly senderName;
    private readonly senderId;
    constructor(opts: LocalCliChannelOpts);
    private formatMirrorInbound;
    private formatMirrorOutbound;
    connect(): Promise<void>;
    sendMessage(jid: string, text: string): Promise<void>;
    setPresenceStatus(_state: string, statusMessage?: string): Promise<void>;
    setTyping(jid: string, isTyping: boolean): Promise<void>;
    isConnected(): boolean;
    ownsJid(jid: string): boolean;
    disconnect(): Promise<void>;
    private prompt;
}
