---
name: wksm-setup-and-diagnosis
description: Instructions for setting up, diagnosing, and fixing the WKSM (WKS MCP Server) for any bot inside their container.
---

# WKSM Setup and Diagnosis

As the Engineer, you are responsible for making sure the WKSM (Wieselquist Knowledge System MCP Server) is operational for all bots.

## How WKSM Works

WKSM runs as an SSE proxy on the host at `http://host.containers.internal:8765/sse`. Bots connect to it via their `.mcp.json` config. The host-side proxy must be running for any bot to use WKSM.

## Container Setup for WKSM

A bot's MCP servers are configured in its **persona group `.mcp.json`** file:

```
bots/personas/<bot>/groups/main/.mcp.json
```

The `.mcp.json` must contain:
```json
{
  "mcpServers": {
    "wksm": {
      "type": "sse",
      "url": "http://host.containers.internal:8765/sse"
    }
  }
}
```

**Important notes:**
- `container-config.json` does NOT support `mcpServers` — only `.mcp.json` is read (via `readGroupMcpServers()` in `container-mounts.ts`).
- The runtime copy at `_runtime/instances/<bot>/groups/main/.mcp.json` is **read-only** and regenerates from the persona source on respawn. Always edit the persona source.
- `.mcp.json` files are gitignored. Protect them from linters via `.prettierignore` (pattern: `**/.mcp.json`).

## Diagnosis & Troubleshooting

### 1. Check if WKSM proxy is running on the host
```bash
curl -s --max-time 3 http://host.containers.internal:8765/sse
```
Should return `event: endpoint`. If it fails, restart it via IPC task:
```json
{"type":"restart_wksm","chatJid":"<room JID for status updates>"}
```
Write this to `/workspace/ipc/tasks/restart-wksm-{timestamp}.json`.

### 2. Check `mcp-debug.json`
Each bot writes debug info when its container spawns:
```
_runtime/instances/<bot>/groups/main/mcp-debug.json
```
Check:
- `hasMcpServers`: should be `true`
- `mcpServerKeys`: should include `"wksm"`
- File timestamp: if stale, the container hasn't respawned since the last config change

**Commander special case:** Commander only spawns a container when a Bridge message arrives — restarts alone do not trigger a spawn. After changing commander's config, you must send a message to Johnny5 to trigger a container spawn, then check `mcp-debug.json`.

### 3. Trailing comma in `.mcp.json` (common issue)
`readGroupMcpServers()` uses `JSON.parse`, which rejects trailing commas. As of the Feb 22 2026 fix, the parser strips trailing commas before parsing, but older deployments may silently fail.

**Symptoms:** `hasMcpServers: false` with no errors in logs.
**Fix:** Remove trailing commas from `.mcp.json`, or ensure the trailing-comma stripping code is deployed in `container-mounts.ts`.

### 4. Check bot logs
```
$INFINICLAW_ROOT/_runtime/logs/<bot>.log
$INFINICLAW_ROOT/_runtime/logs/<bot>.error.log
```
Look for `[readGroupMcpServers]` error messages (added in the Feb 22 2026 fix).

## Quick Verification Checklist

1. ✅ `curl -s --max-time 3 http://host.containers.internal:8765/sse` → returns `event: endpoint`
2. ✅ Persona `.mcp.json` exists and has valid JSON with `mcpServers.wksm`
3. ✅ `mcp-debug.json` shows `hasMcpServers: true` and `"wksm"` in keys
4. ✅ Bot can call WKSM tools (test with a simple query)
