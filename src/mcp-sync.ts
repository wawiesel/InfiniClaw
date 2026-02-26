/**
 * MCP server sync: load persona MCP servers into session settings.json.
 * Each persona can have mcp-servers/{name}/ dirs containing server code + mcp.json manifest.
 * On container spawn, manifests are merged into settings.json mcpServers section.
 * Direction is ONE-WAY: persona → session. No save-back.
 */
import fs from 'fs';
import path from 'path';

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
      servers[entry.name] = manifest;
    } catch {
      // Skip malformed manifests
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
  if (Object.keys(personaServers).length === 0) return;

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

  // Clean session MCP dir and copy server code
  if (fs.existsSync(sessionMcpDir)) {
    fs.rmSync(sessionMcpDir, { recursive: true });
  }
  fs.mkdirSync(sessionMcpDir, { recursive: true });

  for (const [name, config] of Object.entries(personaServers)) {
    // Copy server code to session
    const srcDir = path.join(personaMcpDir, name);
    const dstDir = path.join(sessionMcpDir, name);
    fs.cpSync(srcDir, dstDir, { recursive: true });

    // Rewrite config to use container-side paths
    const containerDir = `${containerMcpPath}/${name}`;
    const rewritten: McpServerConfig = {
      ...config,
      cwd: containerDir,
    };
    // Rewrite args paths that reference the server dir
    if (rewritten.args) {
      rewritten.args = rewritten.args.map((arg) =>
        arg.startsWith('./') ? `${containerDir}/${arg.slice(2)}` : arg,
      );
    }
    merged[name] = rewritten;
  }

  settings.mcpServers = merged;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}
