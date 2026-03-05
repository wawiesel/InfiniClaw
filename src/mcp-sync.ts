/**
 * MCP server sync: load persona MCP servers into session settings.json.
 * Each persona can have mcp-servers/{name}/ dirs containing server code + mcp.json manifest.
 * On container spawn, manifests are merged into settings.json mcpServers section.
 * Direction is ONE-WAY: persona → session. No save-back.
 */
import fs from 'fs';
import path from 'path';
import { logger } from 'nanoclaw/logger.js';

interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
}

const SAFE_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateManifest(
  manifest: unknown,
  manifestPath: string,
  server: string,
): McpServerConfig | null {
  if (!isPlainObject(manifest)) {
    logger.warn(
      { manifestPath, server },
      'Invalid mcp.json: manifest must be an object; skipping MCP server',
    );
    return null;
  }

  const cfg = manifest as Record<string, unknown>;
  if (cfg.command !== undefined && (typeof cfg.command !== 'string' || cfg.command.trim() === '')) {
    logger.warn(
      { manifestPath, server },
      'Invalid mcp.json: "command" must be a non-empty string; skipping MCP server',
    );
    return null;
  }
  if (cfg.url !== undefined && (typeof cfg.url !== 'string' || cfg.url.trim() === '')) {
    logger.warn(
      { manifestPath, server },
      'Invalid mcp.json: "url" must be a non-empty string; skipping MCP server',
    );
    return null;
  }
  if (cfg.command === undefined && cfg.url === undefined) {
    logger.warn(
      { manifestPath, server },
      'Invalid mcp.json: one of "command" or "url" is required; skipping MCP server',
    );
    return null;
  }
  if (cfg.args !== undefined) {
    if (!Array.isArray(cfg.args) || cfg.args.some((arg) => typeof arg !== 'string')) {
      logger.warn(
        { manifestPath, server },
        'Invalid mcp.json: "args" must be an array of strings; skipping MCP server',
      );
      return null;
    }
  }
  if (cfg.cwd !== undefined && typeof cfg.cwd !== 'string') {
    logger.warn(
      { manifestPath, server },
      'Invalid mcp.json: "cwd" must be a string; skipping MCP server',
    );
    return null;
  }
  if (cfg.env !== undefined) {
    if (!isPlainObject(cfg.env)) {
      logger.warn(
        { manifestPath, server },
        'Invalid mcp.json: "env" must be an object; skipping MCP server',
      );
      return null;
    }
    for (const [key, value] of Object.entries(cfg.env)) {
      if (!SAFE_ENV_NAME.test(key) || typeof value !== 'string') {
        logger.warn(
          { manifestPath, server },
          'Invalid mcp.json: "env" must map safe variable names to string values; skipping MCP server',
        );
        return null;
      }
    }
  }

  return cfg as McpServerConfig;
}

function rewriteArgPath(containerDir: string, arg: string): string | null {
  if (!arg.startsWith('./')) return arg;
  const normalized = path.posix.normalize(path.posix.join(containerDir, arg.slice(2)));
  if (normalized === containerDir || normalized.startsWith(`${containerDir}/`)) {
    return normalized;
  }
  return null;
}

/** Read mcp.json manifests from a persona's mcp-servers/ directory. */
function readPersonaMcpServers(
  personaMcpDir: string,
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = Object.create(null) as Record<string, McpServerConfig>;
  if (!fs.existsSync(personaMcpDir)) return servers;

  for (const entry of fs.readdirSync(personaMcpDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!SAFE_SERVER_NAME.test(entry.name)) {
      logger.warn(
        { server: entry.name },
        'Invalid MCP server directory name; skipping MCP server',
      );
      continue;
    }
    const manifestPath = path.join(personaMcpDir, entry.name, 'mcp.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(manifestPath, 'utf-8'),
      );
      const manifest = validateManifest(parsed, manifestPath, entry.name);
      if (!manifest) continue;

      servers[entry.name] = manifest;
    } catch (err) {
      logger.warn(
        { err, manifestPath, server: entry.name },
        'Malformed mcp.json; skipping MCP server',
      );
    }
  }
  return servers;
}

/**
 * Load persona MCP servers into settings.json and copy server code to session.
 * Server code is copied to sessionMcpDir/{name}/ so the container can access it.
 * Manifest paths are rewritten to point to the container mount path.
 */
export function loadMcpServersToSettings(
  settingsPath: string,
  personaMcpDir: string,
  sessionMcpDir: string,
  containerMcpPath: string,
): void {
  const personaServers = readPersonaMcpServers(personaMcpDir);
  const personaServerNames = new Set(Object.keys(personaServers));

  // Track persona-owned keys from the previous sync run before cleaning session dir.
  const previousPersonaOwned = new Set<string>();
  if (fs.existsSync(sessionMcpDir)) {
    for (const entry of fs.readdirSync(sessionMcpDir, { withFileTypes: true })) {
      if (entry.isDirectory()) previousPersonaOwned.add(entry.name);
    }
  }

  // Read existing settings
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  // Merge MCP servers into settings (preserve existing non-persona servers)
  const existingRaw = settings.mcpServers;
  const existing =
    isPlainObject(existingRaw)
      ? (existingRaw as Record<string, unknown>)
      : (Object.create(null) as Record<string, unknown>);
  const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(existing)) {
    merged[key] = value;
  }

  // Remove stale persona-managed entries that no longer exist in persona manifests.
  for (const name of previousPersonaOwned) {
    if (!personaServerNames.has(name)) {
      delete merged[name];
    }
  }

  // Clean session MCP dir and copy server code
  if (fs.existsSync(sessionMcpDir)) {
    fs.rmSync(sessionMcpDir, { recursive: true, force: true });
  }
  fs.mkdirSync(sessionMcpDir, { recursive: true });

  for (const [name, config] of Object.entries(personaServers)) {
    // Copy server code to session
    const srcDir = path.join(personaMcpDir, name);
    const dstDir = path.join(sessionMcpDir, name);
    try {
      fs.cpSync(srcDir, dstDir, { recursive: true });
    } catch (err) {
      logger.warn({ err, name }, 'Failed to copy MCP server dir — skipping');
      delete merged[name];
      continue;
    }

    // Rewrite config to use container-side paths
    const containerDir = `${containerMcpPath}/${name}`;
    const rewritten: McpServerConfig = {
      ...config,
      cwd: containerDir,
    };
    // Rewrite args paths that reference the server dir
    if (rewritten.args === undefined) {
      rewritten.args = [];
    } else if (!Array.isArray(rewritten.args)) {
      logger.warn(
        { name },
        'Invalid MCP config: "args" must be an array; skipping MCP server',
      );
      continue;
    }
    const rewrittenArgs: string[] = [];
    let invalidArgPath = false;
    for (const arg of rewritten.args) {
      const rewrittenArg = rewriteArgPath(containerDir, arg);
      if (rewrittenArg === null) {
        invalidArgPath = true;
        break;
      }
      rewrittenArgs.push(rewrittenArg);
    }
    if (invalidArgPath) {
      logger.warn(
        { name },
        'Invalid MCP config: args path escapes server directory; skipping MCP server',
      );
      delete merged[name];
      continue;
    }
    rewritten.args = rewrittenArgs;
    merged[name] = rewritten;
  }

  settings.mcpServers = merged;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}
