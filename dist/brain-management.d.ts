export declare function resolveConfiguredMainModel(): string | undefined;
export declare function resolveMainProvider(): 'claude' | 'ollama';
export declare function normalizeMainLlm(model: string | undefined): string | undefined;
export declare function maybeAutoSwitchBrainsOnQuotaError(rawError: string, chatJid: string, sendMessage: (jid: string, text: string) => Promise<void>): Promise<void>;
export declare function resolveMainLlm(): string;
export declare const MAIN_PROVIDER: "claude" | "ollama";
export declare let mainLlm: string;
export declare function setMainLlm(model: string): void;
export declare function mainSender(): string;
export declare function defaultSenderForGroup(sourceGroup: string, registeredGroups: Record<string, {
    folder: string;
    name: string;
}>): string;
