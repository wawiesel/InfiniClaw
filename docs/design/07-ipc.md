# 07 — IPC

Container ↔ host communication. Containers write JSON files to their IPC directory, and the host polls these directories to process commands and messages.

## Directory Structure

Each room gets its own IPC namespace under `_runtime/instances/{bot}/data/ipc/{group}/`:

```
_runtime/instances/{bot}/data/ipc/{group}/
  messages/     ← container writes outgoing messages (text, image, file)
  tasks/        ← container writes IPC commands (restart, react, set_thread, etc.)
  input/        ← host writes incoming messages and lobe results for container
```

Additionally, `_runtime/relay-tasks/` holds host-side operations (branch brain spawns, git pushes) that require host credentials.

## Message Types

Messages written by the container to `messages/*.json`:

| Type | Purpose |
|------|---------|
| `message` | Text message — routed to main timeline or active thread |
| `image` | Image with base64 payload (max 14MB) |
| `file` | File attachment with base64 payload |

## IPC Commands

Commands written by the container to `tasks/*.json`. Statuses: ✅ implemented, 🔲 not yet implemented, 🗑 to be removed (nanoclaw-specific).

| IPC Type | Effect | Status |
|----------|--------|--------|
| `refresh_bot` | Wake self or another bot | ✅ |
| `stop_bot` | Sleep another bot | ✅ |
| `rebuild_image` | Rebuild container image (5m cooldown) | ✅ |
| `health_check` | Run health check and return results | ✅ |
| `fleet_status` | Return fleet.json status | ✅ |
| `git_pull` | Pull InfiniClaw, rebuild, deploy to instances | ✅ |
| `git_push` | Push InfiniClaw repo (via relay-tasks, requires host git credentials) | ✅ |
| `bot_status` | Get pm2 + error log status | ✅ |
| `send_to_room` | Send message to another room via intercom | ✅ |
| `send_reaction` | React to a message with an emoji | ✅ |
| `set_thread` | Set active reply thread for subsequent messages | ✅ |
| `set_brain_mode` | Switch LLM model at runtime | ✅ |
| `restart_relay` | Restart the relay process | ✅ |
| `request_verification` | Request a verification challenge | ✅ |
| `submit_verification` | Submit verification response | ✅ |
| `holodeck_create` | Create a holodeck sandbox environment | ✅ |
| `holodeck_teardown` | Tear down a holodeck environment | ✅ |
| `holodeck_promote` | Promote holodeck changes to main workspace | ✅ |
| `holodeck_send` | Send a message to a holodeck session | ✅ |
| `holodeck_read` | Read holodeck session output | ✅ |
| `holodeck_status` | Get holodeck session status | ✅ |
| `schedule_task` | Schedule a recurring/one-off agent task | 🗑 nanoclaw-specific — relay heartbeat + WBS handles scheduling in InfiniClaw |
| `list_tasks` | List scheduled tasks | 🗑 nanoclaw-specific |
| `pause_task` | Pause a scheduled task | 🗑 nanoclaw-specific |
| `resume_task` | Resume a scheduled task | 🗑 nanoclaw-specific |
| `cancel_task` | Cancel a scheduled task | 🗑 nanoclaw-specific |
| `podman_exec` | Run allowlisted podman commands on host | ✅ |
| `restart_wksm` | Restart the WKS proxy service | 🗑 nanoclaw-specific service name |

Relay-task types written to `_runtime/relay-tasks/*.json` (processed by relay, not ipc-watcher):

| Task Type | Effect |
|-----------|--------|
| `git_push` | Push branches to remote (requires host git credentials) |
| `branch_brain` | Spawn a branch brain in a new thread |
| `wbs_complete` | Signal that a bot completed a WBS item (unblocks dependents) |

## Per-Room Namespaces

Each room gets its own IPC directory. This prevents cross-room privilege escalation — a bot in one room cannot inject commands for another room's namespace.

## Main Room Elevation

Only the main room's containers can run privileged IPC commands (`refresh_bot`, `rebuild_image`, `git_push`). Other rooms are restricted to task scheduling and thread management.

## Processing

The host's `ipc-watcher.ts` polls IPC directories every 1s. Relay-tasks are polled every 2s. Files are processed atomically:

1. Rename `*.json` → `*.processing`
2. Parse and execute the command
3. Delete the `.processing` file on success

This prevents double-processing on rapid polls.

## Cooldowns

IPC commands have per-command cooldowns to prevent bots from spamming expensive operations:

| Command | Cooldown |
|---------|----------|
| `refresh_bot` | 60s |
| `rebuild_image` | 5m |
| `git_push` | 60s |
| `git_pull` | 60s |

## restart_self (refresh_bot) Spec

The `restart_self` MCP tool (IPC type `refresh_bot`) lets a bot restart itself while on duty. It must behave identically to `!wake` for already-running bots: new Claude process, new MCP tools, new brain config, old context preserved. Target: under 1 minute.

**Sequence:**

1. Bot calls `restart_self` → writes `refresh_bot` task to IPC
2. Host validates deploy (`tsc --noEmit`)
3. Host deploys instance (`deployBot`: rsync + npm ci + build)
4. Host rebuilds container image (`rebuildImage`: `bots/build.sh {bot}`)
5. Host posts status line to main room
6. Host exits with `process.exit(0)` — PM2 auto-restarts the process
7. New process starts, spawns container with rebuilt image

**Critical:** The `CONTAINER_IMAGE` env var in `bots/{bot}/env` must match the image built by `build.sh` (`nanoclaw-{bot}:latest`). A mismatch causes the container to use a stale image, silently missing new tools.

## podman_exec Spec

The `podman_exec` MCP tool (IPC type `podman_exec`) lets bots run podman commands on the host from inside their container.

**Allowed subcommands:** `ps`, `images`, `logs`, `inspect`, `run`, `stop`, `rm`, `build`, `exec`, `pull`, `start`.

**Restrictions:** Main group only. 120s timeout. Output truncated to 2000 chars.

## Verification

1. **IPC directory exists** — Container has `/workspace/ipc/{group}/` mounted.
   *Check:* Directory exists and is writable from inside the container.

2. **Message round-trip** — Bot calls `send_message` via MCP tool.
   *Check:* Message appears in Matrix room. Host log shows IPC command processed.

3. **Namespace isolation** — Bot in one room cannot run privileged commands for another room.
   *Check:* Privileged IPC from non-main room is rejected.

4. **Cooldown enforced** — Bot requests two rapid restarts.
   *Check:* Second restart is rejected with cooldown message.

5. **Atomic processing** — Multiple IPC files written in rapid succession.
   *Check:* All files processed exactly once, no duplicates or drops.
