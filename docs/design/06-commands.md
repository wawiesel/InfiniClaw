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

- **InfiniClaw repo**: Pull on interval (`GIT_SYNC_INTERVAL`), rebuild on new commits, redeploy all dist files to bot instances and restart them.
- **Secrets repo**: Pull on interval (`SECRETS_SYNC_INTERVAL`). On new commits, check for transport materializations (bots assigned to this ship but inactive → activate and start).
- **Health**: Run `health-check.sh` on interval (`HEALTH_INTERVAL`), upload to S3.

See `src/relay.ts` for defaults.

### Speaker election

Every relay publishes its InfiniClaw HEAD commit epoch to S3 (`relay/<ship>.json`) at startup and after rebuilds. The **speaker** is the active ship running the newest code; ties are broken by ship rank (lowest wins). This ensures the most up-to-date relay formats aggregate responses.

Speaker election runs before any aggregate command (`!fleet`, `!health`). Non-speakers silently return.

### Fleet command protocol

`!fleet` uses a two-phase S3 protocol so the speaker can assemble data from all ships:

1. **Every ship** publishes its local fleet data to `fleet-report/<ship>.json` — relay version, per-bot status (including live process checks), names, and git versions.
2. **The speaker** polls S3 for up to 5s, waiting for all active ships to report. Reports older than 10s are ignored (stale from a previous invocation).
3. **Assembly**: The speaker merges all ship reports with its in-memory `liveFleet` as fallback for any ship that didn't report in time, then emits a single formatted response.

This guarantees exactly one reply per `!fleet` command, with live process data from every reachable ship.

## Status Line Format

All relay status output uses a standard form:

```
<emoji> <what> (<ship>) <status> (<timestamp> · <elapsed>)
```

When elapsed is zero (e.g. initial message), only the timestamp is shown.

Examples:

```
⚓ refit (Poseidon) starting (10:07)
✅ refit (Poseidon) complete (10:08 · 1m)
⚠️ secrets sync (HERACLES) down (14:30)
✅ secrets sync (HERACLES) operational (16:55 · 2.5h)
```

Implemented by `statusLine()` in `src/relay.ts`.

## Version String Format

Version info follows a standard form:

```
· <sha> <relation to upstream> (<age>)
```

- **sha** — the short commit hash of what's deployed or checked out
- **relation to upstream** — how the local state relates to the upstream ref:
  - `↑0` — in sync with upstream
  - `↑N` — N commits ahead of upstream (unpushed)
  - `↓N` — N commits behind upstream (outdated)
  - `↑N↓M` — diverged (ahead and behind)
- **age** — how long ago the artifact was built (dist files) or the commit was made (repos)

"Upstream" means different things depending on context:
- **Repos** (secrets, code): compared to `origin/main`
- **Dist files** (relay, bots): compared to current HEAD (how outdated is the deployed artifact?)

Examples:

```
· 2a9cc64 ↑0 (0s)      ← just built, matches HEAD
· f25432f ↓3 (45m)      ← deployed 45m ago, 3 commits behind HEAD
· f814482 ↑1 (2m)       ← repo has 1 unpushed commit
```

Implemented by `gitVersionStr()`, `repoVersion()`, `relayVersion()`, `botVersion()` in `src/relay.ts`.

## Status Threads

Multi-step operations and failure alerts use Matrix threads to keep the main timeline clean.

### Refit threads

`!refit` creates one thread per ship. The thread root appears on the main timeline. Each step posts as a numbered thread reply (`[1/N]`, `[2/N]`, ...). The final status (✅ complete or ⛔ failed) posts to both the thread and the main timeline.

```
Main:   ⚓ refit (Poseidon) starting (10:07)
Thread: [1/7 2s]  ✅ secrets up to date · a1b2c3d ↑0 (3h)
        [2/7 5s]  ✅ code pulled 3 commit(s) · 82bfd78 ↑0 (20m)
        [3/7 12s] ✅ build · 82bfd78 ↑0 (12s)
        [4/7 25s] ✅ max deployed · 82bfd78 ↑0 (25s)
        [5/7 38s] ✅ parker restarted · 82bfd78 ↑0 (38s)
        [6/7 48s] ⛔ nora restart failed
        [7/7 50s] ✅ refit (Poseidon) complete (10:08 · 50s)
Main:   ✅ refit (Poseidon) complete (10:08 · 50s)
```

Two different times are shown:
- **Stage prefix** `[N/total elapsed]` — time since refit started (refit progress)
- **Version suffix** `· sha ↑0|↓N (age)` — age of the deployed code (commit freshness)

Repo versions (secrets, code) reflect when the last commit was made. Bot/relay versions reflect when the dist file was built — right after `npm run build`, so age ≈ refit elapsed.

Every step uses ✅ on success, ⛔ on failure, ⚠️ on partial (e.g. sync failed but refit continues). All bots on the ship get deployed (container image rebuild + instance sync). Active bots are also restarted. The final status line posts to both the thread and the main timeline.

### Failure alert threads

Sync failures (secrets, code, build) create a thread in engineering on first occurrence. Updates post in the thread on an exponential backoff schedule: 1m → 2m → 4m → ... → 8h max. Recovery posts to both the thread and the main timeline.

```
Main:   ⚠️ secrets sync (HERACLES) down (14:30)
Thread: <error detail>
        ⚠️ secrets sync (HERACLES) down (14:31 · 1m)
        ⚠️ secrets sync (HERACLES) down (14:33 · 3m)
        ⚠️ secrets sync (HERACLES) down (14:37 · 7m)
        ...
        ✅ secrets sync (HERACLES) operational (16:55 · 2.5h)
Main:   ✅ secrets sync (HERACLES) operational (16:55 · 2.5h)
```

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
