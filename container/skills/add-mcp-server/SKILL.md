---
name: add-mcp-server
description: Add an MCP server to this bot. Use when asked to install, add, or configure an MCP server or tool integration.
---

# Add MCP Server

There are two methods depending on where the server runs.

## Method 1: URL-based (SSE) — host-side service

Edit `container-config.json` for this bot's persona (source of truth, mounted writable):

```
$INFINICLAW/bots/personas/{bot}/container-config.json
```

```json
{
  "mcpServers": {
    "server-name": {
      "url": "http://host.containers.internal:PORT/sse"
    }
  }
}
```

Use this for services running on the host (e.g. wksm at port 8765).

## Method 2: Command-based — in-container server

Edit the persona `.mcp.json` (source of truth, mounted writable):

```
/workspace/extra/{bot}-persona/groups/{group}/.mcp.json
```

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

The group name for commander is `main`. The writable persona path is `/workspace/extra/commander-persona/`.

### If the server needs OAuth (e.g. Google Workspace)

OAuth servers start an HTTP listener on a port inside the container for the callback. The callback URL (e.g. `http://localhost:8000/oauth2callback`) must be reachable from the user's browser — which means the container port must be forwarded to the host.

**Step 1: Add port forwarding to `container-config.json`**

```json
{
  "portPublish": ["9000:8000"],
  "additionalMounts": [...]
}
```

Format: `"hostPort:containerPort"`. Pick a host port that doesn't conflict (e.g. 9000).

**Step 2: Register `http://localhost:9000/oauth2callback` as an authorized redirect URI** in your OAuth client (Google Cloud Console → APIs & Services → Credentials).

**Step 3: Configure the server** in `.mcp.json` with the env vars it needs:

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "workspace-mcp",
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "YOUR_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_SECRET": "YOUR_CLIENT_SECRET",
        "GOOGLE_MCP_CREDENTIALS_DIR": "/path/to/writable/dir"
      }
    }
  }
}
```

**Step 4: Ensure the credentials dir is writable.** Add it as a writable mount in `container-config.json` and to `mount-allowlist.json`. Token files are written there after auth and must persist across restarts.

**Step 5: Restart**, then on first tool use the server will output an OAuth URL. Visit it, authorize, and the token is saved to the credentials dir automatically.

## How sync works

Everything is **one-way**: persona → session on each container spawn. Edits inside the container session (e.g. to `/home/node/.claude/`) are **lost on restart**. Always edit the persona dir directly — it's mounted writable.

## After adding

Restart to activate. Ask Cid via `restart_bot`, or use `restart_self`.
