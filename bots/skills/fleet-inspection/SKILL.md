---
name: fleet-inspection
description: Monitor and maintain optimal fleet operation. Use for health checks, diagnostics, restarts, rebuilds, bot relocation, and ensuring bots are running correctly.
---

# Fleet Inspection

## Restart a Bot

```
restart_self(bot: "cid")      # Restart yourself
restart_self(bot: "parker")   # Restart Parker
```

What happens on restart:
1. `tsc --noEmit` validation — if it fails, bot stays up and you get errors to fix
2. Rsync nanoclaw source, install deps if changed, build TypeScript
3. Restore persona (appends persona CLAUDE.md to base)
4. Rebuild container image (picks up Dockerfile changes)
5. Restart bot process via launchd

Skills, CLAUDE.md changes, and container image updates all take effect after reboot.

## Edit Container Images

Dockerfiles live at `$INFINICLAW_ROOT/bots/{role}/{bot}/Dockerfile` (next to CLAUDE.md).

To rebuild without a full bot restart:
```bash
echo '{"type":"rebuild_image","bot":"cid"}' > /workspace/ipc/tasks/rebuild-$(date +%s).json
```
Takes effect on next container spawn — restart bot afterwards to force it.

## Source Editing & Building

```bash
cd $INFINICLAW_ROOT
npm run build          # builds nanoclaw first, then InfiniClaw
npm test               # runs InfiniClaw tests
```

## Git Hooks

Pre-commit hooks guard `bots/` and `docs/` structure. Tracked in `.githooks/`.
```bash
cd $INFINICLAW_ROOT && git config core.hooksPath .githooks
```

## Quick Health Snapshot

```
check_health()      # Full status snapshot (bots, containers, errors, brain modes)
get_brain_mode()    # Just the LLM backend for each bot
```

Key fields: `active`, `pendingMessages`, `lastError`, `brainModes`.

## Deep Diagnostic Checks

### Podman + images
```bash
podman info --format '{{.Host.Arch}}' 2>&1 | head -1
podman images --format '{{.Repository}}:{{.Tag}}' | grep nanoclaw
```

### Bot heartbeats
```bash
cat $INFINICLAW_ROOT/_runtime/instances/<bot>/data/heartbeat 2>/dev/null
```

### Recent errors
```bash
tail -20 $INFINICLAW_ROOT/_runtime/logs/<bot>.error.log
```

### Container logs
```bash
tail -30 $(ls -t $INFINICLAW_ROOT/_runtime/instances/<bot>/groups/main/logs/container-*.log 2>/dev/null | head -1)
```

### IPC state
```bash
ls $INFINICLAW_ROOT/_runtime/instances/<bot>/data/ipc/main/messages/
ls $INFINICLAW_ROOT/_runtime/instances/<bot>/data/ipc/main/tasks/
```

### WKSM proxy
```bash
curl -s --max-time 3 http://host.containers.internal:8765/sse | head -2
```
Should return `event: endpoint`. If not, call `escalate to operator`.

### Google Workspace MCP
Host-side launchd service on port 8767. Log at `~/.config/infiniclaw/logs/workspace-mcp.log`. OAuth creds at `~/.config/infiniclaw/secrets/google/`. Auth errors → escalate to Captain.

## Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `hasMcpServers: false` | Bad JSON in mcp.json | Fix JSON, restart |
| WKSM not connecting | Proxy down | `escalate to operator` |
| Container exits immediately | Auth missing or image outdated | Check env, rebuild |
| `pendingMessages` stuck | Container hung | Check logs, restart |

## Bot Relocation (S3)

Move a bot between machines. A bot runs on exactly one machine at a time.

### Sending (source machine)
1. Stop: `npm run cli stop <bot>`
2. Push state: `cd $INFINICLAW_ROOT && npm run cli sync push`
3. Remove from `~/.config/infiniclaw/machine.json` `bots` array
4. Message destination engineer: `@<engineer> transporter: receiving <bot>. State pushed. Pull and start.`
5. Restart remaining bots

### Receiving (destination machine)
1. Add to `~/.config/infiniclaw/machine.json` `bots` array
2. Verify: env file, allow-list.json entry, container image
3. Pull state: `cd $INFINICLAW_ROOT && npm run cli sync pull`
4. Start: `npm run cli start`
5. Confirm: `@<engineer> transporter: <bot> received and running.`

**Never run the same bot on two machines simultaneously.**
