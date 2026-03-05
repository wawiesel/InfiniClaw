# 06 — Commands

The Captain controls the fleet via `!` commands typed in Matrix. Commands are processed by a lightweight **supervisor** process (one per machine), not by each bot's host process. Each machine's supervisor only acts on its local bots. Untargeted commands (e.g. `!dismiss` with no bot name) are scoped to the room — only bots whose `MAIN_GROUP_NAME` matches the room are affected on each machine.

## Command Reference

| Command | Effect |
|---------|--------|
| `!todo` | All bots reply with their task list. |
| `!todo <bot>` | Only that bot replies with its task list. |
| `!dismiss` | Fully stop all bots in the room (process manager stop + container cleanup). |
| `!dismiss <bot>` | Fully stop that bot. |
| `!join` | Fully start all bots assigned to the room (deploy + start via process manager). |
| `!join <bot>` | Fully start that bot. |
| `!restart` | Full stop + redeploy + start for all bots in the room. |
| `!restart <bot>` | Full stop + redeploy + start for that bot. |
| `!roster` | Each machine lists its bots. |
| `!operator <text>` | Send text to operator tmux session. Captain/intercom only. |
| `!allow <bot> <path> [minutes]` | Grant temporary rw mount. Captain/intercom only. |
| `!deny <bot> <path>` | Revoke a mount grant. Captain/intercom only. |

## Dismiss and Join

`!dismiss` and `!join` are full lifecycle commands — there is no dormant mode.

- **`!dismiss`**: Stops the bot via the process manager (pm2 stop + delete), kills any running containers, sends intercom "X has left", sets display name to "X 🔴". The bot process does not stay alive.
- **`!join`**: Deploys fresh code, rebuilds the container image if needed, starts the bot via the process manager, sends intercom "X has joined", sets display name to "X 🟢".

## Restart

Full cycle: stop the bot, kill containers, deploy fresh code, rebuild the container image if needed, start the bot via the process manager. Display name briefly shows "X 🔄" during the cycle.

## Supervisor

A lightweight always-on process, one per machine. The supervisor connects to Matrix rooms via intercom accounts (credentials from `operator/intercom.json`) and watches for `!` commands from the Captain or intercom senders. It manages bot lifecycle by calling service functions directly — no shelling out to the CLI.

Each machine's supervisor only handles its local bots (determined by `machine.json`). Untargeted commands are room-scoped: the supervisor matches the room against each bot's `MAIN_GROUP_NAME` to determine which bots are affected.

Started automatically by `npm run cli start` and runs as a managed process alongside bots.
