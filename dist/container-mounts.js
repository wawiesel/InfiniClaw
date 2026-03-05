/**
 * InfiniClaw container volume mounts.
 * Persona, skills, MCP sync, delegate auth, cache, and agent-runner source.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseEnvLine } from 'nanoclaw/env-utils.js';
import { logger } from 'nanoclaw/logger.js';
import { loadSkillsToSession } from './skill-sync.js';
import { mountsForBot } from './allow-list.js';
import { loadMachineConfig } from './machine-config.js';
/** Build a directory of all bots: name → main room JID. */
export function buildBotDirectory() {
    let profilesDir;
    try {
        profilesDir = loadMachineConfig().secretsPath;
    }
    catch {
        return {};
    }
    if (!fs.existsSync(profilesDir))
        return {};
    const directory = {};
    try {
        for (const bot of fs.readdirSync(profilesDir)) {
            const envFile = path.join(profilesDir, bot, 'env');
            if (!fs.existsSync(envFile))
                continue;
            const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
            let name = '';
            let roomJid = '';
            for (const line of lines) {
                const parsed = parseEnvLine(line);
                if (!parsed)
                    continue;
                if (parsed[0] === 'ASSISTANT_NAME')
                    name = parsed[1];
                if (parsed[0] === 'LOCAL_MIRROR_MATRIX_JID')
                    roomJid = parsed[1];
            }
            if (name && roomJid)
                directory[name] = roomJid;
        }
    }
    catch (err) {
        logger.warn({ err }, 'Failed to read bot profiles for directory');
    }
    return directory;
}
// ── Helper functions ────────────────────────────────────────────────────
function mountIfExists(mounts, hostPath, containerPath, readonly) {
    if (fs.existsSync(hostPath)) {
        mounts.push({ hostPath, containerPath, readonly });
    }
}
// ── Main mount builder ──────────────────────────────────────────────────
/**
 * Build InfiniClaw-specific volume mounts.
 * Returns additional VolumeMount entries to append to the base mounts.
 */
export function buildInfiniClawMounts(opts) {
    const { group, isMain, groupSessionsDir, groupsDir, dataDir, projectRoot } = opts;
    const mounts = [];
    const homeDir = process.env.HOME || os.homedir();
    const rootDir = process.env.INFINICLAW_ROOT;
    const personaName = process.env.PERSONA_NAME;
    // Sync role-assigned skills from the pool
    const skillsDst = path.join(groupSessionsDir, 'skills');
    const role = (process.env.ASSISTANT_ROLE || '').toLowerCase();
    if (rootDir) {
        const skillsPoolDir = path.join(rootDir, 'bots', 'skills');
        const skillsFile = path.join(rootDir, 'bots', role, 'skills.json');
        loadSkillsToSession(skillsDst, skillsPoolDir, skillsFile);
    }
    if (rootDir && personaName) {
        const personaBaseDir = path.join(rootDir, 'bots', role, personaName);
        // Mount persona dir writable so bots can edit their own CLAUDE.md
        mounts.push({
            hostPath: personaBaseDir,
            containerPath: '/workspace/persona',
            readonly: false,
        });
        // Mount ROOM.md as read-only CLAUDE.md at workspace root
        const roomMd = path.join(rootDir, 'bots', role, 'ROOM.md');
        mountIfExists(mounts, roomMd, '/workspace/CLAUDE.md', true);
        // Mount memory from secrets repo
        try {
            const config = loadMachineConfig();
            const memoryDir = path.join(config.secretsPath, personaName, 'memory');
            fs.mkdirSync(memoryDir, { recursive: true });
            mounts.push({
                hostPath: memoryDir,
                containerPath: '/workspace/persona/memory',
                readonly: false,
            });
        }
        catch (err) {
            logger.debug({ err }, 'Memory mount skipped — no secrets config');
        }
    }
    // Share host delegate auth directories
    mountIfExists(mounts, path.join(homeDir, '.codex'), '/home/node/.codex', false);
    mountIfExists(mounts, path.join(homeDir, '.gemini'), '/home/node/.gemini', false);
    // Per-group persistent cache
    const cacheDir = path.join(dataDir, 'cache', group.folder);
    fs.mkdirSync(cacheDir, { recursive: true });
    mounts.push({ hostPath: cacheDir, containerPath: '/workspace/cache', readonly: false });
    // Mount agent-runner source from host
    const agentRunnerSrc = path.join(projectRoot, 'external', 'nanoclaw', 'container', 'agent-runner', 'src');
    mountIfExists(mounts, agentRunnerSrc, '/app/src', true);
    // Mount ~/.ssh writable so git can use SSH keys and update known_hosts
    // (home dir is mounted ro below, which would shadow this if not mounted separately)
    mountIfExists(mounts, path.join(homeDir, '.ssh'), '/home/node/.ssh', false);
    // Read-only mirror of host home directory
    mounts.push({ hostPath: homeDir, containerPath: homeDir, readonly: true });
    // Additional mounts from allow-list
    if (personaName)
        mounts.push(...mountsForBot(personaName));
    return mounts;
}
/** Read portPublish from persona container-config.json. */
export function getPersonaPortPublish() {
    return getPersonaContainerConfig().portPublish;
}
/** Read supported settings from persona container-config.json. */
export function getPersonaContainerConfig() {
    const rootDir = process.env.INFINICLAW_ROOT;
    const personaName = process.env.PERSONA_NAME;
    const role = (process.env.ASSISTANT_ROLE || '').toLowerCase();
    if (!rootDir || !personaName)
        return { portPublish: [] };
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(rootDir, 'bots', role, personaName, 'container-config.json'), 'utf-8'));
        const portPublish = Array.isArray(cfg.portPublish)
            ? cfg.portPublish.filter((v) => typeof v === 'string')
            : [];
        const memoryMb = typeof cfg.memoryMb === 'number' ? cfg.memoryMb : undefined;
        return { portPublish, memoryMb };
    }
    catch {
        return { portPublish: [] };
    }
}
/** Read mcp.json from role dir for SDK passthrough. */
export function readPersonaGroupMcpServers(roleDir) {
    const mcpJsonPath = path.join(roleDir, 'mcp.json');
    try {
        if (fs.existsSync(mcpJsonPath)) {
            const raw = fs.readFileSync(mcpJsonPath, 'utf-8');
            const mcpJson = JSON.parse(raw);
            if (mcpJson.mcpServers && Object.keys(mcpJson.mcpServers).length > 0) {
                return mcpJson.mcpServers;
            }
        }
    }
    catch (err) {
        logger.warn({ err, mcpJsonPath }, 'Failed to parse persona group .mcp.json');
    }
    return undefined;
}
//# sourceMappingURL=container-mounts.js.map