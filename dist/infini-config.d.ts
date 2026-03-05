/**
 * InfiniClaw-specific config values.
 * These were removed from upstream NanoClaw config in v1.2.2
 * (moved to channel modules or removed entirely).
 */
export declare const ASSISTANT_ROLE: string;
export declare const CAPTAIN_USER_ID: string;
export declare const MAIN_GROUP_FOLDER: string;
export declare const HEAP_LIMIT_MB: number;
export declare const RESUME_DELAY_SECONDS: number;
export declare const MEMORY_CHECK_INTERVAL: number;
export declare const MATRIX_HOMESERVER: string;
export declare const MATRIX_USERNAME: string;
export declare const MATRIX_PASSWORD: string;
export declare const MATRIX_ACCESS_TOKEN: string;
export declare const MATRIX_RECONNECT_INTERVAL: number;
export declare const MATRIX_DEVICE_NAME: string;
export declare const MATRIX_USER_ID: string;
export declare const LOCAL_CHAT_JID = "local:cli";
export declare const LOCAL_CHAT_NAME = "Local CLI";
export declare const LOCAL_CHAT_SENDER_NAME: string;
export declare const LOCAL_CHANNEL_ENABLED: boolean;
export declare const LOCAL_MIRROR_MATRIX_JID: string;
export declare const IGNORE_PATTERNS: RegExp[];
export declare const IGNORE_SENDERS: Set<string>;
/** Validate critical config at startup. Logs warnings for empty required values. */
export declare function validateConfig(): string[];
