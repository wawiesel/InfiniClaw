# Fleet Instances and Staging

InfiniClaw supports multiple fleet instances sharing the same codebase but tracking different branches. This enables live integration testing before production deployment.

## Fleet Instances

A **fleet instance** is a named deployment environment with its own ships, branch, and Matrix space.

| Fleet | Branch | Purpose | Ships |
|-------|--------|---------|-------|
| InfiniClaw00 | `main` | Production — stable, tested code | Herc, Posi, Herm |
| InfiniClaw01 | `develop` | Staging — pre-production testing | TBD |

Each fleet instance is independent: its own Matrix rooms, its own relay configuration, its own bot assignments. They share the same GitHub repo and secrets repo.

## Branch Model

```
feature/* ──→ develop ──→ main
              (IC01)      (IC00)
```

- **Feature branches** — created by bots for each task. Short-lived.
- **`develop`** — integration branch. All PRs merge here first. IC01 ships track this.
- **`main`** — production branch. Only receives merges from `develop` after live testing passes on IC01.

### PR Flow

1. Bot creates feature branch, opens PR targeting `develop`
2. CI runs (build + tests)
3. PR merges to `develop`
4. IC01 relay pulls `develop`, rebuilds, restarts bots
5. Live testing on IC01 (bot interactions, x-commands, display, metrics)
6. When `develop` is stable: `!promote` merges `develop` → `main`
7. IC00 relays pull `main`, rebuild, restart

### Promotion

`!promote` is a relay x-command (Captain-only, from BTC):

1. Verify IC01 health (S3 health reports, no F-grade bots)
2. Verify CI passes on `develop`
3. Fast-forward merge `develop` → `main` (no squash — preserve history)
4. Post confirmation to BTC with commit range

If `develop` has diverged from `main` (hotfix on main), `!promote` aborts and reports the divergence. Captain resolves manually.

## Ship Configuration

Each ship knows which fleet and branch it belongs to via `ships.json`:

```json
{
  "Herc": {
    "hostname": "HERACLES",
    "emoji": "🦁",
    "shortname": "Herc",
    "rank": 1,
    "fleet": "infiniclaw00",
    "branch": "main"
  },
  "Staging1": {
    "hostname": "staging-host",
    "emoji": "🧪",
    "shortname": "Stg1",
    "rank": 1,
    "fleet": "infiniclaw01",
    "branch": "develop"
  }
}
```

New fields:
- `fleet` — which fleet instance this ship belongs to (`infiniclaw00`, `infiniclaw01`)
- `branch` — which git branch the relay tracks (default: `main`)

The relay's git sync loop uses `branch` instead of hardcoded `main`:

```
git fetch origin
git rev-list HEAD..origin/<branch> --count
git pull --rebase origin <branch>
```

## Fleet Isolation

### Matrix Rooms

Each fleet instance has its own Matrix space and duty rooms:

| Fleet | Space | Engineering | Bridge | Astrometrics |
|-------|-------|-------------|--------|--------------|
| IC00 | 🌌 InfiniClaw | 🌌⚙️ Engineering | 🌌🌉 Bridge | 🌌🔭 Astrometrics |
| IC01 | 🧪 InfiniClaw01 | 🧪⚙️ Engineering | 🧪🌉 Bridge | 🧪🔭 Astrometrics |

BehindTheCurtain is shared — the Captain sees both fleets.

### Secrets Repo

Shared repo, separate fleet configs:

```
secrets/
  bots/
    fleet.json        # IC00 bot assignments
    fleet01.json      # IC01 bot assignments
    {bot}/env         # Shared — bot credentials don't change per fleet
  operator/
    ships.json        # All ships, fleet field distinguishes
    intercom.json     # IC00 room credentials
    intercom01.json   # IC01 room credentials
```

The relay loads the fleet config matching its ship's `fleet` field.

### S3

S3 keys include the fleet name:

```
health/infiniclaw00/Herc.json
health/infiniclaw01/Stg1.json
fleet-report/infiniclaw00/Herc.json
fleet-report/infiniclaw01/Stg1.json
```

`!fleet` shows only the current fleet's ships by default. `!fleet all` shows both.

## Bot Transport Between Fleets

Bots can be transported between fleet instances for testing:

```
!transport parker infiniclaw01
```

This moves Parker from IC00 to IC01:
1. Dismiss from IC00 duty room
2. Update `fleet01.json` with Parker's entry
3. Remove from `fleet.json`
4. IC01 relay picks up Parker on next sync
5. Parker now runs `develop` branch code

To return: `!transport parker infiniclaw00`

### Compatibility Testing

The primary use case: transport a bot running old code (from IC00) to IC01 where new code is deployed. The bot's container image is from IC00's build, but it interacts with IC01's relay running `develop`. This tests:

- Do new relay features break existing bot containers?
- Do new x-commands work with old bot code?
- Do display format changes render correctly with old bot data?

## Verification

1. `!fleet` on IC00 shows only IC00 ships and bots
2. `!fleet` on IC01 shows only IC01 ships and bots
3. `!fleet all` from BTC shows both fleets
4. PR merged to `develop` appears on IC01 within one git sync cycle (3 min)
5. `!promote` fast-forwards `main` to `develop` HEAD
6. IC00 relays pick up new code within one git sync cycle
7. `!transport bot infiniclaw01` moves bot to staging fleet
8. Bot on IC01 interacts normally with IC01's relay and rooms

> **Status:** Not yet implemented. This document describes the target architecture. Implementation requires: (1) `branch` field in ships.json, (2) relay git sync parameterized by branch, (3) IC01 Matrix rooms created, (4) `!promote` x-command, (5) fleet-scoped S3 keys.
