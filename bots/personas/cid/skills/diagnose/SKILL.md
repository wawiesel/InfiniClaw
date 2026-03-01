---
name: diagnose
description: Run a quick diagnostic of the InfiniClaw system. Checks Podman, container images, MCP server loading, session continuity, recent errors, and IPC state. Use when something seems wrong or to verify a deployment.
---

# InfiniClaw Diagnostics

Run these checks to assess system health. Use `check_health` for a quick snapshot, or run the checks below for deeper diagnosis.

## Quick Health Check

```
check_health()
```

Look for: `active: true` (container running), `pendingMessages: false`, no recent `lastError`.

## Diagnostic Checks

### 1. Podman running and images present
```bash
podman info --format '{{.Host.Arch}}' 2>&1 | head -1
podman images --format '{{.Repository}}:{{.Tag}}' | grep nanoclaw
```

### 2. Bot process alive
```bash
cat $INFINICLAW_ROOT/_runtime/instances/engineer/data/heartbeat 2>/dev/null || echo "no heartbeat"
cat $INFINICLAW_ROOT/_runtime/instances/commander/data/heartbeat 2>/dev/null || echo "no heartbeat"
```

### 3. MCP servers loaded correctly
```bash
cat $INFINICLAW_ROOT/_runtime/instances/commander/groups/main/mcp-debug.json
```
Look for `hasMcpServers: true` and `wksm` in `mcpServerKeys`. If `hasMcpServers: false`, the `.mcp.json` is likely malformed (trailing comma).

Validate the JSON:
```bash
python3 -m json.tool $INFINICLAW_ROOT/bots/personas/commander/groups/main/.mcp.json
```

### 4. Recent errors
```bash
tail -50 $INFINICLAW_ROOT/_runtime/logs/engineer.error.log 2>/dev/null | tail -20
tail -50 $INFINICLAW_ROOT/_runtime/logs/commander.error.log 2>/dev/null | tail -20
```

### 5. Session continuity
```bash
# Should show the SAME session ID for consecutive runs in the same group
grep "sessionId" $INFINICLAW_ROOT/_runtime/logs/engineer.log 2>/dev/null | tail -5
```

### 6. Recent container logs
```bash
ls -t $INFINICLAW_ROOT/_runtime/instances/engineer/groups/main/logs/container-*.log 2>/dev/null | head -3
# Then tail the most recent one:
tail -30 $(ls -t $INFINICLAW_ROOT/_runtime/instances/engineer/groups/main/logs/container-*.log 2>/dev/null | head -1)
```

### 7. IPC state
```bash
# Check for stuck/unprocessed IPC files
ls $INFINICLAW_ROOT/_runtime/instances/engineer/data/ipc/main/messages/ 2>/dev/null
ls $INFINICLAW_ROOT/_runtime/instances/engineer/data/ipc/main/tasks/ 2>/dev/null

# Check available groups snapshot
cat $INFINICLAW_ROOT/_runtime/instances/engineer/data/ipc/main/available_groups.json 2>/dev/null
```

### 8. WKSM proxy alive
```bash
curl -s --max-time 3 http://host.containers.internal:8765/sse | head -2
```
Should return `event: endpoint`. If not, ask Captain to run `!restart-wksm`.

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `hasMcpServers: false` | Trailing comma in `.mcp.json` | Fix JSON, restart commander |
| WKSM not connecting | Proxy down or port 8765 not listening | `!restart-wksm` from Captain |
| Container exits immediately | Auth missing or image out of date | Check `.env`, rebuild image |
| No session resumption | Sessions dir not mounted or wrong path | Check container-spawn.ts mount paths |
| IPC files accumulating | IPC watcher not running | Restart engineer |
| `pendingMessages` stuck | Container hung | Check container logs, restart |
