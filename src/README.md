# src/ — InfiniClaw Host Process

The orchestrator that runs on the host machine (not in containers). Manages bot lifecycle, Matrix communication, and container spawning.

## Architecture

InfiniClaw wraps NanoClaw (`external/nanoclaw/`) with Matrix-specific logic. Each file here either wraps an upstream module or adds InfiniClaw-specific functionality.

```
Host machine (macOS / Linux)
├── cli.ts              → CLI entry point (start/stop/chat/send)
├── service.ts          → Deploy, start, stop bots via pm2
├── relay.ts            → Supervisor relay: Matrix watcher for bot lifecycle (!join, !dismiss, !refresh)
├── main.ts             → Message loop, indicators, container lifecycle
├── container-spawn.ts  → Build podman args, delegate to upstream runContainer()
├── container-mounts.ts → Volume mount assembly (ro home + rw workspace)
├── container-secrets.ts→ Normalize provider secrets for containers
├── channels/
│   ├── matrix.ts       → Matrix SDK: connect, send, edit, react, sync
│   └── local-cli.ts    → Terminal channel for `npm run cli chat`
├── machine-config.ts   → Read ~/.config/infiniclaw/machine.json
├── allow-list.ts       → Validate mounts against host-side allowlist
├── ipc-watcher.ts      → Poll IPC output dir for container commands
├── ipc-commands.ts     → Handle refresh_bot, stop_bot, start_bot, rebuild_image, git_push, etc.
├── brain-management.ts → Runtime model switching
├── chat-activity.ts    → Track activity per room for idle detection
├── message-filtering.ts→ Dedup, echo prevention, ignore rules
├── conversation-log.ts → Append conversation to disk logs
├── skill-sync.ts       → Copy persona skills into container session
├── mcp-sync.ts         → Sync MCP server config (persona → session)
├── operator-commands.ts→ !allow, !deny, !todo, !roster, !operator system commands
├── s3-sync.ts          → S3 backup/restore for cross-machine moves
├── podman-bootstrap.ts → Ensure podman machine is running
├── status.ts           → Bot status reporting
├── status-cli.ts       → Status display for CLI
└── formatting.ts       → Message formatting helpers
```

## Key flows

**Start:** `cli.ts` → `service.ts:startAll()` → for each bot in fleet.json: `deployBot()` → rsync nanoclaw, write crew status, start via pm2. After all bots start, also starts the relay process.

**Message:** Matrix event → `main.ts` message loop → `processGroupMessages()` → `container-spawn.ts:runContainerAgent()` → podman container runs agent-runner → output markers parsed → sent to Matrix.

**Interrupt:** Main container busy >30s + new message → `spawnInterruptLobe()` → parallel Sonnet container, fire-and-forget.
