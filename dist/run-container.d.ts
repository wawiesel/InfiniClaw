/**
 * Container run loop — extracted from upstream NanoClaw v1.1.3.
 * Upstream inlined this into their runContainerAgent in v1.2.2.
 * InfiniClaw needs the composable version since we build our own mounts/args.
 * This file will be removed when Phase 1 (Claude Code CLI runtime) lands.
 */
import { ChildProcess } from 'child_process';
import type { ContainerOutput } from 'nanoclaw/container-runner.js';
export interface VolumeMount {
    hostPath: string;
    containerPath: string;
    readonly: boolean;
}
export interface RunContainerOpts {
    runtime: string;
    args: string[];
    stdinData: unknown;
    groupName: string;
    groupFolder: string;
    containerName: string;
    logsDir: string;
    configTimeout: number;
    idleTimeout: number;
    maxOutputSize: number;
    onProcess: (proc: ChildProcess, containerName: string) => void;
    onOutput?: (output: ContainerOutput) => Promise<void>;
    stopCommand: string;
    logInput?: unknown;
    verboseLogExtras?: string[];
    summaryLogExtras?: string[];
    timeoutErrorMessage?: string;
    outputChainTimeoutMs?: number;
    maxErrorStderrChars?: number;
    firstOutputDeadlineMs?: number;
}
export declare function runContainer(opts: RunContainerOpts): Promise<ContainerOutput>;
