/**
 * InfiniClaw container runner.
 * Prepares InfiniClaw-specific mounts, secrets, and config, then delegates
 * the spawn lifecycle to upstream's composable runContainer().
 *
 * Re-exports writeTasksSnapshot, writeGroupsSnapshot from upstream's container-runner
 * so callers don't need to know which module provides them.
 */
import { ChildProcess } from 'child_process';
import type { RegisteredGroup } from 'nanoclaw/types.js';
import type { ContainerInput, ContainerOutput } from 'nanoclaw/container-runner.js';
export { writeTasksSnapshot, writeGroupsSnapshot } from 'nanoclaw/container-runner.js';
export type { ContainerOutput, ContainerInput } from 'nanoclaw/container-runner.js';
export declare function runContainerAgent(group: RegisteredGroup, input: ContainerInput, onProcess: (proc: ChildProcess, containerName: string) => void, onOutput?: (output: ContainerOutput) => Promise<void>): Promise<ContainerOutput>;
