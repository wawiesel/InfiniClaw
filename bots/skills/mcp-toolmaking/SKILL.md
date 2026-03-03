---
name: mcp-toolmaking
description: Add or modify MCP server configuration. Use when asked to install, add, or configure an MCP server or tool integration.
---

# Update MCP

**Source of truth:** `/workspace/extra/{bot}-persona/groups/{group}/.mcp.json`

This is the ONE file for all MCP server configuration. It is a writable bind mount to the persona directory — edits persist across restarts and take effect on next container spawn.

## Adding a URL-based server (host-side service)

For services running on the host via supergateway or similar:

```json
{
  "mcpServers": {
    "server-name": {
      "type": "sse",
      "url": "http://host.containers.internal:PORT/sse"
    }
  }
}
```

**Do not change the `type` or `url` of existing servers.** The transport type and endpoint path are determined by how the host-side service is configured. If a server isn't working, report the issue to the Operator or Captain.

## Adding a command-based server (in-container)

For servers that run inside the container:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "my-command",
      "args": ["--flag"],
      "env": {
        "MY_VAR": "value"
      }
    }
  }
}
```

## How sync works

The persona `.mcp.json` is read by the host at container spawn time and passed to the Claude SDK. Edits to it from inside the container (via the writable mount) persist immediately to the host filesystem. The running container keeps its original config until restart — changes take effect on the next spawn.

Edits inside the container session (e.g. to `/home/node/.claude/`) are **lost on restart**. Always edit the persona dir directly.

## After adding

Restart to activate. Ask Cid via `restart_bot`, or use `restart_self`.
