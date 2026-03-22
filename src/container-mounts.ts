/**
 * InfiniClaw container volume mounts.
 * Persona, skills, MCP sync, delegate auth, cache, and agent-runner source.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseEnvLine } from './env-utils.js';
import { logger } from 'nanoclaw/logger.js';
import { loadSkillsToSession } from './skill-sync.js';
import { mountsForBot } from './allow-list.js';
import { loadFleet, loadShipConfig } from './ship-config.js';
import type { RegisteredGroup } from 'nanoclaw/types.js';
import type { VolumeMount } from './run-container.js';

export interface InfiniClawMountOptions {
  group: RegisteredGroup;
  isMain: boolean;
  groupSessionsDir: string;
  groupsDir: string;
  dataDir: string;
  projectRoot: string;
  secrets?: Record<string, string>;
}

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SAFE_GROUP_FOLDER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Build a directory of bots in this fleet: name → main room JID. */
export function buildBotDirectory(): Record<string, string> {
  let profilesDir: string;
  try {
    profilesDir = path.join(loadShipConfig().secretsPath, 'bots');
  } catch {
    return {};
  }
  if (!fs.existsSync(profilesDir)) return {};
  // Only include bots that are in this relay's fleet config
  const fleetBots = new Set(Object.keys(loadFleet()));
  const directory: Record<string, string> = {};
  try {
    for (const bot of fs.readdirSync(profilesDir)) {
      if (!fleetBots.has(bot)) continue;
      const envFile = path.join(profilesDir, bot, 'env');
      if (!fs.existsSync(envFile)) continue;
      const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
      let name = '';
      let roomJid = '';
      for (const line of lines) {
        const parsed = parseEnvLine(line);
        if (!parsed) continue;
        if (parsed[0] === 'ASSISTANT_NAME') name = parsed[1];
        if (parsed[0] === 'LOCAL_MIRROR_MATRIX_JID') roomJid = parsed[1];
      }
      if (name && roomJid) directory[name] = roomJid;
    }
  } catch (err) { logger.warn({ err }, 'Failed to read bot profiles for directory'); }
  return directory;
}

// ── Helper functions ────────────────────────────────────────────────────

function mountIfExists(
  mounts: VolumeMount[],
  hostPath: string,
  containerPath: string,
  readonly: boolean,
  expectedBase?: string,
): void {
  if (!fs.existsSync(hostPath)) return;
  try {
    const real = fs.realpathSync(hostPath);
    if (expectedBase && !isWithinBase(normalizeBasePath(expectedBase), real)) {
      logger.warn({ hostPath: real, expectedBase }, 'Skipping mount outside expected base');
      return;
    }
    mounts.push({ hostPath: real, containerPath, readonly });
  } catch (err) {
    logger.warn({ err, hostPath }, 'Skipping mount due to path resolution error');
  }
}

function isWithinBase(baseDir: string, candidate: string): boolean {
  const rel = path.relative(baseDir, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizeBasePath(baseDir: string): string {
  const resolved = path.resolve(baseDir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function resolveWithinBase(baseDir: string, ...segments: string[]): string {
  const base = normalizeBasePath(baseDir);
  const resolved = path.resolve(base, ...segments);
  if (!isWithinBase(base, resolved)) {
    throw new Error(`Path escapes base directory: ${resolved}`);
  }
  return resolved;
}

function normalizePathSegment(value: string | undefined, envVar: string): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (!SAFE_PATH_SEGMENT.test(v) || v === '.' || v === '..') {
    logger.warn({ envVar, value }, 'Ignoring invalid path segment from environment');
    return undefined;
  }
  return v;
}

// ── Main mount builder ──────────────────────────────────────────────────

/**
 * Build InfiniClaw-specific volume mounts.
 * Returns additional VolumeMount entries to append to the base mounts.
 */
export function buildInfiniClawMounts(opts: InfiniClawMountOptions): VolumeMount[] {
  const { group, isMain, groupSessionsDir, groupsDir: _groupsDir, dataDir, projectRoot, secrets } = opts;
  void isMain;
  void _groupsDir;
  const mounts: VolumeMount[] = [];
  const homeDir = os.homedir();

  const rootDir = (secrets?.INFINICLAW_ROOT || process.env.INFINICLAW_ROOT)?.trim();
  const rootBase = rootDir ? normalizeBasePath(rootDir) : undefined;
  const role = normalizePathSegment((secrets?.ASSISTANT_ROLE || process.env.ASSISTANT_ROLE || '').toLowerCase(), 'ASSISTANT_ROLE');
  const personaName = normalizePathSegment(secrets?.PERSONA_NAME || process.env.PERSONA_NAME, 'PERSONA_NAME');

  // Sync role-assigned skills from the pool
  const skillsDst = path.join(groupSessionsDir, 'skills');

  if (rootBase && role) {
    const botsDir = resolveWithinBase(rootBase, 'bots');
    const skillsPoolDir = resolveWithinBase(botsDir, 'skills');
    const skillsFile = resolveWithinBase(botsDir, role, 'skills.json');
    loadSkillsToSession(skillsDst, skillsPoolDir, skillsFile);
  }

  if (rootBase && personaName && role) {
    const botsDir = resolveWithinBase(rootBase, 'bots');
    const roleDir = resolveWithinBase(botsDir, role);
    const personaBaseDir = resolveWithinBase(roleDir, personaName);

    // Mount persona dir writable so bots can edit their own CLAUDE.md
    mountIfExists(mounts, personaBaseDir, '/workspace/persona', false, roleDir);

    // Mount ROOM.md as read-only CLAUDE.md at workspace root
    const roomMd = resolveWithinBase(roleDir, 'ROOM.md');
    mountIfExists(mounts, roomMd, '/workspace/CLAUDE.md', true, roleDir);

    // Mount memory from secrets repo
    try {
      const config = loadShipConfig();
      const secretsBase = normalizeBasePath(path.join(config.secretsPath, 'bots'));
      const memoryDir = resolveWithinBase(secretsBase, personaName, 'memory');
      fs.mkdirSync(memoryDir, { recursive: true });
      const realMemoryDir = fs.realpathSync(memoryDir);
      if (!isWithinBase(secretsBase, realMemoryDir)) {
        throw new Error(`Memory path escapes secrets directory: ${realMemoryDir}`);
      }
      mounts.push({
        hostPath: realMemoryDir,
        containerPath: '/workspace/persona/memory',
        readonly: false,
      });
    } catch (err) { logger.debug({ err }, 'Memory mount skipped — no secrets config'); }
  }

  // Mount _runtime/data so WBS tools can read fleet-level state
  const runtimeDataDir = path.join(projectRoot, '_runtime', 'data');
  mountIfExists(mounts, runtimeDataDir, '/workspace/data', false, projectRoot);

  // Share host delegate auth directories
  mountIfExists(mounts, path.join(homeDir, '.codex'), '/home/node/.codex', false, homeDir);
  mountIfExists(mounts, path.join(homeDir, '.gemini'), '/home/node/.gemini', false, homeDir);

  // Per-group persistent cache
  if (!SAFE_GROUP_FOLDER.test(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for cache mount`);
  }
  const cacheBase = resolveWithinBase(dataDir, 'cache');
  const cacheDir = resolveWithinBase(cacheBase, group.folder);
  fs.mkdirSync(cacheDir, { recursive: true });
  const realCacheDir = fs.realpathSync(cacheDir);
  if (!isWithinBase(cacheBase, realCacheDir)) {
    throw new Error(`Cache path escapes cache directory: ${realCacheDir}`);
  }
  mounts.push({ hostPath: realCacheDir, containerPath: '/workspace/cache', readonly: false });

  // Mount agent-runner source from host
  const agentRunnerSrc = path.join(projectRoot, 'external', 'nanoclaw', 'container', 'agent-runner', 'src');
  mountIfExists(mounts, agentRunnerSrc, '/app/src', true, projectRoot);

  // Mount ~/.ssh writable so git can use SSH keys and update known_hosts
  // (home dir is mounted ro below, which would shadow this if not mounted separately)
  mountIfExists(mounts, path.join(homeDir, '.ssh'), '/home/node/.ssh', false, homeDir);

  // Read-only mirror of host home directory
  mounts.push({ hostPath: homeDir, containerPath: homeDir, readonly: true });

  // Additional mounts from allow-list
  if (personaName) mounts.push(...mountsForBot(personaName));

  return mounts;
}

/** Read portPublish from persona container-config.json. */
export function getPersonaPortPublish(): string[] {
  return getPersonaContainerConfig().portPublish;
}

/** Read supported settings from persona container-config.json. */
export function getPersonaContainerConfig(): { portPublish: string[]; memoryMb?: number } {
  const rootDir = process.env.INFINICLAW_ROOT;
  const personaName = process.env.PERSONA_NAME;
  const role = (process.env.ASSISTANT_ROLE || '').toLowerCase();
  if (!rootDir || !personaName) return { portPublish: [] };
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(rootDir, 'bots', role, personaName, 'container-config.json'), 'utf-8'),
    );
    const portPublish = Array.isArray(cfg.portPublish)
      ? cfg.portPublish.filter((v: unknown): v is string => typeof v === 'string')
      : [];
    const memoryMb = typeof cfg.memoryMb === 'number' ? cfg.memoryMb : undefined;
    return { portPublish, memoryMb };
  } catch {
    return { portPublish: [] };
  }
}

/** Read mcp.json from role dir for SDK passthrough. */
export function readPersonaGroupMcpServers(roleDir: string): Record<string, Record<string, unknown>> | undefined {
  const mcpJsonPath = path.join(roleDir, 'mcp.json');
  try {
    if (fs.existsSync(mcpJsonPath)) {
      const raw = fs.readFileSync(mcpJsonPath, 'utf-8');
      const mcpJson = JSON.parse(raw);
      if (mcpJson.mcpServers && Object.keys(mcpJson.mcpServers).length > 0) {
        return mcpJson.mcpServers;
      }
    }
  } catch (err) {
    logger.warn({ err, mcpJsonPath }, 'Failed to parse persona group .mcp.json');
  }
  return undefined;
}
