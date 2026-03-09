# 03 — Ships

A ship is a machine running a relay. The relay is the always-on process that connects the ship to the fleet via Matrix, manages bot lifecycle, and syncs repos.

## Ship Registry

Ships are registered in `ships.json` in the secrets repo:

```json
{
  "HERACLES": { "ip": null, "os": "macOS", "user": "ww5", "active": true, "rank": 2 }
}
```

Ships are ranked. The lowest-rank **active** ship is the "speaker" — it replies for aggregate commands like `!health` that would otherwise produce duplicate responses from every relay.

A decommissioned ship (`active: false`) keeps its relay running and listening for commands but does not start bots. This ensures all ships stay reachable — an operator can `!commission` a ship remotely at any time.

## The Relay

A lightweight always-on process, one per ship (`src/relay.ts`). The relay connects to Matrix rooms via intercom accounts (credentials from `operator/intercom.json`) and watches for `!` commands from the Captain or intercom senders. It manages bot lifecycle by calling service functions directly.

**The relay runs on every ship, always.** Even decommissioned ships keep their relay running — they just don't start bots.

When a command arrives (e.g. `!rejoin cid`), every ship's relay sees it. Each checks if the target bot is local (via fleet.json). Only the owning ship acts — the rest silently ignore. Untargeted commands are room-scoped: the relay matches the room against each bot's `MAIN_GROUP_NAME`.

Started by `npm run cli relay install` and runs as pm2 process `infiniclaw-relay`.

### Auto-sync Loops

- **InfiniClaw repo**: Pull on interval (`GIT_SYNC_INTERVAL`), rebuild on new commits, redeploy all dist files to bot instances and restart them.
- **Secrets repo**: Pull on interval (`SECRETS_SYNC_INTERVAL`). On new commits, check for transport materializations (bots assigned to this ship but inactive → activate and start).
- **Health**: Run `health-check.sh` on interval (`HEALTH_INTERVAL`), upload to S3.

See `src/relay.ts` for defaults.

### Speaker Election

Every relay publishes its InfiniClaw HEAD commit epoch to S3 (`relay/<ship>.json`) at startup and after rebuilds. The **speaker** is the active ship running the newest code; ties are broken by ship rank (lowest wins). This ensures the most up-to-date relay formats aggregate responses.

Speaker election runs before any aggregate command (`!fleet`, `!health`). Non-speakers silently return.

## Per-Machine Configuration

### paths.json (NOT in git)

Maps logical names to local paths. Used by role-based mounts.

```json
{
  "infiniclaw": "~/2026-Nanoclaw/InfiniClaw",
  "aegis": "~/2025-AEGIS",
  "vault": "~/_vault"
}
```

### allow-list.json (NOT in git)

Per-bot rw mount overrides, managed via `!allow`/`!deny`.

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
