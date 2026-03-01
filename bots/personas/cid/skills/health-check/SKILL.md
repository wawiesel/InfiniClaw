---
name: health-check
description: Check host and bot health. Use to diagnose issues, verify deployments, or monitor system state.
---

# Health Check

Use the `check_health` MCP tool to read the host status snapshot. The host writes this every 30 seconds.

```
check_health()
```

## What it returns

| Field | Meaning |
|-------|---------|
| `timestamp` | When the snapshot was written |
| `bot` | This bot's name |
| `role`, `model`, `provider` | Current LLM config |
| `brainModes` | Brain mode (anthropic/ollama) and model for each bot |
| `groups[]` | Per-room status: active containers, pending messages/tasks, current objective, last error |

## What to look for

- **`active: true`** — a container is running for that room right now
- **`pendingMessages > 0`** — messages queued but not yet processed
- **`lastError`** / **`lastErrorAt`** — most recent failure in that room
- **`brainModes`** — confirms which backend each bot is using

## Also useful

- `get_brain_mode` — quick view of just the brain modes
- `restart_self(bot)` — restart a bot if something looks wrong (see reboot skill)
