/**
 * InfiniClaw container volume mounts.
 * Persona, skills, MCP sync, delegate auth, cache, and agent-runner source.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseEnvLine } from './env-utils.js';
import { logger } from './logger.js';
import { loadSkillsToSession } from './skill-sync.js';
import { validateAdditionalMounts } from './mount-security.js';
import type { RegisteredGroup } from './types.js';

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

  // Load persona container config (version-controlled alongside env/skills)
  let personaConfig: Record<string, unknown> = {};
  if (rootDir && personaName) {
    const personaConfigPath = path.join(rootDir, 'bots', 'personas', personaName, 'container-config.json');
    try {
      if (fs.existsSync(personaConfigPath)) {
        personaConfig = JSON.parse(fs.readFileSync(personaConfigPath, 'utf-8'));
      }
    } catch (err) {
      logger.warn({ personaConfigPath, error: err }, 'Failed to load persona container config');
    }
  }

  // Sync skills: save session → persona (replace), then rebuild session from shared + persona
  const skillsDst = path.join(groupSessionsDir, 'skills');
  const sharedSkillsSrc = path.join(projectRoot, 'container', 'skills');

  if (rootDir && personaName) {
    const personaBaseDir = path.join(rootDir, 'bots', 'personas', personaName);
    const personaSkillsDir = path.join(personaBaseDir, 'skills');
    loadSkillsToSession(skillsDst, personaSkillsDir, sharedSkillsSrc);

    // Two-way sync .mcp.json: save-back container → persona, then restore persona → container
    const groupDir = path.join(groupsDir, group.folder);
    const containerMcpJson = path.join(groupDir, '.mcp.json');
    const personaGroupDir = path.join(personaBaseDir, 'groups', group.folder);
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

    // Mount persona dir writable so bots can edit their own CLAUDE.md (two-way sync)
    mounts.push({
      hostPath: personaBaseDir,
      containerPath: `/workspace/extra/${personaName}-persona`,
      readonly: false,
    });
  }

  // Share host Codex login state with container delegate_codex runs.
  const hostCodexDir = path.join(homeDir, '.codex');
  if (fs.existsSync(hostCodexDir)) {
    mounts.push({
      hostPath: hostCodexDir,
      containerPath: '/home/node/.codex',
      readonly: false,
    });
  }

  // Share host Gemini login/config with container delegate_gemini runs.
  const hostGeminiDir = path.join(homeDir, '.gemini');
  if (fs.existsSync(hostGeminiDir)) {
    mounts.push({
      hostPath: hostGeminiDir,
      containerPath: '/home/node/.gemini',
      readonly: false,
    });
  }

  // Per-group persistent cache for model/tool downloads (docling, huggingface, pip, etc.).
  const cacheDir = path.join(dataDir, 'cache', group.folder);
  fs.mkdirSync(cacheDir, { recursive: true });
  mounts.push({
    hostPath: cacheDir,
    containerPath: '/workspace/cache',
    readonly: false,
  });

  // Mount agent-runner source from host — recompiled on container startup.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({
    hostPath: agentRunnerSrc,
    containerPath: '/app/src',
    readonly: true,
  });

  // Additional mounts: merge persona container-config.json with group DB config.
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
      const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
      if (mcpJson.mcpServers && Object.keys(mcpJson.mcpServers).length > 0) {
        return mcpJson.mcpServers;
      }
    }
  } catch { /* ignore */ }
  return undefined;
}
