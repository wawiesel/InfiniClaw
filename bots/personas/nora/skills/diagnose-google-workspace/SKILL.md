# Diagnose Google Workspace MCP

Use this skill when Google Workspace tools (Gmail, Calendar, Drive) fail or return errors.

## Architecture

The Google Workspace MCP server runs on the **host machine** as a launchd service, not inside your container. You access it over HTTP via `host.containers.internal:8767`.

| Component | Location |
|-----------|----------|
| MCP server | `workspace-mcp` Python process on host, port 8767 |
| launchd plist | `~/Library/LaunchAgents/com.wieselquist.workspace-mcp.plist` |
| Log file | `~/.config/infiniclaw/logs/workspace-mcp.log` |
| OAuth credentials | `~/.config/infiniclaw/secrets/google/` |
| OAuth client config | In the plist as `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` |

## Diagnostic steps

### 1. Check if the server is reachable

Try calling any Google Workspace tool (e.g., `gmail_get_profile`). If it works, the server is fine.

### 2. If tools fail with connection errors

The server is down or unreachable. You cannot fix this directly — it's a host-level service.

**Read the log** to understand why:
```
/Users/ww5/.config/infiniclaw/logs/workspace-mcp.log
```

Common causes:
- **Port conflict**: Another process on port 8767. Log will show bind errors.
- **Crash loop**: launchd keeps restarting a failing process. Log will show repeated startup messages.
- **Python env broken**: The venv at `/Users/ww5/.venv/bin/workspace-mcp` is missing or broken.

### 3. If tools fail with auth/permission errors

The OAuth tokens are missing or expired. Tokens live in:
```
~/.config/infiniclaw/secrets/google/
```

If this directory is empty, the Captain needs to run the OAuth authorization flow in a browser. Tell the Captain:
> "Google Workspace OAuth tokens are missing. The Captain needs to open the auth URL from the workspace-mcp log to authorize access."

If tokens exist but are expired, the server should auto-refresh them. If refresh fails, the tokens need to be deleted and the auth flow re-run.

### 4. If only some tools fail

Check which Google API scopes are authorized. The server is configured for `gmail`, `calendar`, and `drive` tools. If one fails but others work, the scope for that service may not have been granted during the OAuth flow.

## What you can fix yourself

- **Nothing host-side.** The MCP server is a host process — you cannot restart launchd services from inside your container.
- **Report the problem.** Read the log, diagnose the cause, and tell the Captain or ask Cid (Engineer) to fix it via IPC.

## What to escalate

| Symptom | Escalate to |
|---------|-------------|
| Server down / crash loop | Captain or Cid — needs host-side restart |
| Missing OAuth tokens | Captain — needs browser auth flow |
| Python env broken | Cid — needs venv rebuild |
| Port conflict | Captain or Cid — needs process investigation |

## Previous issues

- **2026-03-01**: Credentials directory moved from `bots/profiles/commander` (deleted during restructure) to `~/.config/infiniclaw/secrets/google/`. Plist updated to use `GOOGLE_MCP_CREDENTIALS_DIR` pointing to new path.
