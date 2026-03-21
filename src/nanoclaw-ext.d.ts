/**
 * InfiniClaw type extensions for nanoclaw.
 *
 * Uses TypeScript declaration merging to augment upstream interfaces
 * without modifying the nanoclaw fork. Keep this file in sync when
 * upstream adds fields that overlap with our extensions.
 *
 * The `export {}` makes this a module so `declare module` AUGMENTS
 * the existing declarations rather than replacing them.
 */
export {};

declare module 'nanoclaw/types.js' {
  interface NewMessage {
    thread_id?: string;
  }

  interface Channel {
    sendMessage(jid: string, text: string, threadId?: string): Promise<void>;
    sendReaction?(jid: string, eventId: string, reaction: string): Promise<void>;
    sendMessageReturningId?(jid: string, text: string, threadId?: string): Promise<string | undefined>;
    setPresenceStatus?(state: string, statusMessage?: string): Promise<void>;
    setStatusPip?(jid: string, emoji: string): Promise<void>;
    sendImage?(jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string): Promise<void>;
    sendFile?(jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string): Promise<void>;
  }
}

declare module 'nanoclaw/container-runner.js' {
  interface ContainerInput {
    containerNameTag?: string;
    timeoutOverrideMs?: number;
    secrets?: Record<string, string>;
    mcpServers?: Record<string, unknown>;
    forkSession?: boolean;
  }

  interface ContainerOutput {
    isProgress?: boolean;
  }
}

declare module 'nanoclaw/task-scheduler.js' {
  interface SchedulerDependencies {
    runContainerAgent?: typeof import('nanoclaw/container-runner.js').runContainerAgent;
  }
}

declare module 'nanoclaw/group-queue.js' {
  interface GroupQueue {
    getGroupStatus(groupJid: string): {
      active: boolean;
      hasProcess: boolean;
      containerName: string | null;
      pendingMessages: boolean;
      pendingTasks: number;
      idleWaiting: boolean;
    };
    setPreCloseHook(fn: (groupJid: string, inputDir: string) => void): void;
    setShutdownHook(fn: () => Promise<void>): void;
    getActiveGroupJids(): string[];
  }
}
