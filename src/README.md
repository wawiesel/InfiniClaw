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

## Engineer observations (updated 2026-03-08)

- **Thread routing**: `activeReplyThreadIds[chatJid]` is resolved from incoming `thread_id` before each agent run. Bot's final text response goes there automatically — no `set_thread` needed for same-room replies.
- **Progress throttle**: `PROGRESS_CHAT_COOLDOWN_MS=10s` throttles text on main timeline. Since `ca16ce9`, bypassed when in an active thread so bot reasoning is fully visible.
- **`formatMessages`**: Since `5b94b50`, includes `thread="$id"` attribute on threaded messages so bot can see thread structure in prompt.
- **IPC paths**: `/workspace/ipc/tasks/` → runs inside container (no git credentials). Git push uses `_runtime/relay-tasks/` → picked up by `relayTasksLoop()` in relay.ts and executed on host.
- **Speaker**: `isSpeaker()` returns true for only one machine per Engineering room. That relay handles all `!` commands. `!refit` currently only refits the speaker's local bots — multi-machine refit coordination is a known issue.
- **`!todo`**: Reads most-recently-modified `.claude/todos/*.json` from `_runtime/instances/{bot}/data/sessions/main/` to show actual todo items (since `ca16ce9`).
- **`get_message` tool bug**: Fails on event IDs containing `$` due to shell variable interpolation in the node -e command. Unfixed as of session 8.
- **`resolveReplyThread`**: Scans messages in reverse for `thread_id` from non-bot senders. Returns `workThreadIds` override if set. Cleared after each response turn.
