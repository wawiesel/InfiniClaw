# 10 — Commands

The Captain controls the fleet via `!` commands typed in Matrix. Commands are processed by a lightweight **relay** process (one per ship), not by each bot's host process. Each ship's relay only acts on its local bots. Untargeted commands (e.g. `!dismiss` with no bot name) are scoped to the room — only bots whose `MAIN_GROUP_NAME` matches the room are affected on each ship.

Commands work from any room the operator account has joined — duty rooms (via intercom), BehindTheCurtain, and quarters rooms.

**Help and errors:** `!` (bare) prints the command list. Unknown commands get a feedback message. Both are sent via the help account (not loudspeaker) so bots ignore them.

## Command Reference

### Bot Commands

| Command | Effect |
|---------|--------|
| `!todo [bot]` | Show bot's active tasks. No arg = all bots. |
| `!report [bot]` | Send awake bot(s) to duty room. Skips sleeping bots. |
| `!dismiss [bot]` | Remove from duty, back to quarters. |
| `!go [room] [bot]` | Send bot to a non-duty room (e.g. lounge). No args = list rooms. |
| `!wake [bot]` | Start container in quarters (full brain). |
| `!sleep [bot]` | Stop container, leave all rooms except quarters. |
| `!rejoin [bot]` | Dismiss + report (full lifecycle reset). |
| `!refresh [bot]` | Rebuild + restart (pick up new code, no brain/room changes). |
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

Implemented by `statusLine()` in the relay module.

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
- **age** — how long ago the commit was made

"Upstream" means different things depending on context:
- **Repos** (secrets, code): compared to `origin/main`
- **Dist files** (relay, bots): compared to current HEAD (how outdated is the deployed artifact?)

Examples:

```
· 2a9cc64 (5m) ↑0      ← committed 5m ago, matches HEAD
· f25432f (2h) ↓3       ← commit is 2h old, 3 commits behind HEAD
· f814482 (10m) ↑1      ← commit is 10m old, 1 unpushed commit
```

Implemented by `gitVersionStr()`, `repoVersion()`, `relayVersion()`, `botVersion()` in the relay module.

## Status Threads

Multi-step operations and failure alerts use Matrix threads to keep the main timeline clean.

### Refit threads

`!refit` creates one thread per ship. The thread root appears on the main timeline. Each step posts as a numbered thread reply (`[1/N]`, `[2/N]`, ...). The final status (✅ complete or ⛔ failed) posts to both the thread and the main timeline.

```
Main:   ⚓ refit (Poseidon) starting (10:07)
Thread: [1/7 2s]  ✅ secrets up to date · a1b2c3d (3h) ↑0
        [2/7 5s]  ✅ code pulled 3 commit(s) · 82bfd78 (20m) ↑0
        [3/7 12s] ✅ relay + dist rebuilt · 82bfd78 (20m) ↑0
        [4/7 25s] ✅ max deployed · 82bfd78 (20m) ↑0
        [5/7 38s] ✅ parker restarted · 82bfd78 (20m) ↑0
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

## Verification

1. **Command reaches relay** — Send `!fleet` in a duty room.
   *Check:* Relay log shows command received and processed.

2. **Bot command works** — `!dismiss cid` removes bot from duty.
   *Check:* Bot leaves duty room, fleet.json updated to `quarters`, `triggerType` to `always`.

3. **Ship command works** — `!refit heracles` triggers full overhaul.
   *Check:* Refit thread appears with numbered steps, all stages complete.

4. **Status line format** — Any relay output follows the standard format.
   *Check:* Output matches `<emoji> <what> (<ship>) <status> (<timestamp> · <elapsed>)`.

5. **Failure thread** — Simulate a sync failure.
   *Check:* Alert thread created, backoff schedule observed, recovery posted to both thread and main timeline.
