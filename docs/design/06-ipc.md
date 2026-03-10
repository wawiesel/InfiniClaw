# 06 — IPC

Container ↔ host communication. Containers write JSON commands to `/workspace/ipc/output/`, and `ipc-watcher.ts` on the host polls the directory and processes them.

## Per-Room Namespaces

Each room gets its own IPC directory (`_runtime/data/ipc/{room}/`). Prevents cross-room privilege escalation.

## Main Room Elevation

Only the main room's containers can run privileged IPC commands (`refresh_bot`, `rebuild_image`, `git_push`). Other rooms are restricted to task scheduling and thread management.

## IPC Commands

Engineers can trigger system operations from inside their containers via IPC:

| IPC Type | Effect |
|----------|--------|
| `refresh_bot` | Restart self or another bot |
| `stop_bot` | Stop another bot |
| `rebuild_image` | Rebuild container image |
| `health_check` | Run health check and return results |
| `fleet_status` | Return fleet.json status |
| `git_pull` | Pull InfiniClaw, rebuild, deploy to instances |
| `git_push` | Push InfiniClaw repo |
| `bot_status` | Get pm2 + error log status |
| `send_to_room` | Send message to another room |
| `send_reaction` | React to a message with an emoji |

## Cooldowns

IPC commands have per-command cooldowns to prevent bots from spamming expensive operations (e.g. rapid restarts).

## Restart Cooldown

60-second cooldown enforced between restarts of the same bot via IPC. Prevents bots from burning context in rapid restart cycles.

## Verification

1. **IPC directory exists** — Container has `/workspace/ipc/output/` mounted.
   *Check:* Directory exists and is writable from inside the container.

2. **Command round-trip** — Bot calls `send_message` via MCP tool.
   *Check:* Message appears in Matrix room. Host log shows IPC command processed.

3. **Namespace isolation** — Bot in Engineering cannot run privileged commands meant for Bridge.
   *Check:* Privileged IPC from non-main room is rejected.

4. **Cooldown enforced** — Bot requests two rapid restarts.
   *Check:* Second restart is rejected with cooldown message.
