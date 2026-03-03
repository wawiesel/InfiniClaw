---
name: diagnose
description: Diagnose and monitor InfiniClaw — check bot health, uptime, containers, MCP servers, WKSM, errors, and IPC state. One-stop troubleshooting skill.
---

# InfiniClaw Diagnostics

## Quick Health Snapshot

```
check_health()      # Full status snapshot (bots, containers, errors, brain modes)
get_brain_mode()    # Just the LLM backend for each bot
```

Key fields to check:
- **`active: true`** — container is running
- **`pendingMessages > 0`** — messages queued but unprocessed
- **`lastError` / `lastErrorAt`** — most recent failure
- **`brainModes`** — confirms which backend each bot is using

## Deep Diagnostic Checks

### 1. Podman + images
```bash
podman info --format '{{.Host.Arch}}' 2>&1 | head -1
podman images --format '{{.Repository}}:{{.Tag}}' | grep nanoclaw
```

### 2. Bot heartbeats
```bash
cat $INFINICLAW_ROOT/_runtime/instances/cid/data/heartbeat 2>/dev/null || echo "no heartbeat"
cat $INFINICLAW_ROOT/_runtime/instances/johnny5/data/heartbeat 2>/dev/null || echo "no heartbeat"
```

### 3. MCP servers loaded
```bash
cat $INFINICLAW_ROOT/_runtime/instances/johnny5/groups/main/mcp-debug.json
```
Look for `hasMcpServers: true` and `wksm` in `mcpServerKeys`. If false, validate:
```bash
python3 -m json.tool $INFINICLAW_ROOT/bots/personas/johnny5/groups/main/.mcp.json
```

### 4. Recent errors
```bash
tail -20 $INFINICLAW_ROOT/_runtime/logs/cid.error.log 2>/dev/null
tail -20 $INFINICLAW_ROOT/_runtime/logs/johnny5.error.log 2>/dev/null
```

### 5. Session continuity
```bash
grep "sessionId" $INFINICLAW_ROOT/_runtime/logs/cid.log 2>/dev/null | tail -5
```

### 6. Container logs
```bash
tail -30 $(ls -t $INFINICLAW_ROOT/_runtime/instances/cid/groups/main/logs/container-*.log 2>/dev/null | head -1)
```

### 7. IPC state
```bash
ls $INFINICLAW_ROOT/_runtime/instances/cid/data/ipc/main/messages/ 2>/dev/null
ls $INFINICLAW_ROOT/_runtime/instances/cid/data/ipc/main/tasks/ 2>/dev/null
```

### 8. WKSM proxy
```bash
curl -s --max-time 3 http://host.containers.internal:8765/sse | head -2
```
Should return `event: endpoint`. If not, call `restart_wksm()`.

## WKSM Setup & Diagnosis

WKSM runs as an SSE proxy on the host at `http://host.containers.internal:8765/sse`. Bots connect via their `.mcp.json`.

### MCP config location
```
bots/personas/<bot>/groups/main/.mcp.json
```
Must contain:
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

**Notes:**
- `container-config.json` does NOT support `mcpServers` — only `.mcp.json` is read.
- Runtime copy at `_runtime/instances/<bot>/groups/main/.mcp.json` is read-only; always edit persona source.
- `.mcp.json` is gitignored. Validate JSON before saving: `python3 -m json.tool <file>`.

### WKSM verification checklist
1. ✅ `curl -s --max-time 3 http://host.containers.internal:8765/sse` → `event: endpoint`
2. ✅ Persona `.mcp.json` exists with valid JSON and `mcpServers.wksm`
3. ✅ `mcp-debug.json` shows `hasMcpServers: true` and `"wksm"` in keys
4. ✅ Bot can call WKSM tools (test with a simple query)

### Johnny5 special case
Johnny5 only spawns a container when a Bridge message arrives — restarts alone don't trigger a spawn. After changing his config, send a message to Johnny5 to trigger a container spawn, then check `mcp-debug.json`.

### Trailing comma in .mcp.json
`readGroupMcpServers()` uses `JSON.parse`, which rejects trailing commas. Symptoms: `hasMcpServers: false` with no errors. Fix: remove trailing commas.

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `hasMcpServers: false` | Trailing comma in `.mcp.json` | Fix JSON, restart |
| WKSM not connecting | Proxy down or port 8765 not listening | `restart_wksm()` |
| Container exits immediately | Auth missing or image outdated | Check `.env`, rebuild image |
| No session resumption | Sessions dir not mounted | Check container-spawn.ts mounts |
| IPC files accumulating | IPC watcher not running | Restart bot |
| `pendingMessages` stuck | Container hung | Check container logs, restart |
