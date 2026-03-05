import type { NewMessage } from 'nanoclaw/types.js';
export interface ChatActivity {
    runStartedAt?: number;
    currentObjective?: string;
    currentObjectiveAt?: number;
    recentUserContext?: string[];
    lastProgress?: string;
    lastProgressAt?: number;
    lastCompletion?: string;
    lastCompletionAt?: number;
    lastError?: string;
    lastErrorAt?: number;
}
export declare function ensureChatActivity(chatJid: string): ChatActivity;
export declare function getChatActivity(chatJid: string): ChatActivity | undefined;
export declare function setObjectiveFromMessages(chatJid: string, messages: NewMessage[]): void;
export declare function markRunStarted(chatJid: string): void;
export declare function markRunEnded(chatJid: string): void;
export declare function markProgress(chatJid: string, progress: string): void;
export declare function markCompletion(chatJid: string, completion: string): void;
export declare function markError(chatJid: string, error: string): void;
export declare function buildMainMissionContext(chatJid: string): string | undefined;
