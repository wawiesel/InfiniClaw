# NEXT — InfiniClaw Planned Work

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

### Architecture Design (Albert fills this in)

_Albert: document your research findings and architecture decisions here as you work._

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
