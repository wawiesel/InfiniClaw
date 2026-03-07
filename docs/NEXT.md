# NEXT — InfiniClaw Planned Work

## Engineering Backlog

These are real problems. Simplify, don't add complexity.

### Bot activity heartbeat

Bots MUST show visible activity in Matrix every N seconds (configurable via `HEARTBEAT_INTERVAL`, default 30s). If there is no user-visible output (message, reaction, edit) within the interval, the host emits a heartbeat status update. This guarantees the Captain can always tell a bot is alive from Matrix alone — no log access required. The heartbeat should show what the bot is doing (thinking, tool call, waiting) not just that it exists.

### Infrastructure redundancy (S3 + Gitea)

Gitea and MinIO are single points of failure. Run a second instance of each on another ship. Gitea: multi-remote push (active-active) — every ship pushes to both origins. MinIO: built-in site replication — bidirectional sync, automatic reconciliation. Update `fleet.json` with fallback endpoints and add try/catch failover to relay and bot S3/git operations. Also: ships should be VMs, not bare metal — a physical machine can host multiple ships, enabling isolation, portability, and ephemeral holodeck ships. See `13-infrastructure-redundancy.md` for full spec.

### Bot quarters (room-based dismiss/join)

Replace `IGNORE_SENDERS` and room-level filtering with physical room separation. Each bot gets a private quarters room (1:1 with Captain). `!dismiss` moves the bot to quarters, `!join` moves it back to the duty room. Dismissed bots don't see duty room messages because they're not in the room — no filtering needed. Remove `IGNORE_SENDERS` logic after implementing. See `14-quarters.md`.

### Status indicator simplification

The `⏳ working...` indicator system (`createIndicatorSet` in `main.ts`) is overbuilt with retry logic, adaptive timers, and bump functions. It should be one simple message that gets edited per Thread Brain. Strip it down. Merge with the heartbeat requirement above.

### No streaming to Matrix

Bots produce nothing visible while thinking, then dump the full response. The agent-runner emits output markers only when Claude calls `send_message`. Matrix supports message editing (`m.replace`), so progressive display is possible — send a placeholder, edit as tokens arrive. This requires streaming raw LLM tokens from the container to the host.

### `restorePersona()` is redundant

Persona directories are now bind-mounted into containers. The `restorePersona()` function in `service.ts` that copies persona content into the instance is legacy. Remove it. Deploy flow should be: rsync nanoclaw → write crew status → start launchd.

### `syncPersona()` is fragile

With direct bind mounts, bot edits already persist to the repo. The sync-back step on stop is a no-op for mounted paths and a bug source for everything else. Remove it.

### Navigator thread-to-topic mapping

Auto-threading is implemented (1c30fdd) but navigators still need to manage thread-to-topic mapping in their memory so they return to the right thread for ongoing work.

### Scheduled task mount error

Scheduled tasks fail with `statfs .../container/agent-runner/src: no such file or directory`. The agent-runner source mount path is only valid during development. Scheduled task containers need the same mount resolution as regular containers.

### Rate limit visibility

Matrix SDK initial sync causes 429s distinct from outbound message rate limits. The existing alerting only tracks outbound sends. Initial sync rate limits are silent. Log initial sync duration.

---

## Priority 0: Full Bot Autonomy

**Goal:** Bots handle 100% of routine operations. The Operator is an escape hatch, not a daily tool. The Captain sets direction; bots execute.

**Owner:** Cid (Engineer) + Parker (Engineer)

### What's Done

- [x] **IPC task system** — Bots can trigger host-side actions: `restart_bot`, `rebuild_image`, `git_push`, `restart_wksm`, `send_to_room`
- [x] **MCP preflight** — Agent-runner validates all remote MCP servers at startup (5s timeout), drops unreachable ones, bot starts anyway
- [x] **MCP failure reporting** — Dropped MCP servers are automatically reported to Engineering via `send_to_room` IPC
- [x] **Session recovery** — Agent-runner recovers most recent session when host loses sessionId, preventing context loss on restart
- [x] **Self-restart** — Bots can restart themselves and other bots via IPC
- [x] **Self-rebuild** — Engineers can trigger image rebuilds via `rebuild_image` IPC
- [x] **Persona editing** — Bots can edit their own CLAUDE.md, skills, and MCP config via writable mounts
- [x] **Transporter skill** — Engineers can move bots between machines via S3 sync + Matrix coordination

### What's Next

- [ ] **MCP self-healing loop** — When a bot's MCP fails preflight, the engineer on that machine should automatically diagnose (check proxy status, network, config) and fix it without human intervention. Currently engineers get the report; they need standing orders to act on it.
- [ ] **Health metrics collection** — Parker's primary mission. Three pillars: responsiveness (message-to-reply latency, container spawn time, lobe round-trip), uptime (bot availability, unplanned restarts, OOM kills, MCP proxy health), and capability (Captain-scored via emoji reactions). Scripts over services — health checks run on schedule, store JSON, post summaries to Engineering. Scripts live in the `fleet-inspection` skill.
- [ ] **Cross-machine health requests** — Engineer on machine A messages engineer on machine B via Matrix requesting health data. Receiving engineer runs diagnostics and replies. No Operator inbox needed.
- [ ] **Automatic OOM response** — When a bot OOMs (exit 137), the engineer detects it in logs, increases `CONTAINER_MEMORY_MB` in the env file, and restarts. Currently manual.
- [ ] **Restart loop detection** — If a bot restarts more than 3 times in 10 minutes, the engineer should halt it and report to the Captain instead of letting it burn tokens.
- [ ] **Reduce Operator to pure escape hatch** — Remove routine operations from Operator CLAUDE.md standing orders. Operator should only activate when: (a) a bot explicitly asks for OS-level help, (b) Matrix is down, (c) Captain manually invokes it.
- [ ] **Pre-compile TypeScript in container images** — Currently `tsc` runs at container build time. Pre-compiling and shipping only JS would reduce image size and startup time.
- [ ] **Error handling and observability** — Structured error types, centralized logging, and metrics collection across the host and agent-runner.
- [ ] **Profile env encryption** — Encrypt bot env files at rest in the secrets repo. Decrypt at load time via keychain or hardware key.

## Priority 1: Multi-Computer Architecture

**Goal:** Same bots, same conversations, but access to resources/filesystems on multiple machines — work vs home, Mac + Linux.

**Owner:** Albert (Architect). This is his top priority.

### Single-Machine Assumptions

Every subsystem currently assumes co-located resources:

| Category | Assumption | Key Files |
|----------|-----------|-----------|
| Podman | Container runtime on same machine | `container-runner.ts`, `container-spawn.ts` |
| Podman I/O | Child process stdin/stdout pipe | `container-runner.ts` |
| Volume mounts | All `-v` paths are local filesystem | `container-spawn.ts`, `container-mounts.ts` |
| SQLite | Synchronous local file access | `db.ts`, all callers |
| Cross-bot SQLite | Direct open of other bot's `.db` | `service.ts`, `ipc-commands.ts` |
| IPC filesystem | `fs.readdirSync` polling of local dirs | `ipc.ts`, `ipc-watcher.ts` |
| Session files | Local `.jsonl` mounted into containers | `container-spawn.ts`, agent-runner |
| launchd | macOS-only service manager | `service.ts` |
| Deploy | Local `rsync` + `npm ci` + `npm run build` | `service.ts` |
| Allow-list | Local JSON file at `~/.config/infiniclaw/` | `allow-list.ts` |
| Home mount | Real home directory mounted ro into container | `container-mounts.ts` |
| Module state | In-memory maps (sessions, timestamps, threads) | `main.ts` |
| Container images | Must exist in local podman image store | `container-spawn.ts` |

### Design Constraints

- **Simplicity mandate.** No hedging, no backward compatibility shims, no "works both ways" patterns. The multi-computer system replaces the single-computer system — it doesn't layer on top.
- **Same bots, same rooms.** The Matrix conversations, bot identities, and room structure stay identical.
- **Incremental delivery.** Each subsystem can be migrated independently. Don't require a big-bang cutover.
- **Mac + Linux.** Must work on both. launchd is macOS-only — the service layer needs to be OS-agnostic.

### Open Questions for Albert

1. **Podman remote vs SSH tunneling vs node registry?** Podman has built-in remote support (`podman --remote`). Is that sufficient, or do we need a custom node registry that tracks which machines are available?
2. **Volume mount strategy.** Local mounts won't work across machines. Options: NFS/SMB shares, rsync-based sync, SSHFS, or a distributed filesystem. What's the simplest that actually works?
3. **SQLite across machines.** Direct file access breaks. Options: replicate the DB, use a network DB, or proxy reads/writes through a service. Which approach preserves simplicity?
4. **IPC mechanism.** Filesystem polling is local-only. Replace with: message queue (NATS, Redis pub/sub), HTTP API, or Matrix itself as the IPC layer?
5. **Service manager.** launchd → what? systemd on Linux, launchd on Mac — or something cross-platform (supervisord, custom daemon)?
6. **Image distribution.** Container images need to exist on the machine that runs the container. Registry? Build on each machine? Push/pull from a shared store?
7. **Which subsystems migrate first?** What's the dependency order for making each subsystem location-independent?

### Architecture Design

_Research completed 2026-03-02. Findings and recommendations below._

#### Q1: Container Runtime — SSH-wrapped Podman

**Recommendation: `ssh host podman run ...` via the existing `runContainer()` abstraction.**

Podman remote (`podman --remote`) has critical bugs: stdin/stdout piping is broken (#15818), and volume mounts reference server paths only. But the architecture doesn't need Podman's remote protocol — we already spawn `podman` as a child process with `child_process.spawn()`. We can spawn `ssh host podman run -i --rm ...` instead. stdin/stdout piping works natively over SSH.

**Implementation:** Add a `host?: string` field to `RunContainerOpts`. When set, `runContainer()` prefixes the command with `ssh -o StrictHostKeyChecking=accept-new host`. The timeout, output parsing, and sentinel markers all work identically — they operate on the process streams, not the transport.

**Node registry:** Not needed initially. Start with a `machine.json` config that maps bot → host. If we later need dynamic scheduling, add a health-check loop.

#### Q2: Volume Mounts — NFS for Home, Syncthing for State

**Recommendation: Two-tier mount strategy.**

| What | Mechanism | Why |
|------|-----------|-----|
| Home directory (ro) | NFS | Native on Mac+Linux, best LAN performance, reliable |
| Group workspaces (rw) | Local to execution host | Each bot runs on one machine; its workspace is local |
| Persona files (rw) | Syncthing (send-only) | Replicated across machines, ~2s latency is fine |
| IPC directories | Eliminated (see Q4) | Replaced by Matrix-based IPC |

**NFS setup:** Export home directory read-only from each machine. Mount on the other machine at the same path (e.g., `/Users/ww5` on Linux mounts the Mac's home). Use `-o ro,resvport` on macOS client. One-time setup per machine pair.

**SSHFS rejected:** Unreliable under sustained load, hangs on SSH drops. Not acceptable for container mounts.

**SQLite over NFS rejected:** Official SQLite docs warn against it. `fcntl()` locking is unreliable on NFS. Risk of silent corruption.

#### Q3: SQLite — Single-Writer with Litestream Backup

**Recommendation: Keep SQLite as single-writer per bot, add Litestream for disaster recovery.**

Each bot already has its own `messages.db`. Since each bot runs on exactly one machine at a time, there's no concurrent-writer problem. The current architecture is already single-writer.

**Cross-bot DB access** (service.ts `send()` command, IPC task scheduling) currently opens another bot's DB file directly. This breaks across machines. Fix: route cross-bot operations through Matrix (the bots are already in shared rooms) or through a thin HTTP proxy on each machine.

**Litestream:** Runs as a sidecar, continuously streams WAL pages to S3. If a bot moves to a different machine, restore from S3. ~450ms p99 replication latency. Actively maintained, low complexity.

**PostgreSQL rejected:** Operational overhead not justified for our scale (3 bots, <100k messages).

#### Q4: IPC — Matrix as the IPC Layer

**Recommendation: Replace filesystem IPC with Matrix messages.**

The bots already communicate through Matrix rooms. The IPC filesystem (`data/ipc/<group>/messages/*.json` + 500ms polling) duplicates what Matrix already does. Eliminating filesystem IPC removes the biggest single-machine assumption.

**How:** IPC commands (restart_bot, set_brain_mode, holodeck_*, git_push) become Matrix messages with a structured prefix (e.g., `!ipc restart_bot engineer`). The host process on each machine watches its bots' rooms for IPC commands and executes locally. This is already how the `!restart` command works.

**Benefits:**
- No shared filesystem needed for IPC
- Commands automatically cross machine boundaries via Matrix
- Audit trail in Matrix history
- Existing `createIpcPoller()` abstraction can be adapted to poll Matrix instead of filesystem

**What stays local:** The `data/sessions/` and `data/cache/` directories remain local to each bot's execution host. They don't need cross-machine access.

#### Q5: Service Manager — PM2 on Both Platforms

**Recommendation: PM2.**

- Works on macOS and Linux identically
- Already requires Node.js (which InfiniClaw uses)
- `pm2 startup` generates launchd plists on Mac and systemd units on Linux
- Built-in log rotation, monitoring, auto-restart
- Manages non-Node processes too (Podman machine, Syncthing, etc.)
- Replaces the 150+ lines of launchd plist generation in `service.ts`

**Migration:** Replace `refreshPlist()` + `launchctl load` with `pm2 start ecosystem.config.js`. The ecosystem config file replaces the per-bot plist files.

#### Q6: Image Distribution — Build on Each Machine

**Recommendation: Build locally from shared git repo.**

Container images are small (Node.js + agent-runner). Build time is ~30 seconds. The Dockerfile and build context are in the git repo, which is already synced across machines.

**Flow:** `git pull` + `podman build` on each machine. The existing `rebuild_image` IPC command already does this. No registry needed.

**Content-hash check** (`image-hash-<bot>`) already prevents unnecessary rebuilds. This works identically on each machine.

#### Q7: Migration Order

**Dependency-driven order (each step is independently deployable):**

| Phase | Subsystem | Depends On | Effort |
|-------|-----------|-----------|--------|
| 1 | **Service manager** (launchd → PM2) | Nothing | Low — config change only |
| 2 | **IPC** (filesystem → Matrix) | Nothing | Medium — rewrite `ipc-watcher.ts` |
| 3 | **Container runtime** (local → SSH) | Phase 2 (IPC commands routed via Matrix) | Low — add `host` to `runContainer()` |
| 4 | **Volume mounts** (local → NFS + local) | Phase 3 (containers run remotely) | Medium — NFS setup + mount path logic |
| 5 | **Cross-bot DB** (direct → proxied) | Phase 2 (Matrix IPC available) | Low — route through Matrix |
| 6 | **State sync** (manual → Litestream) | Phase 3 (bots on multiple machines) | Low — add Litestream sidecar |
| 7 | **Deploy** (local rsync → remote rsync) | Phase 3 | Low — `ssh host` prefix on deploy commands |

**Phase 1-2 can be done on the current single machine** without breaking anything. They're pure improvements even without multi-machine.

### Architecture Summary

```
┌──────────────────────────────────────────────────────┐
│                    MACHINE A (Mac)                     │
│                                                        │
│  PM2 ──► engineer (podman, local workspace)            │
│       ──► NFS server (exports ~/Users/ww5 ro)          │
│       ──► Litestream (streams engineer.db → S3)        │
│       ──► Syncthing (persona files ↔ Machine B)        │
│                                                        │
│  Matrix ◄──── IPC commands ────► Matrix                │
│                                                        │
└──────────────────────────────────────────────────────┘
                         │ SSH
                         ▼
┌──────────────────────────────────────────────────────┐
│                   MACHINE B (Linux)                    │
│                                                        │
│  PM2 ──► commander (podman, local workspace)           │
│       ──► architect (podman, local workspace)          │
│       ──► NFS client (mounts Mac's home ro)            │
│       ──► Litestream (streams commander.db → S3)       │
│       ──► Syncthing (persona files ↔ Machine A)        │
│                                                        │
└──────────────────────────────────────────────────────┘
```

**Key principle:** Each bot runs on exactly one machine. No shared-nothing clustering. Matrix is the universal transport. Local filesystems stay local. Cross-machine access is via NFS (read-only) or Matrix (commands).

---

## ~~Priority 1: Restart Robustness~~ ✅
- **Done:** `injectResumeMessage()` now reads the bot's todo list via `readTodoItems()` and includes non-completed tasks in the resume message. Bots see their active tasks immediately on restart without rediscovering from conversation context.

## ~~Priority 1: Verify Sync Mechanisms~~ ✅
- **Done:** Verified all sync mechanisms are one-way (persona → container). `syncPersona`/`restorePersona` copy persona files at deploy. Skills are copied to session at spawn. MCP configs are loaded from persona dirs. Cid found `saveMcpServersToPersona` save-back — removed it (deleted from `mcp-sync.ts` and `syncPersona` call site). All sync is now strictly one-way.

## ~~Priority 1: NanoClaw Upgrades~~ ✅
- **Done:** Merged upstream nanoclaw v1.1.3 (da61a7e, 212 commits). Used read-tree + selective restore since upstream force-pushed away the original squash base. Incorporated: group-folder path validation (security), skills engine updates, new skills (slack, gmail, update, qodo), CI improvements, setup module. InfiniClaw patches (lobe system, session rotation, IPC fix, container skills) re-applied on top. Build + all 41 tests pass. (commits 67ecff9, daf2439)
- **Process for next time:** `git fetch upstream && git read-tree --prefix=external/nanoclaw/ -u upstream/main`, commit, then `git checkout <prev-commit> -- <infiniclaw-specific-files>`, fix any API changes, commit.

## ~~Priority 1: Engineer vault access gap~~ ✅
- **Fixed:** Added `"bots": ["commander"]` to the `_vault` allowlist entry and `"bots": ["engineer"]` to the InfiniClaw entry in `~/.config/nanoclaw/mount-allowlist.json`. The `findAllowedRoot` function skips entries when `root.bots` is set and the current bot isn't listed, so the engineer cannot mount `_vault` rw even if someone adds it to the engineer's `container-config.json`.

## ~~Priority 2: InfiniClaw Config System~~ ✅
- **Done:** `~/.config/infiniclaw/` is the sole config directory. `allow-list.ts` reads/writes `allow-list.json` there. No InfiniClaw source references `~/.config/nanoclaw/`. Old `mount-allowlist.json` is stale/unused. Config is organized: runtime config → `~/.config/infiniclaw/`, deployment config → `bots/`, OS services → `~/Library/LaunchAgents/`.

## ~~Priority 2: Restore Holodeck~~ ✅
- **Done:** Reimplemented as CLI subcommands: `holodeck create|chat|teardown|promote`. Creates a git worktree from a feature branch, deploys to a separate instance (`_runtime/instances/{bot}-holodeck/`), runs as its own launchd service in terminal-only mode. Promote merges the branch and redeploys the live bot. No Matrix conflicts — holodeck runs terminal-only by default.

## ~~Priority 2: Albert — The Architect Bot~~ ✅
- **Done:** Added Albert as third bot (Architect role). Lives in Astrometrics room, manages holodeck testing. Has 6 holodeck IPC tools (create, teardown, promote, send, read, status) available to all bots via MCP. Host-side handlers in `ipc-commands.ts` process the commands. Dockerfile, persona, profile, and build.sh all set up. Albert tests code from feature branches in holodeck instances — he doesn't write code.

---

## Completed ✅

- **Restart Loop Prevention** — Added 60-second cooldown between restarts per bot in `ipc-commands.ts`. Prevents context-burning restart loops. (commit d213e31)
- **Todo List Enforcement** — Added 2-minute periodic check in `main.ts` that injects reminders when active bots have empty todo lists or no in_progress items. (commit d213e31)
- **Brain Management** — `set_brain_mode` and `restart_self` now work correctly. `applyBrainEnv` only sets `ANTHROPIC_MODEL` (SDK handles the rest), and `refreshPlist` is called before exit so the respawned process picks up the new env. (commit 99bce68)
- **Thread Management** — `delegate_to_lobe` handles threading atomically. The `thread_id` param was added to all delegate tools. (commit 99bce68)
- **Semantic Versioning** — InfiniClaw is at `v1.0.0`, tagged, `safe` branch tracks it.
- **Branch Strategy** — `safe` and `exp` branches exist locally (pending push to origin).
- **Claude Lobe Delegation** — `delegate_claude` added alongside Codex/Gemini/Ollama. Uses Claude CLI with `--print --output-format stream-json --dangerously-skip-permissions`. Also added to `delegate_to_lobe` atomic tool.
- **Private Homeserver Simplifications** — Removed rate limit retry/backoff (c59b11c). Kept `m.replace` filtering (correct regardless of server) and `NODE_EXTRA_CA_CERTS` mapping (still needed for API proxy). No complex sync filter management — `matrix-bot-sdk` handles sync internally.
- **`cli stop` isolation** — Fixed to only kill the target bot's containers, not all nanoclaw-* containers (26eed38).
- **`cli send` DB injection** — Removed local DB injection; messages go through Matrix only (61c9412).
