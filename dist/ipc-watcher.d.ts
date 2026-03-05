import type { AvailableGroup } from 'nanoclaw/container-runner.js';
import type { RegisteredGroup } from 'nanoclaw/types.js';
export interface IpcDeps {
    sendMessage: (jid: string, text: string, threadId?: string) => Promise<void>;
    sendMessageReturningId: (jid: string, text: string, threadId?: string) => Promise<string | undefined>;
    sendImage: (jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string) => Promise<void>;
    sendFile: (jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string) => Promise<void>;
    defaultSenderForGroup: (sourceGroup: string) => string;
    registeredGroups: () => Record<string, RegisteredGroup>;
    registerGroup: (jid: string, group: RegisteredGroup) => void;
    unregisterGroup: (jid: string) => void;
    setWorkThread: (chatJid: string, threadId: string | null) => void;
    syncGroups: (force: boolean) => Promise<void>;
    getAvailableGroups: () => AvailableGroup[];
    writeGroupsSnapshot: (groupFolder: string, isMain: boolean, availableGroups: AvailableGroup[], registeredJids: Set<string>) => void;
    writeLastEventId: (sourceGroup: string, eventId: string) => void;
}
export declare function startIpcWatcher(deps: IpcDeps): void;
