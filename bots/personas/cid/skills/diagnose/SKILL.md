---
name: diagnose
description: Diagnose and monitor InfiniClaw — check bot health, uptime, containers, MCP servers, errors, and IPC state. One-stop troubleshooting skill.
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
cat $INFINICLAW_ROOT/_runtime/instances/engineer/data/heartbeat 2>/dev/null || echo "no heartbeat"
cat $INFINICLAW_ROOT/_runtime/instances/commander/data/heartbeat 2>/dev/null || echo "no heartbeat"
```

### 3. MCP servers loaded
```bash
cat $INFINICLAW_ROOT/_runtime/instances/commander/groups/main/mcp-debug.json
```
Look for `hasMcpServers: true` and `wksm` in `mcpServerKeys`. If false, validate:
```bash
python3 -m json.tool $INFINICLAW_ROOT/bots/personas/commander/groups/main/.mcp.json
```

### 4. Recent errors
```bash
tail -20 $INFINICLAW_ROOT/_runtime/logs/engineer.error.log 2>/dev/null
tail -20 $INFINICLAW_ROOT/_runtime/logs/commander.error.log 2>/dev/null
```

### 5. Session continuity
```bash
grep "sessionId" $INFINICLAW_ROOT/_runtime/logs/engineer.log 2>/dev/null | tail -5
```

### 6. Container logs
```bash
tail -30 $(ls -t $INFINICLAW_ROOT/_runtime/instances/engineer/groups/main/logs/container-*.log 2>/dev/null | head -1)
```

### 7. IPC state
```bash
ls $INFINICLAW_ROOT/_runtime/instances/engineer/data/ipc/main/messages/ 2>/dev/null
ls $INFINICLAW_ROOT/_runtime/instances/engineer/data/ipc/main/tasks/ 2>/dev/null
```

### 8. WKSM proxy
```bash
curl -s --max-time 3 http://host.containers.internal:8765/sse | head -2
```
Should return `event: endpoint`. If not, call `restart_wksm()` or ask Captain `!restart-wksm`.

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `hasMcpServers: false` | Trailing comma in `.mcp.json` | Fix JSON, restart |
| WKSM not connecting | Proxy down or port 8765 not listening | `restart_wksm()` |
| Container exits immediately | Auth missing or image outdated | Check `.env`, rebuild image |
| No session resumption | Sessions dir not mounted | Check container-spawn.ts mounts |
| IPC files accumulating | IPC watcher not running | Restart engineer |
| `pendingMessages` stuck | Container hung | Check container logs, restart |
