export interface ContainerInfo {
    name: string;
    group: string;
    uptime: string;
}
export interface GroupStatus {
    jid: string;
    name: string;
    folder: string;
    lastActivity?: string;
    currentObjective?: string;
    lastProgress?: string;
    lastProgressAt?: string;
    lastError?: string;
    lastErrorAt?: string;
    sessionId?: string;
    containerLogDir?: string;
}
export interface TaskStatus {
    id: string;
    prompt: string;
    schedule: string;
    status: string;
    nextRun?: string;
    lastRun?: string;
}
export interface TokenUsage {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUSD?: number;
}
export interface BotLogFiles {
    stdout: string;
    stderr: string;
    containerLogs: string;
    db: string;
}
export interface BotStatus {
    name: string;
    service: 'running' | 'stopped';
    pid?: number;
    model?: string;
    provider?: string;
    containers: ContainerInfo[];
    groups: GroupStatus[];
    tasks: TaskStatus[];
    recentErrors: string[];
    lastErrorAt?: string;
    tokenUsage?: TokenUsage[];
    logFiles: BotLogFiles;
    lastHeartbeat?: string;
    heartbeatStale?: boolean;
}
export interface SystemStatus {
    timestamp: string;
    podmanRunning: boolean;
    bots: BotStatus[];
}
export declare function getSystemStatus(rootDir: string): SystemStatus;
/**
 * Get recent log lines from a bot's error or stdout log.
 */
export declare function getRecentLogLines(rootDir: string, bot: string, logType?: 'error' | 'stdout', lines?: number): string[];
/**
 * Get current activity summary for each bot — what they're working on right now.
 */
export declare function getBotActivity(rootDir: string): Array<{
    bot: string;
    activity: string;
}>;
