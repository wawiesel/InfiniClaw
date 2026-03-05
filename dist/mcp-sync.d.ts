/**
 * Load persona MCP servers into settings.json and copy server code to session.
 * Server code is copied to sessionMcpDir/{name}/ so the container can access it.
 * Manifest paths are rewritten to point to the container mount path.
 */
export declare function loadMcpServersToSettings(settingsPath: string, personaMcpDir: string, sessionMcpDir: string, containerMcpPath: string): void;
