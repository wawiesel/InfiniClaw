export declare function getActiveBots(): string[];
export declare function resolveRoot(): string;
export declare function instanceDir(root: string, bot: string): string;
export declare function loadProfileEnv(root: string, bot: string): Record<string, string>;
/** Collect MATRIX_USER_ID from all bot env files in the secrets directory. */
export declare function collectBotMatrixUserIds(): Set<string>;
export declare function applyBrainEnv(env: Record<string, string>): Record<string, string>;
export declare function ensurePodmanReady(): void;
export declare function killStaleContainers(onlyBot?: string): void;
export declare function killRogueProcesses(): void;
/**
 * Sync persona state before redeploy.
 * Persona CLAUDE.md is edited directly by bots via writable mount — no copy needed.
 * Group CLAUDE.md is ONE-WAY (repo → instance) — no save-back.
 * MCP servers are ONE-WAY (persona → session) — no save-back.
 */
export declare function syncPersona(root: string, bot: string): void;
/** Update the local presence file to reflect currently running bots. */
export declare function updatePresence(root: string): void;
/** Write local presence file and generate crew-status.json from all machines' presence. */
export declare function writeCrewStatus(root: string, thisBot: string, dataDir: string): void;
export declare function restorePersona(root: string, bot: string): void;
/**
 * Full deploy: syncPersona → rsync → npm ci if needed → build → restorePersona.
 */
export declare function deployBot(root: string, bot: string): void;
/**
 * Validate code compiles before allowing a restart.
 * Syncs to staging dir, symlinks node_modules, runs tsc --noEmit.
 */
export declare function validateDeploy(root: string, bot: string): {
    ok: boolean;
    errors: string;
};
export declare function rebuildImage(root: string, bot: string): void;
/**
 * Refresh start script for a bot so a pm2 restart picks up new env vars.
 * Use before self-restart.
 */
export declare function refreshStartScript(root: string, bot: string): void;
/**
 * Bootstrap a new bot: deploy, start via pm2.
 * Safe to call on an already-running bot (stops first).
 */
export declare function bootstrapBot(root: string, bot: string): void;
/** Stop a bot via pm2. Does not deploy or restart. */
export declare function stopBot(bot: string): void;
export declare function startSupervisor(root: string): void;
export declare function stopSupervisor(): void;
export declare function start(onlyBot?: string): Promise<void>;
export declare function stop(onlyBot?: string): Promise<void>;
export declare function sync(direction: 'push' | 'pull'): Promise<void>;
export declare function chat(bot: string): void;
export declare function send(room: string, message: string): Promise<void>;
export declare function holodeckCreate(bot: string, branch: string): void;
export declare function holodeckChat(bot: string): void;
export declare function holodeckTeardown(bot: string): void;
export declare function holodeckPromote(bot: string): void;
