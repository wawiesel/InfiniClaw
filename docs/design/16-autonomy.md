# 16 — Autonomy

## Bot Capabilities

| Capability | How |
|-----------|-----|
| Rebuild own container image | IPC task `rebuild_image` |
| Restart self or other bots | IPC task `refresh_bot` |
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

## Holodeck

Architects can test changes in isolation before deploying to production. The holodeck creates a git worktree from a feature branch, deploys to a separate instance (`_runtime/instances/{bot}-holodeck/`), and runs as its own pm2 process in terminal-only mode (no Matrix). CLI commands: `holodeck create|chat|teardown|promote`.

Engineers must use the holodeck as part of the deployment chain — code cannot merge to main until it passes a full end-to-end simulation with a fake crew. See [18-deployment](18-deployment.md) for the full spec.

## Verification

1. **Self-restart** — Bot detects a problem and requests restart via IPC.
   *Check:* IPC command processed, bot restarts, reports resolution in Matrix.

2. **Image rebuild** — Bot triggers `rebuild_image` IPC task.
   *Check:* New container image built, bot restarted with new image.

3. **MCP self-fix** — Break a bot's MCP config, let it detect and fix.
   *Check:* Bot edits `.mcp.json`, requests restart, MCP connects on next spawn.

4. **Operator only intervenes when necessary** — Bot handles routine failures autonomously.
   *Check:* No operator action needed for MCP failures, OOM recovery, config fixes.

5. **Holodeck isolation** — Create a holodeck instance.
   *Check:* Separate pm2 process, no Matrix connection, isolated worktree.
