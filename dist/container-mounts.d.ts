import type { RegisteredGroup } from 'nanoclaw/types.js';
interface VolumeMount {
    hostPath: string;
    containerPath: string;
    readonly: boolean;
}
export interface InfiniClawMountOptions {
    group: RegisteredGroup;
    isMain: boolean;
    groupSessionsDir: string;
    groupsDir: string;
    dataDir: string;
    projectRoot: string;
}
/** Build a directory of all bots: name → main room JID. */
export declare function buildBotDirectory(): Record<string, string>;
/**
 * Build InfiniClaw-specific volume mounts.
 * Returns additional VolumeMount entries to append to the base mounts.
 */
export declare function buildInfiniClawMounts(opts: InfiniClawMountOptions): VolumeMount[];
/** Read portPublish from persona container-config.json. */
export declare function getPersonaPortPublish(): string[];
/** Read supported settings from persona container-config.json. */
export declare function getPersonaContainerConfig(): {
    portPublish: string[];
    memoryMb?: number;
};
/** Read mcp.json from role dir for SDK passthrough. */
export declare function readPersonaGroupMcpServers(roleDir: string): Record<string, Record<string, unknown>> | undefined;
export {};
