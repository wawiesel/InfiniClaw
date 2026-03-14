# 07 — IPC

Container ↔ host communication. Containers write JSON files to their IPC directory, and the host polls these directories to process commands and messages.

## Directory Structure

Each room gets its own IPC namespace under `_runtime/instances/{bot}/data/ipc/{group}/`:

```
_runtime/instances/{bot}/data/ipc/{group}/
  messages/           ← container writes outgoing messages (text, image, file)
  tasks/              ← container writes IPC commands (restart, react, set_thread, etc.)
  input/              ← host writes incoming messages and lobe results for container
  status.json         ← host writes current fleet/group status snapshot
  last_event_ids.json ← host writes last processed event ID and active work thread ID
```

Additionally, `_runtime/relay-tasks/` holds host-side operations (branch brain spawns, git pushes) that require host credentials.

## Message Types

Messages written by the container to `messages/*.json`:

| Type | Purpose |
|------|---------|
| `message` | Text message — routed to main timeline or active thread |
| `image` | Image with base64 payload (max 14MB) |
| `file` | File attachment with base64 payload |

### Cross-Room Messages

A `message` payload may include `crossRoom: true` and `senderName: string` to route the message via intercom relay to another room. The relay reformats it as `"{senderName}: {text}"` and delivers it through the intercom connection.

### Delegate Thread Mechanism

When the container sends a `message` payload whose `text` starts with `💭` and no explicit `threadId` is provided, the host creates a new Matrix thread for it and stores its event ID as the **delegate thread ID** for that source group. Subsequent messages from the same group without an explicit `threadId` are automatically routed into this delegate thread. The delegate thread is cleared when `set_thread(null)` is issued.

## IPC Commands

Commands written by the container to `tasks/*.json`:

### Upstream Base Types (processed by nanoclaw core)

| IPC Type | Effect |
|----------|--------|
| `schedule_task` | Schedule a deferred task |
| `pause_task` | Pause a running task |
| `resume_task` | Resume a paused task |
| `cancel_task` | Cancel a scheduled task |
| `refresh_groups` | Trigger re-sync of available groups |
| `register_group` | Register a new room group with the host |

### InfiniClaw Extended Commands

| IPC Type | Privileged (main only) | Effect |
|----------|----------------------|--------|
| `set_brain_mode` | Yes | Switch LLM model at runtime |
| `refresh_bot` | Yes | Wake self or another bot |
| `stop_bot` | Yes | Sleep another bot |
| `rebuild_image` | Yes | Rebuild container image |
| `bot_status` | Yes | Get pm2 + error log status |
| `restart_wksm` | Yes | Restart the workspace manager |
| `restart_relay` | Yes | Restart the relay process |
| `git_pull` | Yes | Pull InfiniClaw, rebuild, deploy to instances |
| `git_push` | Yes | Push InfiniClaw repo (queued to relay-tasks; requires host git credentials) |
| `health_check` | Yes | Run health check and return results |
| `fleet_status` | Yes | Return fleet.json status |
| `send_to_room` | Yes | Send message to another room |
| `request_verification` | Yes | Initiate a verification workflow |
| `submit_verification` | Yes | Submit verification result |
| `holodeck_create` | Yes | Create a holodeck (worktree sandbox) for a bot |
| `holodeck_teardown` | Yes | Tear down a holodeck |
| `holodeck_promote` | Yes | Promote holodeck branch |
| `holodeck_send` | Yes | Send a message into a holodeck session |
| `holodeck_read` | Yes | Read output from a holodeck session |
| `holodeck_status` | Yes | Get holodeck status |
| `set_thread` | No | Set active reply thread for subsequent messages |
| `send_reaction` | No | React to a message with an emoji |

### Special: merge_request

`merge_request` is a task type handled directly in `ipc-watcher.ts` (not routed through `ipc-commands.ts`). It is written by a lobe when it completes work on a thread and wants to signal the main brain to review/merge the output.

| Field | Type | Description |
|-------|------|-------------|
| `thread_id` | string | Matrix thread ID the lobe was working in |
| `bot` | string | Bot name that issued the merge request |
| `summary` | string? | Optional summary of completed work |

### Branch Brain Spawning (via MCP tool, not IPC task)

`branch_to_thread` is an **MCP tool** available to the main brain container — it is **not** written as an IPC task file to the `tasks/` directory. Instead, when the bot calls this MCP tool, the host writes a `branch_brain` task to `_runtime/relay-tasks/`. The relay picks it up and spawns a branch brain subprocess. Required relay-task fields: `thread_id`, `objective`. The relay enforces a per-bot concurrent branch brain limit (`MAX_BRANCH_BRAINS_PER_BOT`).

## Per-Room Namespaces

Each room gets its own IPC directory. This prevents cross-room privilege escalation — a bot in one room cannot inject commands for another room's namespace.

## Main Room Elevation

Only the main room's containers can run privileged IPC commands (see "Privileged" column above). Attempts from non-main rooms are rejected by `requireMain()`. Commands restricted to main include all system-control, rebuild, git, health, verification, and holodeck operations.

## Processing

The host's `ipc-watcher.ts` polls IPC directories at the interval defined by `IPC_POLL_INTERVAL` (from nanoclaw config). Files are processed atomically:

1. Rename `*.json` → `*.processing`
2. Parse and execute the command
3. Delete the `.processing` file on success
4. On error: rename `.processing` → `.error` (preserved for inspection)

Size limits: message payloads max 14MB, task payloads max 64KB.

This prevents double-processing on rapid polls.

## Cooldowns

IPC commands have per-command cooldowns to prevent bots from spamming expensive operations. Cooldowns are enforced in `ipc-commands.ts` using a shared `checkCooldown()` helper. Examples:

- `rebuild_image`: cooldown prevents rapid image rebuilds
- `git_push`: cooldown enforced between pushes
- `refresh_bot`: 60-second cooldown between wakes of the same bot prevents bots from burning context in rapid wake cycles

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

6. **Error preservation** — IPC file that causes a parse/exec error.
   *Check:* File renamed to `.error` and preserved; processing continues for other files.
