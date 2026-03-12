# src/ — InfiniClaw Host Process

The orchestrator that runs on the host machine (not in containers). Manages bot lifecycle, Matrix communication, and container spawning.

Architecture and behavior are specified in `docs/design/` — this README documents the implementation that realizes those specs.

| Design doc | Implementation area |
|------------|-------------------|
| [00-overview](../docs/design/00-overview.md) | Core principles, code structure |
| [02-matrix](../docs/design/02-matrix.md) | `channels/matrix.ts`, `matrix-api.ts`, `intercom-relay.ts` |
| [03-container](../docs/design/03-container.md) | `container-spawn.ts`, `container-mounts.ts`, `container-secrets.ts`, `run-container.ts` |
| [04-ship](../docs/design/04-ship.md) | `ship-config.ts`, `relay.ts`, `s3-sync.ts` |
| [05-bot](../docs/design/05-bot.md) | `main.ts`, `infini-config.ts`, `message-filtering.ts` |
| [06-brain](../docs/design/06-brain.md) | `brain-management.ts`, `container-spawn.ts` |
| [07-ipc](../docs/design/07-ipc.md) | `ipc-watcher.ts`, `ipc-commands.ts` |
| [08-threading](../docs/design/08-threading.md) | `relay.ts` (branch brains); lobes not yet implemented |

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
├── matrix-api.ts       → Shared fetch-based Matrix operations (login, send, sendReaction, sync, invite, join, leave, setDisplayName, setRoomName)
├── relay.ts            → Supervisor relay: Matrix watcher (duty rooms + quarters + BehindTheCurtain), bot lifecycle, room transitions, help account. `resolveBots(target, conn)` finds bots in a room by quartersRoom or ROLE_ROOMS duty room. X-commands in curtainLoop are allowed (not filtered as own messages). `ensureShipSpaceNames()` sets the ship's Matrix space name to "emoji shipName" on startup. Wires metrics: `initMetrics()` on startup, `recordOperatorMessage()` from curtainLoop, `backfillOperatorEvents()` from Matrix history, `metricsLoop()` publishes to S3 every 5min, `!metrics` handler with context-aware scope resolution. `ROOM_EMOJI` derives duty room entries from `ROLE_ROOMS` (ship-config.ts). `ROLE_ICONS` derived from `ROLE_ROOMS`. `replyTag()` shows ⭐/🟢/💤 pip via `isSpeakerCached`. Fleet display: pip before name, 🏅rank, role icon from ROLE_ICONS, column-aligned names/roles via nbsp padding, `[name](url)` links to quarters/space rooms. All x-commands thread output. Sync tokens persisted to `_runtime/data/sync-token-*.txt` so restart windows replay missed commands. `electSpeaker()` called eagerly on startup to warm `isSpeakerCached` before first command arrives. Command dispatch is fire-and-forget (non-blocking sync loop).
├── main.ts             → Message loop, indicators, reaction acks (👀/🔔), container lifecycle
├── container-spawn.ts  → Container orchestration: secrets, mounts, podman args, stale cleanup, IPC setup
├── container-mounts.ts → Volume mount assembly (ro home + rw workspace)
├── container-secrets.ts→ Normalize provider secrets for containers
├── run-container.ts    → Container run loop (extracted from NanoClaw for composability)
├── channels/
│   └── matrix.ts       → Matrix SDK: connect, send, edit, react, sync, mention pills
├── infini-config.ts    → InfiniClaw-specific env config (removed from upstream)
├── ship-config.ts      → Fleet/ship config, shared constants. `ROLE_ROOMS` is the single source of truth for role→duty room→icon (navigator/engineer/architect/normie). `shipTag()` returns emoji+pip+name (🦁🟢 Herc) with auto-derived or caller-supplied status pip. `findShipByHostname()` resolves hostname→ship entry.
├── allow-list.ts       → Validate mounts against host-side allowlist (~/.config/infiniclaw/allow-list.json)
├── ipc-watcher.ts      → Poll IPC output dir for container commands
├── ipc-commands.ts     → Handle refresh_bot, stop_bot, send_reaction, rebuild_image, git_push, etc.
├── brain-management.ts → Runtime model switching, mainSender() uses capitalizeName for provider display
├── chat-activity.ts    → Track activity per room for idle detection
├── message-filtering.ts→ Dedup, echo prevention, ignore rules (📞 pill, @ callout, system accounts)
├── intercom-relay.ts   → Cross-room messaging via per-room intercom Matrix accounts
├── conversation-log.ts → Append conversation to disk logs
├── skill-sync.ts       → Copy persona skills into container session
├── mcp-sync.ts         → Sync MCP server config (persona → session)
├── metrics.ts          → Fleet metrics: operator interventions, bot scores, ship uptime, fleet availability. Publishes to S3. Back-fills from Matrix history on startup. `formatBotMetrics` capitalizes bot name; `formatShipMetrics` resolves emoji+name from `m.name` (ship key, e.g. 'Herc') via `safeLoadShips()`.
├── command-registry.ts → Single source of truth for x-command names (includes context-aware !metrics)
├── s3-sync.ts          → S3 backup/restore for cross-machine moves
├── podman-bootstrap.ts → Image availability checks, orphan cleanup, delegates recovery to podman-utils
├── history-export.ts   → Periodic S3 export of conversation history (JSONL by date)
├── status.ts           → Bot status reporting
├── status-cli.ts       → Status display for CLI and MCP server
├── todo.ts             → Read Claude Code task state from session files
├── formatting.ts       → Message formatting helpers: capitalizeName, escapeHtml, statusMessage, formatBotDisplayName
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
- **`resolveBots`**: Finds bots on this ship — first by room membership, then (for explicit targets) by fleet assignment. Sleeping bots have no room but can still be targeted by name for `!wake`.
- **Speaker**: `await electSpeaker()` returns true for only one machine per Engineering room. That relay handles all aggregate commands (`!fleet`, `!metrics`, `!health`, `!todo`, help text). All call sites now await the async election — the old `isSpeaker()` sync wrapper (which returned a stale cached value, causing all ships to respond on relay startup) was removed.
- **`!todo`**: Reads most-recently-modified `.claude/todos/*.json` from `_runtime/instances/{bot}/data/sessions/main/` to show actual todo items (since `ca16ce9`).
- **`operator-commands.ts` removed**: X-commands (`!allow`, `!deny`, `!todo`, `!roster`, etc.) were folded into `relay.ts`. `command-registry.ts` is now the single source of truth for all x-command names.
- **`command-registry.ts` security hardening**: `dispatch()` rejects cmd strings longer than 512 chars (DoS guard); `registerHandler()` sanitizes the `name` parameter in error messages (log injection); `dispatch()` emits a console.warn when a matched command has no registered handler (silent no-op guard).
- **`machine-config.ts` removed**: Split into `infini-config.ts` (env-based config) and `ship-config.ts` (fleet.json loader).
- **`get_message` tool**: Fixed shell interpolation bug — event IDs start with `$` which was expanded by `/bin/sh`. Uses `execFileSync('node', ['-e', script])` (no shell) in `bots/container/agent-runner/src/tools.ts`. The `external/nanoclaw/dist/` version is not used for container builds.
- **`resolveReplyThread`**: Scans messages in reverse for `thread_id` from non-bot senders. Returns `workThreadIds` override if set. Cleared after each response turn.
- **`storeOutgoing`**: Must set `is_bot_message: true` — otherwise outgoing messages are re-detected as new human messages by `getNewMessages`, causing echo loops in quarters rooms.
- **Turn timeout kill**: Must use `podman stop` (not `proc.kill('SIGTERM')`) — podman does not relay SIGTERM to the container process. Without this, containers survive the kill and run for minutes/hours.
- **`killStaleContainers` on wake**: `!wake` calls `killStaleContainers(bot)` before `bootstrapBot`. Ensures no orphaned podman containers on restart.
- **Branch brain GitHub auth**: `GH_TOKEN` injected from `secrets/operator/github-bot.json` so PR reviews appear as the fleet bot account, not the host user.
- **Branch brain limit**: `MAX_BRANCH_BRAINS_PER_BOT` (default 3) caps concurrent branch brains per bot. Rejection posts a warning into the triggering Matrix thread so the bot knows to wait.
- **Error strings**: Always use `errStr(err)` from `utils.ts` instead of inline `err instanceof Error ? err.message : String(err)`. Imported in all source files (including `service.ts`, `matrix-api.ts`, `s3-sync.ts`).
- **Regex escaping**: Use `escapeRegex(s)` from `utils.ts` instead of inline `/[.*+?^${}()|[\]\\]/g` patterns.
- **Env var integers**: Use `envInt(name, default)` from `utils.ts` instead of `parseInt(process.env.VAR || 'X', 10)`.
- **Bot name capitalization**: Use `capitalizeName(name)` from `formatting.ts` — single source of truth. Never inline `charAt(0).toUpperCase() + slice(1)`. All `ASSISTANT_NAME || botId` fallbacks must use `capitalizeName(botId)`.
- **Bot display names**: Use `formatBotDisplayName(bot, pip)` from `formatting.ts` — single source of truth for the `pip Name shipEmoji` format. Both `relay.ts:setBotPip` and `main.ts:botDisplayName` use it.
- **Ship commissioned flag**: `isShipCommissioned()` from `ship-config.ts` checks the ship-level `commissioned` boolean (distinct from per-bot `status`). Renamed from `active`/`isShipActive()` for consistency with `!commission`/`!decommission` commands. Guards both relay startup bootstrap and `!pull` bot restart phase — decommissioned ships sync code but never start bots.
- **Ship names in user-visible output**: Use `shipTag()` or `thisShipName()` from `ship-config.ts`, never raw `os.hostname()`. S3 keys for fleet reports also use ship names.
- **Display name sync**: `syncBotDisplayNames()` runs on relay startup to ensure ALL bots (including sleeping) have current format.
- **Room naming**: `ensureRoomNames()` sets double-emoji names on startup: fleet rooms get `🌌<room> Name` (e.g. `🌌⚙️ Engineering`), ship-local rooms/spaces get `<ship><room> Name` (e.g. `🦁🏠 Quarters`, `🦁🏠 Cid's Room`), BehindTheCurtain gets `🌑🎭 BehindTheCurtain`.
- **Lifecycle messages**: Body uses `📡 <action>` prefix on all lifecycle and status replies (no shipTag — loudspeaker `[tag]` provides context). Wake/pull use numbered thread steps `[N/total time]`. Error messages: `⛔ <action> failed — <error>`; hard failures (podman not ready, ship decommissioned) use `⛔ <condition> — <hint>`. Usage/validation (unknown bot/ship, bad syntax) goes through `helpReply()` not loudspeaker. Bot names use `capitalizeName()` in all replies. `threadReply()` omits `[shipTag]` — thread root already identifies the ship; only main timeline messages get the tag.
- **"No bots here" noise**: `handleLifecycleCommand` only announces "No bots here" in fleet rooms (not quarters) and only if speaker. Prevents noise from non-owning ships in bot quarters rooms.
- **`@loudspeaker:` broadcast**: On-duty bots (non-captain, non-operator) can send `@loudspeaker: <text>` in any duty room. Relay broadcasts to all other duty rooms prefixed `BotName (sourceRoom):`. Plain `@loudspeaker` (no colon) triggers `!fleet` in the requesting room. Both patterns detected before the `!` command check in the intercom room sync loop.
- **Ship-targeted commands**: `!push`, `!pull`, `!decommission`, `!commission`, `!operator on/off` accept optional `[ship]` — omit to target all ships.
- **`!wake` dual-purpose**: Wakes sleeping bots or restarts already-awake bots (preserving current status). Uses `restarting`/`restarted` verbs when bot is already running.
- **Room name idempotency**: `ensureRoomNames` checks current name before setting — avoids spam of `m.room.name` state events on relay restarts.
- **BehindTheCurtain mirror**: All non-thread `reply()` messages are mirrored to BehindTheCurtain so the Captain sees command results regardless of which room they originated from. Thread steps are not mirrored to avoid noise.
- **Status reactions pipeline**: 📡 (relay received, `relayAck` in relay.ts) → 👀 (delivered to bot context, main.ts) → 🔔 (triggered response, main.ts). 📡 fires in both curtainLoop and dialtone for Captain messages, deduped per event ID so only one reaction per ship. `matrixSendReaction` in matrix-api.ts is the shared primitive.
- **Command deduplication**: `markProcessed(eventId)` prevents the same `!` command from being handled by both curtainLoop (operator account) and dialtone (intercom accounts). Both loops see events in shared rooms (e.g. Engineering); without dedup, commands execute twice producing duplicate output.
- **Branch Brain terminology**: All variable names, function names, comments, and user-visible strings use "Branch Brain" (not "Thread Brain"). `spawnBranchBrain()`, `branchBrainRestartTimers`, `MAX_BRANCH_BRAINS_PER_BOT`. User-visible announcement: `🧵 Branch Brain: <title>` (announced on main timeline before spawning).
- **Fleet autonomy score**: Composite metric in `FleetMetrics`: `100 − (interventions × 10) − (crashes × 5)`, clamped to [0, 100]. Uses 1d and 7d rolling windows. Computed from existing operator intervention and pm2 restart data.
- **Branch brain success tracking**: `recordBranchBrainResult(bot, success)` called from relay on branch brain exit. Success = posted at least one message. Rate shown as percentage (0–100%) per bot, -1 when no data. `formatBotMetrics` only shows the line when data exists.
- **Git identity in containers**: `container-spawn.ts` uses `capitalizeName()` for `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` — never inline `charAt(0).toUpperCase() + slice(1)`.
- **Room-scoped commands**: `resolveBots(target, conn, scope)` — `scope='present'` matches bots physically IN the room (onduty in duty rooms, quarters/sleep in quarters rooms). `!report` uses `'assigned'` (finds bots to bring in). BTC always uses `'assigned'` (universal command room). Explicit targets not present get `📡 Name not in this room` warning. `buildBotRoomMap()` derives bot→room from fleet.json role via `ROLE_ROOMS` (no more MAIN_GROUP_NAME env var).
- **`!rejoin`/`!refresh` removed**: Both were redundant — `!wake` covers restart-in-place (stop+kill+bootstrap); `!dismiss`+`!report` covers cycle-through-quarters.
- **`!go` threading**: Creates thread root on first reply, adds bot result steps to thread — consistent with other lifecycle commands.
- **`activeBrainModel`**: Written to `fleet.json` by `applyBrainMode()` in `ipc-commands.ts` whenever `set_brain_mode` IPC command fires. Also typed in `BotEntry` interface in `ship-config.ts`.
- **`crew-status.json`**: Written by `writeCrewStatus(root, bot)` in `relay.ts` after every `bootstrapBot`/`restartBotForRoom` call. Lands at `_runtime/instances/{bot}/data/crew-status.json`. Read by the `crew_roster` MCP tool in the container. Includes all fleet bots with role/rank/room/present/isCommandingOfficer; CO = lowest rank per room among present bots.
