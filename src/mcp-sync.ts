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

/** Read mcp.json manifests from a persona's mcp-servers/ directory. */
function readPersonaMcpServers(
  personaMcpDir: string,
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  if (!fs.existsSync(personaMcpDir)) return servers;

  for (const entry of fs.readdirSync(personaMcpDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(personaMcpDir, entry.name, 'mcp.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(
        fs.readFileSync(manifestPath, 'utf-8'),
      ) as McpServerConfig;

      if (manifest.args !== undefined && !Array.isArray(manifest.args)) {
        logger.warn(
          { manifestPath, server: entry.name },
          'Invalid mcp.json: "args" must be an array; skipping MCP server',
        );
        continue;
      }

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
  const existing =
    (settings.mcpServers as Record<string, unknown> | undefined) || {};
  const merged: Record<string, unknown> = { ...existing };

  // Remove stale persona-managed entries that no longer exist in persona manifests.
  for (const name of previousPersonaOwned) {
    if (!personaServerNames.has(name)) {
      delete merged[name];
    }
  }

  // Clean session MCP dir and copy server code
  if (fs.existsSync(sessionMcpDir)) {
    fs.rmSync(sessionMcpDir, { recursive: true });
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
    rewritten.args = rewritten.args.map((arg) =>
      arg.startsWith('./') ? `${containerDir}/${arg.slice(2)}` : arg,
    );
    merged[name] = rewritten;
  }

  settings.mcpServers = merged;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}
