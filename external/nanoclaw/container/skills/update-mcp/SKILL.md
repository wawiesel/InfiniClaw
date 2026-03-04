---
name: update-mcp
description: Add or modify MCP server configuration. Use when asked to install, add, or configure an MCP server or tool integration.
---

# Update MCP

**Source of truth:** `bots/{role}/mcp.json` (in the InfiniClaw repo)

MCP config is per-role, not per-bot. All bots of the same role share the same MCP servers.

## How it works

The `mcp.json` is read by the host at container spawn time and passed to the Claude SDK. Changes take effect on next container restart.

## To add or change MCP servers

You cannot edit `mcp.json` directly — it lives outside the container. Instead:

1. Ask the Engineer to update `bots/{role}/mcp.json` in the InfiniClaw repo
2. Restart to pick up changes

## URL-based server format (host-side service)

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

## Command-based server format (in-container)

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
