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
import { validateAdditionalMounts } from 'nanoclaw/mount-security.js';
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
export function buildBotDirectory(): Record<string, string> {
  const rootDir = process.env.INFINICLAW_ROOT;
  if (!rootDir) return {};
  const profilesDir = path.join(rootDir, 'bots', 'profiles');
  if (!fs.existsSync(profilesDir)) return {};
  const directory: Record<string, string> = {};
  try {
    for (const bot of fs.readdirSync(profilesDir)) {
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
  } catch { /* best effort */ }
  return directory;
}

// ── Helper functions ────────────────────────────────────────────────────

function loadPersonaConfig(rootDir: string, personaName: string): Record<string, unknown> {
  const personaConfigPath = path.join(rootDir, 'bots', 'personas', personaName, 'container-config.json');
  try {
    if (fs.existsSync(personaConfigPath)) {
      return JSON.parse(fs.readFileSync(personaConfigPath, 'utf-8'));
    }
  } catch (err) {
    logger.warn({ personaConfigPath, error: err }, 'Failed to load persona container config');
  }
  return {};
}

function mountIfExists(
  mounts: VolumeMount[],
  hostPath: string,
  containerPath: string,
  readonly: boolean,
): void {
  if (fs.existsSync(hostPath)) {
    mounts.push({ hostPath, containerPath, readonly });
  }
}

// TODO: This bidirectional sync contradicts one-way sync principle.
// Should be persona → container only, with explicit save-back command.
function syncMcpJson(groupsDir: string, groupFolder: string, personaBaseDir: string): void {
  const groupDir = path.join(groupsDir, groupFolder);
  const containerMcpJson = path.join(groupDir, '.mcp.json');
  const personaGroupDir = path.join(personaBaseDir, 'groups', groupFolder);
  const personaMcpJson = path.join(personaGroupDir, '.mcp.json');

  // Save-back: if container has .mcp.json, copy to persona
  if (fs.existsSync(containerMcpJson)) {
    fs.mkdirSync(personaGroupDir, { recursive: true });
    fs.copyFileSync(containerMcpJson, personaMcpJson);
  }
  // Restore: if persona has .mcp.json, copy to container
  if (fs.existsSync(personaMcpJson)) {
    fs.copyFileSync(personaMcpJson, containerMcpJson);
  }
}

function addValidatedMounts(
  mounts: VolumeMount[],
  group: RegisteredGroup,
  personaConfig: Record<string, unknown>,
  isMain: boolean,
): void {
  const allAdditionalMounts = [
    ...(group.containerConfig?.additionalMounts || []),
    ...((personaConfig.additionalMounts as Array<{hostPath: string; containerPath?: string; readonly?: boolean}>) || []),
  ];
  if (allAdditionalMounts.length > 0) {
    const validatedMounts = validateAdditionalMounts(
      allAdditionalMounts,
      group.name,
      isMain,
      process.env.PERSONA_NAME,
    );
    mounts.push(...validatedMounts);
  }
}

// ── Main mount builder ──────────────────────────────────────────────────

/**
 * Build InfiniClaw-specific volume mounts.
 * Returns additional VolumeMount entries to append to the base mounts.
 */
export function buildInfiniClawMounts(opts: InfiniClawMountOptions): VolumeMount[] {
  const { group, isMain, groupSessionsDir, groupsDir, dataDir, projectRoot } = opts;
  const mounts: VolumeMount[] = [];
  const homeDir = process.env.HOME || os.homedir();

  const rootDir = process.env.INFINICLAW_ROOT;
  const personaName = process.env.PERSONA_NAME;

  // Load persona container config
  const personaConfig = rootDir && personaName
    ? loadPersonaConfig(rootDir, personaName)
    : {};

  // Sync skills and persona mounts
  const skillsDst = path.join(groupSessionsDir, 'skills');
  const sharedSkillsSrc = path.join(projectRoot, 'external', 'nanoclaw', 'container', 'skills');

  if (rootDir && personaName) {
    const personaBaseDir = path.join(rootDir, 'bots', 'personas', personaName);
    const personaSkillsDir = path.join(personaBaseDir, 'skills');
    loadSkillsToSession(skillsDst, personaSkillsDir, sharedSkillsSrc);
    syncMcpJson(groupsDir, group.folder, personaBaseDir);

    // Mount persona dir writable so bots can edit their own CLAUDE.md
    mounts.push({
      hostPath: personaBaseDir,
      containerPath: `/workspace/extra/${personaName}-persona`,
      readonly: false,
    });
  }

  // Lock group CLAUDE.md read-only
  const groupClaudeMd = path.join(groupsDir, group.folder, 'CLAUDE.md');
  mountIfExists(mounts, groupClaudeMd, '/workspace/group/CLAUDE.md', true);

  // Share host delegate auth directories
  mountIfExists(mounts, path.join(homeDir, '.codex'), '/home/node/.codex', false);
  mountIfExists(mounts, path.join(homeDir, '.gemini'), '/home/node/.gemini', false);

  // Per-group persistent cache
  const cacheDir = path.join(dataDir, 'cache', group.folder);
  fs.mkdirSync(cacheDir, { recursive: true });
  mounts.push({ hostPath: cacheDir, containerPath: '/workspace/cache', readonly: false });

  // Mount agent-runner source from host
  const agentRunnerSrc = path.join(projectRoot, 'external', 'nanoclaw', 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Read-only mirror of host home directory
  mounts.push({ hostPath: homeDir, containerPath: homeDir, readonly: true });

  // Additional mounts from persona and group config
  addValidatedMounts(mounts, group, personaConfig, isMain);

  return mounts;
}

/** Read portPublish from persona container-config.json. */
export function getPersonaPortPublish(): string[] {
  const rootDir = process.env.INFINICLAW_ROOT;
  const personaName = process.env.PERSONA_NAME;
  if (!rootDir || !personaName) return [];
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(rootDir, 'bots', 'personas', personaName, 'container-config.json'), 'utf-8'),
    );
    return (cfg.portPublish as string[] | undefined) || [];
  } catch {
    return [];
  }
}

/** Read .mcp.json from group dir for SDK passthrough. */
export function readGroupMcpServers(groupDir: string): Record<string, Record<string, unknown>> | undefined {
  const mcpJsonPath = path.join(groupDir, '.mcp.json');
  try {
    if (fs.existsSync(mcpJsonPath)) {
      let raw = fs.readFileSync(mcpJsonPath, 'utf-8');
      // Strip trailing commas before } or ] so linters/formatters don't break JSON.parse
      raw = raw.replace(/,\s*([}\]])/g, '$1');
      const mcpJson = JSON.parse(raw);
      if (mcpJson.mcpServers && Object.keys(mcpJson.mcpServers).length > 0) {
        return mcpJson.mcpServers;
      }
    }
  } catch (err) {
    // Log the error so MCP failures aren't silently swallowed
    console.error(`[readGroupMcpServers] Failed to parse ${mcpJsonPath}:`, err);
  }
  return undefined;
}
