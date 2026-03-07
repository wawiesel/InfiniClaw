# 06 — Commands

The Captain controls the fleet via `!` commands typed in Matrix. Commands are processed by a lightweight **relay** process (one per ship), not by each bot's host process. Each ship's relay only acts on its local bots. Untargeted commands (e.g. `!dismiss` with no bot name) are scoped to the room — only bots whose `MAIN_GROUP_NAME` matches the room are affected on each ship.

## Command Reference

### Bot Commands

| Command | Effect |
|---------|--------|
| `!todo` | All bots reply with their task list. |
| `!todo <bot>` | Only that bot replies with its task list. |
| `!dismiss <bot>` | Stop bot, update fleet.json. |
| `!join <bot>` | Start bot, update fleet.json. |
| `!restart <bot>` | Full stop + redeploy + start. |
| `!transport <bot> <ship>` | Beam bot to another ship (dematerialize/materialize). |
| `!promote <target>` | Raise rank (bot within role, or ship). |
| `!demote <target>` | Lower rank (bot within role, or ship). |
| `!allow <bot> <path> [min]` | Grant temporary rw mount. Captain/intercom only. |
| `!deny <bot> <path>` | Revoke a mount grant. Captain/intercom only. |

### Ship Commands

| Command | Effect |
|---------|--------|
| `!commission [ship]` | Commission ship(s), start assigned bots. No arg = all. |
| `!decommission [ship]` | Stop all bots on ship(s), keep relay running. No arg = all. |
| `!provision [target]` | Sync repos. No arg = secrets + infiniclaw. Named targets from paths.json. |
| `!refit [ship]` | Full overhaul: sync, rebuild, restart bots + relay. No arg = all. |

### Fleet Commands

| Command | Effect |
|---------|--------|
| `!fleet` | Fleet status — each ship reports its local bots. |
| `!fleet room` | Bots in this room only. |
| `!health` | Fleet health summary from S3 (speaker replies). |

### Operator Commands

| Command | Effect |
|---------|--------|
| `!relay <text>` | Send text to operator tmux session on each ship. |

## Relay

A lightweight always-on process, one per ship (`src/relay.ts`). The relay connects to Matrix rooms via intercom accounts (credentials from `operator/intercom.json`) and watches for `!` commands from the Captain or intercom senders. It manages bot lifecycle by calling service functions directly.

**The relay runs on every ship, always.** Even decommissioned ships keep their relay running — they just don't start bots. This ensures every ship stays reachable for commands like `!commission`, `!fleet`, and `!health`. Decommissioning (`!decommission`) stops all bots but leaves the relay listening.

When a command arrives (e.g. `!restart cid`), every ship's relay sees it. Each checks if the target bot is local (via fleet.json). Only the owning ship acts — the rest silently ignore. Untargeted commands are room-scoped: the relay matches the room against each bot's `MAIN_GROUP_NAME`.

Started by `npm run cli relay install` and runs as pm2 process `infiniclaw-relay`.

### Auto-sync loops

- **InfiniClaw repo**: Pull every 10 minutes, rebuild on new commits, redeploy all dist files to bot instances and restart them.
- **Secrets repo**: Pull every 30 seconds. On new commits, check for transport materializations (bots assigned to this ship but inactive → activate and start).
- **Health**: Run `health-check.sh` every 30 minutes, upload to S3.

### Speaker election

Ships are ranked in `ships.json`. The lowest-rank **active** ship is the "speaker" — it replies for aggregate commands like `!health` that would otherwise produce duplicate responses from every relay. Per-ship commands (`!fleet`, `!provision`) reply from each ship with its local state.

## IPC Commands (bot → host)

Engineers can trigger system operations from inside their containers via IPC:

| IPC Type | Effect |
|----------|--------|
| `restart_bot` | Restart self or another bot |
| `stop_bot` | Stop another bot |
| `rebuild_image` | Rebuild container image |
| `health_check` | Run health check and return results |
| `fleet_status` | Return fleet.json status |
| `git_pull` | Pull InfiniClaw, rebuild, deploy to instances |
| `git_push` | Push InfiniClaw repo |
| `bot_status` | Get pm2 + error log status |
| `send_to_room` | Send message to another room |
