# src/ — InfiniClaw Host Process

The orchestrator that runs on the host machine (not in containers). Manages bot lifecycle, Matrix communication, and container spawning.

Architecture and behavior are specified in `docs/design/` — this README documents the implementation that realizes those specs.

| Design doc | Implementation area |
|------------|-------------------|
| [00-overview](../docs/design/00-overview.md) | Core principles, code structure |
| [01-matrix](../docs/design/01-matrix.md) | `channels/matrix.ts`, `matrix-api.ts`, `intercom-relay.ts` |
| [02-container](../docs/design/02-container.md) | `container-spawn.ts`, `container-mounts.ts`, `container-secrets.ts`, `run-container.ts` |
| [03-ship](../docs/design/03-ship.md) | `ship-config.ts`, `relay.ts`, `s3-sync.ts` |
| [04-bot](../docs/design/04-bot.md) | `main.ts`, `infini-config.ts`, `message-filtering.ts` |
| [05-brain](../docs/design/05-brain.md) | `brain-management.ts`, `container-spawn.ts` |
| [06-ipc](../docs/design/06-ipc.md) | `ipc-watcher.ts`, `ipc-commands.ts` |
| [07-threading](../docs/design/07-threading.md) | `relay.ts` (Thread Brains), `container-spawn.ts` (lobes) |

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
├── podman-utils.ts     → Single source of truth for podman: recovery, container listing, stop ops
├── router-ext.ts       → formatThreadContext (upstream removed in v1.2.12)
│
│── Orchestrator ─────────────────────────────────────────────
├── cli.ts              → CLI entry point (start/stop/chat/send)
├── service.ts          → Deploy, start, stop bots via pm2; seeds quarters or duty room based on fleet status; restartBotForRoom for lightweight room switches
├── matrix-api.ts       → Shared fetch-based Matrix operations (login, send, sync, invite, join, leave, setDisplayName, setRoomName)
├── relay.ts            → Supervisor relay: Matrix watcher (duty rooms + quarters + BehindTheCurtain), bot lifecycle, room transitions, help account. `resolveBots(target, conn)` finds bots in a room by MAIN_GROUP_NAME or quartersRoom. Operator `!` commands in curtainLoop are allowed (not filtered as own messages). `ensureShipSpaceNames()` sets the ship's Matrix space name to "emoji shipName" on startup.
├── main.ts             → Message loop, indicators, reaction acks (👀/🔔), container lifecycle
├── container-spawn.ts  → Container orchestration: secrets, mounts, podman args, stale cleanup, IPC setup
├── container-mounts.ts → Volume mount assembly (ro home + rw workspace)
├── container-secrets.ts→ Normalize provider secrets for containers
├── run-container.ts    → Container run loop (extracted from NanoClaw for composability)
├── channels/
│   └── matrix.ts       → Matrix SDK: connect, send, edit, react, sync, mention pills
├── infini-config.ts    → InfiniClaw-specific env config (removed from upstream)
├── ship-config.ts      → Fleet/ship config, shared constants. `shipTag()` returns emoji+name for display. `findShipByHostname()` resolves hostname→ship entry.
├── allow-list.ts       → Validate mounts against host-side allowlist (~/.config/infiniclaw/allow-list.json)
├── ipc-watcher.ts      → Poll IPC output dir for container commands
├── ipc-commands.ts     → Handle refresh_bot, stop_bot, send_reaction, rebuild_image, git_push, etc.
├── brain-management.ts → Runtime model switching
├── chat-activity.ts    → Track activity per room for idle detection
├── message-filtering.ts→ Dedup, echo prevention, ignore rules (📞 pill, @ callout, system accounts)
├── intercom-relay.ts   → Cross-room messaging via per-room intercom Matrix accounts
├── conversation-log.ts → Append conversation to disk logs
├── skill-sync.ts       → Copy persona skills into container session
├── mcp-sync.ts         → Sync MCP server config (persona → session)
├── command-registry.ts → Single source of truth for ! command names
├── s3-sync.ts          → S3 backup/restore for cross-machine moves
├── podman-bootstrap.ts → Image availability checks, orphan cleanup, delegates recovery to podman-utils
├── history-export.ts   → Periodic S3 export of conversation history (JSONL by date)
├── status.ts           → Bot status reporting
├── status-cli.ts       → Status display for CLI and MCP server
├── todo.ts             → Read Claude Code task state from session files
├── formatting.ts       → Message formatting helpers: escapeHtml, statusMessage, formatBotDisplayName
├── git-utils.ts        → Shared git helpers: gitOpts(), execErrOutput(), gitSyncRepo() (stash→rebase→pop, conflict hard-reset)
├── utils.ts            → Shared utilities: isRecord, sleep, shellQuote, errStr, envInt, escapeRegex, readJson, writeJson
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

## Engineer observations

- **Thread routing**: `activeReplyThreadIds[chatJid]` is resolved from incoming `thread_id` before each agent run. Bot's final text response goes there automatically — no `set_thread` needed for same-room replies.
- **Progress throttle**: `PROGRESS_CHAT_COOLDOWN_MS=10s` throttles text on main timeline. Since `ca16ce9`, bypassed when in an active thread so bot reasoning is fully visible.
- **`formatMessages`**: Since `5b94b50`, includes `thread="$id"` attribute on threaded messages so bot can see thread structure in prompt.
- **IPC paths**: `/workspace/ipc/tasks/` → runs inside container (no git credentials). Git push uses `_runtime/relay-tasks/` → picked up by `relayTasksLoop()` in relay.ts and executed on host.
- **Speaker**: `isSpeaker()` returns true for only one machine per Engineering room. That relay handles all `!` commands. `!refit` currently only refits the speaker's local bots — multi-machine refit coordination is a known issue.
- **`!todo`**: Reads most-recently-modified `.claude/todos/*.json` from `_runtime/instances/{bot}/data/sessions/main/` to show actual todo items (since `ca16ce9`).
- **`operator-commands.ts` removed**: Operator commands (`!allow`, `!deny`, `!todo`, `!roster`, etc.) were folded into `relay.ts`. `command-registry.ts` is now the single source of truth for all `!` command names.
- **`command-registry.ts` security hardening**: `dispatch()` rejects cmd strings longer than 512 chars (DoS guard); `registerHandler()` sanitizes the `name` parameter in error messages (log injection); `dispatch()` emits a console.warn when a matched command has no registered handler (silent no-op guard).
- **`machine-config.ts` removed**: Split into `infini-config.ts` (env-based config) and `ship-config.ts` (fleet.json loader).
- **`get_message` tool bug**: Fails on event IDs containing `$` due to shell variable interpolation in the node -e command. Unfixed as of session 8.
- **`resolveReplyThread`**: Scans messages in reverse for `thread_id` from non-bot senders. Returns `workThreadIds` override if set. Cleared after each response turn.
- **`storeOutgoing`**: Must set `is_bot_message: true` — otherwise outgoing messages are re-detected as new human messages by `getNewMessages`, causing echo loops in quarters rooms.
- **Turn timeout kill**: Must use `podman stop` (not `proc.kill('SIGTERM')`) — podman does not relay SIGTERM to the container process. Without this, containers survive the kill and run for minutes/hours.
- **Thread Brain GitHub auth**: `GH_TOKEN` injected from `secrets/operator/github-bot.json` so PR reviews appear as the fleet bot account, not the host user.
- **Thread Brain limit**: `MAX_THREAD_BRAINS_PER_BOT` (default 3) caps concurrent Thread Brains per bot. Rejection posts a warning into the triggering Matrix thread so the bot knows to wait.
- **Error strings**: Always use `errStr(err)` from `utils.ts` instead of inline `err instanceof Error ? err.message : String(err)`. Already imported in all source files.
- **Regex escaping**: Use `escapeRegex(s)` from `utils.ts` instead of inline `/[.*+?^${}()|[\]\\]/g` patterns.
- **Env var integers**: Use `envInt(name, default)` from `utils.ts` instead of `parseInt(process.env.VAR || 'X', 10)`.
- **Bot display names**: Use `formatBotDisplayName(bot, pip)` from `formatting.ts` — single source of truth for the `Name pip shipEmoji` format. Both `relay.ts:setBotPip` and `main.ts:botDisplayName` use it.
- **Ship names in user-visible output**: Use `shipTag()` or `thisShipName()` from `ship-config.ts`, never raw `os.hostname()`. S3 keys for fleet reports also use ship names.
- **Display name sync**: `syncBotDisplayNames()` runs on relay startup to ensure ALL bots (including sleeping) have current format.
