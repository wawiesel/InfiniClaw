# 08 — Autonomy

## Bot Capabilities

| Capability | How |
|-----------|-----|
| Rebuild own container image | IPC task `rebuild_image` |
| Restart self or other bots | IPC task `restart_bot` |
| Push code to remote | IPC task `git_push` |
| Fix broken MCP config | Edit persona `.mcp.json`, request restart |
| Monitor health | Collect metrics, report via Matrix |
| Move between machines | Transporter skill: S3 sync + Matrix coordination |
| Update own instructions | Edit persona CLAUDE.md via writable mount |
| Add/modify skills | Write SKILL.md to persona skills directory |

## Self-Healing Loop

```
Bot detects problem (MCP down, health check fails, OOM)
  → Bot diagnoses root cause (read logs, check config)
  → Bot fixes the cause (edit config, update image, adjust memory)
  → Bot requests restart via IPC
  → Host process restarts bot with fixed config
  → Bot verifies fix on startup
  → Bot reports resolution via Matrix
```

**Operator (escape hatch only):** Cross-machine coordination when Matrix is down, OS-level fixes (pm2, podman, network), secret rotation requiring human auth, emergency intervention for restart loops.

## Activity Heartbeat

Bots must show visible activity in Matrix at a configurable interval (`HEARTBEAT_INTERVAL`, default 30s). If no user-visible output (message, reaction, edit) occurs within the interval, the host emits a heartbeat — an edited status message showing what the bot is doing (thinking, running tool, waiting for input). This is a hard requirement: the Captain must be able to tell a bot is alive from Matrix alone, without access to logs or operator tools.

## Holodeck

Architects can test changes in isolation before deploying to production. The holodeck creates a git worktree from a feature branch, deploys to a separate instance (`_runtime/instances/{bot}-holodeck/`), and runs as its own pm2 process in terminal-only mode (no Matrix). CLI commands: `holodeck create|chat|teardown|promote`.

Engineers must use the holodeck as part of the deployment chain — code cannot merge to main until it passes a full end-to-end simulation with a fake crew. See `12-deployment-chain.md` for the full spec.
