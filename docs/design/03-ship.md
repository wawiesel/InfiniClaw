# 03 — Ships

A ship is a machine running a relay. The relay is the always-on process that connects the ship to the fleet via Matrix, manages bot lifecycle, and syncs repos.

## Ship Registry

Ships are registered in `operator/ships.json` in the secrets repo.

```json
{
  "HERACLES": { "ip": null, "os": "macOS", "user": "ww5", "commissioned": true, "rank": 2 }
}
```

Fields:
- `ip` — IP address (nullable, informational)
- `os` — Operating system identifier
- `user` — Login username (nullable)
- `commissioned` — Whether the ship is commissioned (see `!commission`/`!decommission`)
- `rank` — Speaker election tiebreaker (lower wins)
- `spaceId` — Matrix space for this ship's bots (optional)
- `loungeId` — Lounge room ID (optional)
- `quartersSpaceId` — Quarters space ID (optional)
- `operatorRelay` — Whether `@` messages forward to this ship's operator tmux (optional, default true)

Ships are ranked. The lowest-rank **active** ship is the default tiebreaker for speaker election (see below).

The `commissioned` flag is a **ship-level** override in `ships.json` — distinct from per-bot `status` in `fleet.json`. A decommissioned ship (`commissioned: false`) keeps its relay running but will not wake any bots, regardless of their individual status. This ensures all ships stay reachable — an operator can `!commission` a ship remotely at any time.

## The Relay

A single always-on process per ship. The relay connects to Matrix rooms via intercom accounts (credentials from `operator/intercom.json`) and watches for `!` commands from the Captain or operator. It manages bot lifecycle by calling service functions directly.

**The relay runs on every ship, always.** Even decommissioned ships keep their relay running — they just don't start bots.

When a command arrives (e.g. `!rejoin cid`), every ship's relay sees it. Each checks if the target bot is local (via fleet.json). Only the owning ship acts — the rest silently ignore. Untargeted commands are room-scoped: the relay matches the room against each bot's `MAIN_GROUP_NAME`.

### Matrix Accounts

The relay uses multiple Matrix accounts for different purposes:

| Account | Credential file | Purpose |
|---------|----------------|---------|
| `@operator` | `operator-matrix.json` | Admin (invites, power levels), BehindTheCurtain watch, quarters room `!` commands |
| `@loudspeaker` | `loudspeaker-matrix.json` | Relay command replies (status, lifecycle messages) |
| `@help` | `help-matrix.json` | Help text and unknown command feedback (Captain-only visibility) |
| Per-room intercom | `intercom.json` | Duty room watching (bridge, engineering, astrometrics) |

The operator account watches BehindTheCurtain and all rooms it has joined (including quarters rooms). Captain `!` commands from any of these rooms are processed. The help account keeps help/error responses out of loudspeaker so bots don't see them — bots have all system accounts in `IGNORE_SENDERS`.

All relay command responses are delivered via the loudspeaker account, automatically prefixed with `[<shipEmoji> <shipName>]` (e.g. `[🦁 Herc]`). Message bodies use `relay <action>` prefix — they must NOT repeat the ship name since the loudspeaker tag already provides it.

Non-thread replies are mirrored to BehindTheCurtain so the Captain sees command results regardless of which room they originated from. Thread steps are not mirrored to avoid noise.

Started by `npm run cli relay install` and runs as pm2 process `infiniclaw-relay`.

### Startup Sequence

1. Identify ship via `os.hostname()`
2. Load fleet state from `fleet.json`
3. Resolve Captain and operator user IDs from secrets
4. Load intercom config (per-room Matrix credentials)
5. Connect to Matrix rooms with staggered sync (one per room)
6. Wait for Matrix warmup before bootstrapping bots
7. If ship is active, bootstrap and start all `onduty` bots
8. Launch background loops

### Background Loops

| Loop | Env var | Default | Purpose |
|------|---------|---------|---------|
| InfiniClaw repo sync | `GIT_SYNC_INTERVAL` | 3 min | Pull, rebuild on new commits, redeploy dist, restart bots |
| Secrets repo sync | `SECRETS_SYNC_INTERVAL` | 30s | Pull, detect transport materializations, check inbox |
| Health check | `HEALTH_INTERVAL` | 30 min | Run `health-check.sh`, upload to S3 |
| Heartbeat | — | built-in | Publish relay liveness |
| Relay tasks | — | built-in | Poll `_runtime/relay-tasks/` for host-side operations |
| Curtain | — | built-in | Watch operator-joined rooms (BehindTheCurtain, quarters), process `!` commands, forward Captain messages to operator tmux |

**InfiniClaw sync** detects source changes (TypeScript, package.json, Dockerfiles, tsconfig) and triggers a rebuild → deploy dist → restart bots → restart relay.

**Secrets sync** handles fleet.json conflict resolution (accepts upstream on rebase conflicts). On new commits, checks for transport materializations — bots assigned to this ship with `status: 'transit'` get activated and started. Also scans `operator/inbox.md` for pending items targeting this ship.

### Speaker Election

Every relay publishes its InfiniClaw HEAD commit epoch to S3 (`relay/<hostname>.json`) at startup and after rebuilds. The **speaker** is the active ship running the newest code; ties are broken by ship rank (lowest wins). This ensures the most up-to-date relay formats aggregate responses.

Election algorithm:
1. Fetch commit epochs from S3 for all active ships
2. Find the maximum epoch across active ships
3. If local epoch is older, defer (not speaker)
4. Among ships at max epoch, lowest rank wins

The speaker result is cached and triggers async re-election in the background. Speaker election runs before aggregate commands (`!fleet`, `!health`, `!promote`/`!demote` for ships).

## Relay Commands

Commands that target ships and infrastructure — distinct from bot lifecycle commands (see [04-bot](04-bot.md)). Ship-targeted commands accept an optional `<ship>` argument; omit it to target all ships. Each relay checks if it's the target — only the matching ship acts, others silently ignore.

### Fleet status

| Command | Scope | Behavior |
|---------|-------|----------|
| `!fleet` | Speaker | Aggregate fleet status: all ships, all bots, versions, health |

The speaker publishes its own report to S3, polls for other ships' reports (up to 5s), then assembles a single threaded response showing every ship and bot grouped by ship rank.

### Code pipeline

| Command | Scope | Behavior |
|---------|-------|----------|
| `!push` | Speaker | Push InfiniClaw repo to GitHub |
| `!provision [target]` | Per-ship | Pull repos, rebuild if new commits. Each ship reports independently. Target: `secrets`, `infiniclaw`, or a name from `paths.json` |
| `!refit [ship]` | Target ship | Pull repos, rebuild, redeploy dist to bot instances, wake all bots. Full deploy cycle. |

Flow: code changes → `!push` (send to GitHub) → `!provision` (all ships pull) → `!refit` (deploy to bots on a ship).

### Ship lifecycle

| Command | Scope | Behavior |
|---------|-------|----------|
| `!commission [ship]` | Target ship | Set `commissioned: true`, wake onduty bots |
| `!decommission [ship]` | Target ship | Sleep all bots, set `commissioned: false`. Relay keeps running. |
| `!operator on/off [ship]` | Target ship | Enable/disable operator relay (forwarding Captain messages to operator tmux) |

## Per-Machine Configuration

These files live at `~/.config/infiniclaw/` and are **not** in git. See `docs/design/13-configuration.md` for full details.

### paths.json

Maps logical names to local paths. Used by role-based mounts (fleet.json `roles[role].rw` → paths.json lookups).

```json
{
  "infiniclaw": "~/2026-Nanoclaw/InfiniClaw",
  "aegis": "~/2025-AEGIS"
}
```

### allow-list.json

Per-bot rw mount overrides with optional expiry. Managed via `!allow`/`!deny` commands.

## Verification

1. **Machine identified** — `hostname` returns a name that matches a key in `ships.json`.
   *Check:* Hostname present in registry.

2. **Prerequisites installed** — Node.js 22+, Podman, tmux, Claude Code all available.
   *Check:* `node -v`, `podman -v`, `tmux -V`, `claude --version` all succeed.

3. **Repos cloned** — InfiniClaw and secrets repos exist at expected paths.
   *Check:* `paths.json` entries resolve to valid git repos.

4. **Relay starts** — `npm run cli relay install` launches the relay as a pm2 process.
   *Check:* `pm2 status infiniclaw-relay` shows "online".

5. **Relay connects** — Relay logs show Matrix auth success for intercom accounts.
   *Check:* Log contains "Matrix auth validated" for each room.

6. **Fleet visible** — `!fleet` in any room produces a response from this ship.
   *Check:* Response includes this ship's hostname and bot list.

7. **Speaker election works** — After verifying both ships are active, run `!fleet` and confirm only one ship responds.
   *Check:* Single aggregate response from the speaker ship.

8. **Transport works** — `!transport <bot> <ship>` dematerializes locally, materializes on destination within one secrets sync interval.
   *Check:* Bot appears on destination ship's `pm2 status` and responds to messages.
