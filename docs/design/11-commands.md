# 11 — X-Commands

The Captain controls the fleet via x-commands (`!`-prefixed) typed in Matrix. Commands are processed by a lightweight **relay** process (one per ship), not by each bot's host process. Each ship's relay only acts on its local bots.

**Targeting:** Untargeted commands affect bots physically in the room — on duty there, or in their own quarters room. Exception: `!report` is assignment-based (finds bots assigned to this room even if currently in quarters). Named targets not present in the room produce a no-op warning (`relay Name not in this room`). BehindTheCurtain is a universal command room — all bots on the ship are reachable regardless of status.

Commands work from any room the operator account has joined — duty rooms (via intercom), BehindTheCurtain, and quarters rooms.

**Help and errors:** `!` (bare) prints the x-command list. Unknown commands get a feedback message. Both are sent via the help account (not loudspeaker) so bots ignore them.

## Command Reference

### Bot Commands

| Command | Effect |
|---------|--------|
| `!todo [bot]` | Show bot's active tasks. No arg = all bots. |
| `!report [bot]` | Send awake bot(s) to duty room. Skips sleeping bots. |
| `!dismiss [bot]` | Remove from duty, back to quarters. |
| `!go [room] [bot]` | Send bot to a non-duty room (e.g. lounge). No args = list rooms. |
| `!wake [bot]` | Start or restart container (sleeping → wake; awake → stop+rebuild+restart). |
| `!sleep [bot]` | Stop container, leave all rooms except quarters. |
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
| `!pull [ship]` | Sync secrets + code, rebuild, restart bots to quarters. No arg = this ship. |
| `!push [ship]` | Push InfiniClaw to origin. No arg = all ships. |

### Fleet Commands

| Command | Effect |
|---------|--------|
| `!fleet` | Fleet status — each ship reports its local bots. |
| `!fleet room` | Bots in this room only. _(not yet implemented — same as `!fleet`)_ |
| `!health` | Fleet health summary from S3 (speaker replies). |
| `!metrics [scope]` | Metrics (1d/7d rolling). Context-aware — see below. |
| `!operator [on|off] [ship]` | Show or toggle operator relay on/off for ship(s). |

## Metrics

`!metrics` is context-aware — the default scope depends on which room the command is sent from:

| Room | Default scope | What it shows |
|------|--------------|---------------|
| Bot quarters | `bot <botname>` | That bot's score, response latency, crashes, branch brain success, timeouts |
| Engineering | `engineering` | Relay uptime, warnings/errors, cumulative time bots running stale code, deploy success |
| Bridge | `fleet` | Fleet availability, autonomy score, transport success, cross-ship sync lag |
| BehindTheCurtain | `all` | Everything — operator, bot, ship, fleet |

Explicit scope overrides the default: `!metrics operator` from any room shows operator metrics.

| Scope | Metrics |
|-------|---------|
| `operator` | Interventions outside BTC, x-commands issued, restart ratio, MTBI |
| `bot [name]` | Score (points/day), response latency, crashes, branch brain success, turn timeout rate, self-healing ratio |
| `ship [name]` | Relay uptime, sync failures, x-command latency, deploy success, speaker stability |
| `engineering` | Relay uptime, warnings/errors per day, cumulative stale-code bot-hours, deploy success |
| `fleet` | Availability, autonomy score, transport success, cross-ship sync lag |
| `all` | All of the above |

All metrics report 1-day and 7-day rolling averages. Data sourced from S3 (`metrics/<ship>.json`).

## Status Line Format

All relay status output uses a standard form:

```
<emoji> <what> (<ship>) <status> (<timestamp> · <elapsed>)
```

When elapsed is zero (e.g. initial message), only the timestamp is shown.

Examples:

```
⚠️ secrets sync (Herc) down (14:30)
✅ secrets sync (Herc) operational (16:55 · 2.5h)
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

### Pull threads

`!pull` creates one thread. The thread root appears on the main timeline (with ship tag via loudspeaker). Each step posts as a numbered thread reply (`[N/total elapsed]`). The final status posts to both the thread and main timeline.

```
Main:   [🔱 Posi] relay pull starting ...
Thread: [1/7 0s]  ✅ secrets up to date · a1b2c3d (3h) ↑0
        [2/7 2s]  ✅ code pulled 3 commit(s) · 82bfd78 (20m) ↑0
        [3/7 12s] ✅ relay + dist rebuilt · 82bfd78 (20m) ↑0
        [4/7 25s] ✅ Max restarted (quarters)
        [5/7 38s] ✅ Parker restarted (quarters)
        [6/7 48s] ⛔ Nora restart
        [7/7 50s] ✅ relay pull complete (0W 1E) 50s
Main:   [🔱 Posi] ✅ relay pull complete (0W 1E) 50s
```

Two different times are shown:
- **Stage prefix** `[N/total elapsed]` — time since pull started
- **Version suffix** `· sha ↑0|↓N (age)` — age of the deployed code (commit freshness)

Every step uses ✅ on success, ⛔ on failure, ⚠️ on warning. All bots on the ship are restarted to quarters. The final status line posts to both the thread and the main timeline.

### Failure alert threads

Sync failures (secrets, code, build) create a thread in engineering on first occurrence. Updates post in the thread on an exponential backoff schedule: 1m → 2m → 4m → ... → 8h max. Recovery posts to both the thread and the main timeline.

```
Main:   ⚠️ secrets sync (Herc) down (14:30)
Thread: <error detail>
        ⚠️ secrets sync (Herc) down (14:31 · 1m)
        ⚠️ secrets sync (Herc) down (14:33 · 3m)
        ⚠️ secrets sync (Herc) down (14:37 · 7m)
        ...
        ✅ secrets sync (Herc) operational (16:55 · 2.5h)
Main:   ✅ secrets sync (Herc) operational (16:55 · 2.5h)
```

## Verification

1. **Command reaches relay** — Send `!fleet` in a duty room.
   *Check:* Relay log shows command received and processed.

2. **Bot command works** — `!dismiss cid` removes bot from duty.
   *Check:* Bot leaves duty room, fleet.json updated to `quarters`, `triggerType` to `always`.

3. **Ship command works** — `!pull heracles` triggers sync + rebuild + restart.
   *Check:* Pull thread appears with numbered steps, all stages complete.

4. **Status line format** — Any relay output follows the standard format.
   *Check:* Output matches `<emoji> <what> (<ship>) <status> (<timestamp> · <elapsed>)`.

5. **Failure thread** — Simulate a sync failure.
   *Check:* Alert thread created, backoff schedule observed, recovery posted to both thread and main timeline.
