# src/ — InfiniClaw Host Process

The orchestrator that runs on the host machine (not in containers). Manages bot lifecycle, Matrix communication, and container spawning.

## Architecture

InfiniClaw wraps NanoClaw (`external/nanoclaw/`) with Matrix-specific logic. Each file here either wraps an upstream module or adds InfiniClaw-specific functionality.

```
Host machine (macOS / Linux)
│
│── NanoClaw extension layer ─────────────────────────────────
├── nanoclaw-ext.d.ts   → Type augmentations (thread_id, Channel methods, ContainerInput fields)
├── nanoclaw-patches.ts → Runtime patches for GroupQueue (getGroupStatus, hooks)
├── db-ext.ts           → Thread-aware DB functions via separate SQLite connection
├── env-utils.ts        → Env file parsing (upstream removed in v1.2.12)
├── composables.ts      → State loading/saving helpers (upstream removed in v1.2.12)
├── podman-utils.ts     → Podman recovery/stop utilities (upstream removed in v1.2.12)
├── router-ext.ts       → formatThreadContext (upstream removed in v1.2.12)
│
│── Orchestrator ─────────────────────────────────────────────
├── cli.ts              → CLI entry point (start/stop/chat/send)
├── service.ts          → Deploy, start, stop bots via pm2
├── relay.ts            → Supervisor relay: Matrix watcher for bot lifecycle and operator commands
├── main.ts             → Message loop, indicators, container lifecycle
├── container-spawn.ts  → Build podman args, inject git identity (@a-gis.org), delegate to upstream runContainer()
├── container-mounts.ts → Volume mount assembly (ro home + rw workspace)
├── container-secrets.ts→ Normalize provider secrets for containers
├── run-container.ts    → Container run loop (extracted from NanoClaw for composability)
├── channels/
│   ├── matrix.ts       → Matrix SDK: connect, send, edit, react, sync
│   └── local-cli.ts    → Terminal channel for `npm run cli chat`
├── infini-config.ts    → InfiniClaw-specific env config (removed from upstream)
├── ship-config.ts      → Load fleet.json, per-ship bot roster and S3 settings
├── allow-list.ts       → Validate mounts against host-side allowlist
├── ipc-watcher.ts      → Poll IPC output dir for container commands
├── ipc-commands.ts     → Handle refresh_bot, stop_bot, start_bot, rebuild_image, git_push, etc.
├── brain-management.ts → Runtime model switching
├── chat-activity.ts    → Track activity per room for idle detection
├── message-filtering.ts→ Dedup, echo prevention, ignore rules
├── intercom-relay.ts   → Cross-room messaging via per-room intercom Matrix accounts
├── conversation-log.ts → Append conversation to disk logs
├── skill-sync.ts       → Copy persona skills into container session
├── mcp-sync.ts         → Sync MCP server config (persona → session)
├── command-registry.ts → Single source of truth for ! command names
├── s3-sync.ts          → S3 backup/restore for cross-machine moves
├── podman-bootstrap.ts → Ensure podman machine is running
├── history-export.ts   → Periodic S3 export of conversation history (JSONL by date)
├── status.ts           → Bot status reporting
├── status-cli.ts       → Status display for CLI and MCP server
├── todo.ts             → Read Claude Code task state from session files
├── formatting.ts       → Message formatting helpers
├── utils.ts            → Shared utilities (isRecord, sleep, shellQuote, errStr)
└── version.ts          → Git version resolution (prefers stamped GIT_VERSION file)
```

## NanoClaw as a library

NanoClaw (`external/nanoclaw/`) tracks [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) upstream. InfiniClaw imports it via npm workspaces (`import { X } from 'nanoclaw/module.js'`).

Where InfiniClaw needs functionality that upstream doesn't provide:
- **Type extensions** — `nanoclaw-ext.d.ts` uses declaration merging to augment upstream interfaces (e.g. `thread_id` on `NewMessage`, Matrix-specific methods on `Channel`)
- **Runtime patches** — `nanoclaw-patches.ts` monkey-patches `GroupQueue` prototype for methods that need access to private state
- **Moved modules** — Functions upstream removed are maintained in InfiniClaw's own `src/` (env-utils, composables, podman-utils, router-ext)
- **DB extensions** — `db-ext.ts` opens a second SQLite connection to the same DB for thread-aware queries that upstream dropped

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
- **`operator-commands.ts` removed**: Operator commands (`!allow`, `!deny`, `!todo`, `!roster`, etc.) were folded into `relay.ts`. `command-registry.ts` is now the single source of truth for all `!` command names.
- **`machine-config.ts` removed**: Split into `infini-config.ts` (env-based config) and `ship-config.ts` (fleet.json loader).
- **`get_message` tool bug**: Fails on event IDs containing `$` due to shell variable interpolation in the node -e command. Unfixed as of session 8.
- **`resolveReplyThread`**: Scans messages in reverse for `thread_id` from non-bot senders. Returns `workThreadIds` override if set. Cleared after each response turn.
