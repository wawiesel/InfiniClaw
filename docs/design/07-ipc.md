# 07 — IPC

Container ↔ host communication. Containers write JSON files to their IPC directory, and the host polls these directories to process commands and messages.

## Directory Structure

Each room gets its own IPC namespace under `_runtime/data/ipc/{group}/`:

```
_runtime/data/ipc/{group}/
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

Commands written by the container to `tasks/*.json`:

| IPC Type | Effect |
|----------|--------|
| `refresh_bot` | Wake self or another bot |
| `stop_bot` | Sleep another bot |
| `rebuild_image` | Rebuild container image |
| `health_check` | Run health check and return results |
| `fleet_status` | Return fleet.json status |
| `git_pull` | Pull InfiniClaw, rebuild, deploy to instances |
| `git_push` | Push InfiniClaw repo (via relay-tasks, requires host git credentials) |
| `bot_status` | Get pm2 + error log status |
| `send_to_room` | Send message to another room |
| `send_reaction` | React to a message with an emoji |
| `set_thread` | Set active reply thread for subsequent messages |
| `set_brain_mode` | Switch LLM model at runtime |
| `branch_to_thread` | Request branch brain spawn (written to relay-tasks) |

## Per-Room Namespaces

Each room gets its own IPC directory. This prevents cross-room privilege escalation — a bot in one room cannot inject commands for another room's namespace.

## Main Room Elevation

Only the main room's containers can run privileged IPC commands (`refresh_bot`, `rebuild_image`, `git_push`). Other rooms are restricted to task scheduling and thread management.

## Processing

The host's `ipc-watcher.ts` polls IPC directories every ~100ms. Files are processed atomically:

1. Rename `*.json` → `*.processing`
2. Parse and execute the command
3. Delete the `.processing` file on success

This prevents double-processing on rapid polls.

## Cooldowns

IPC commands have per-command cooldowns to prevent bots from spamming expensive operations. 60-second cooldown between wakes of the same bot prevents bots from burning context in rapid wake cycles.

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
