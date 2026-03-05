interface AllowEntry {
    path: string;
    expiresAt: string | null;
}
interface AllowList {
    mounts: Record<string, AllowEntry[]>;
}
interface VolumeMount {
    hostPath: string;
    containerPath: string;
    readonly: boolean;
}
export declare function loadAllowList(): AllowList;
export declare function grantMount(bot: string, rawPath: string, durationMinutes?: number): void;
export declare function revokeMount(bot: string, rawPath: string): boolean;
export declare function pruneExpired(): number;
export declare function mountsForBot(bot: string): VolumeMount[];
export {};
