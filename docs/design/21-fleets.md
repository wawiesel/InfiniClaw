# Fleet Instances, Systems, and Coordination

InfiniClaw supports multiple fleet instances sharing the same codebase but tracking different branches. All communication and state changes flow through relays. S3 provides atomic coordination between systems.

## Core Architecture

### Relay as Single Gateway

All communication flows through the relay. No bot communicates with Matrix directly.

```
Captain ←→ Matrix ←→ Relay ←→ Bot containers
                       ↕
                      S3 (shared state)
```

- **Messages**: relay reads from Matrix, dispatches to bots; bot output goes through relay to Matrix
- **Status changes**: relay is the only writer of fleet state (bot status, ship status, health)
- **X-commands**: relay processes all commands; bots never handle `!` commands directly

### S3 as Coordination Plane

S3 replaces git-based fleet coordination. Every state change is an atomic S3 PUT — no merge conflicts, no git stash failures, no "could not write index" errors.

```
s3://infiniclaw/
  fleet-state/
    infiniclaw00/fleet.json     # IC00 fleet state (atomic)
    infiniclaw01/fleet.json     # IC01 fleet state (atomic)
  health/
    infiniclaw00/Herc.json      # per-system health
    infiniclaw01/Stg1.json
  fleet-report/
    infiniclaw00/Herc.json      # per-system fleet report
    infiniclaw01/Stg1.json
```

Each relay:
1. Reads fleet state from S3 on startup
2. Writes its own fleet-report to S3 periodically
3. Writes fleet state to S3 on every status change (atomic PUT)
4. On shutdown, flushes all state to S3

Conflict resolution: S3 PUTs are last-writer-wins per key. Each system writes its own bots' state to a system-scoped key. A fleet-wide view is assembled by reading all system keys.

### Nearest Relay Routing

There is no speaker election. Any relay can handle any x-command. When the Captain sends `!fleet` or `!wake parker`, the **nearest relay** picks it up.

"Nearest" is determined by:
1. **Latency** — which relay sees the Matrix event first (natural network proximity)
2. **Availability** — dead relays don't respond; the next-fastest relay handles it
3. **Scope** — commands targeting a specific bot route to the relay hosting that bot

```
Captain: !fleet
  → All relays see the event
  → First relay to respond claims it (reacts with 📡)
  → Other relays see the 📡 and skip
```

```
Captain: !wake parker
  → All relays see the event
  → Only the relay hosting Parker acts on it
  → That relay reacts with 📡
```

This eliminates:
- Speaker election bugs
- Single-point-of-failure when the speaker ship goes down
- The "Herc is dead and nobody responds" problem
- `!operator on/off` complexity

#### Claim Protocol

To prevent duplicate responses:

1. Relay sees x-command in Matrix
2. Checks if command is already claimed (📡 reaction from another relay)
3. If unclaimed and relay can handle it: react with 📡, then execute
4. If already claimed: skip

The 📡 reaction is the distributed lock. Matrix event ordering provides consistency — relays that see the reaction before processing will skip.

For bot-targeted commands (`!wake parker`, `!sleep cid`), only the hosting relay acts. No claim needed — routing is deterministic.

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

`!promote` is an x-command (Captain-only, from BTC):

1. Verify IC01 health (S3 health reports, no F-grade bots)
2. Verify CI passes on `develop`
3. Fast-forward merge `develop` → `main` (no squash — preserve history)
4. Post confirmation to BTC with commit range

If `develop` has diverged from `main` (hotfix on main), `!promote` aborts and reports the divergence. Captain resolves manually.

## System Configuration

Each system (physical machine) knows which fleet and branch it belongs to via `ships.json`:

```json
{
  "Herc": {
    "hostname": "HERACLES",
    "emoji": "🦁",
    "shortname": "Herc",
    "rank": 1,
    "fleet": "infiniclaw00",
    "branch": "main",
    "systemRoom": "!abc123:a-gis.org"
  },
  "Staging1": {
    "hostname": "staging-host",
    "emoji": "🧪",
    "shortname": "Stg1",
    "rank": 1,
    "fleet": "infiniclaw01",
    "branch": "develop",
    "systemRoom": "!def456:a-gis.org"
  }
}
```

Fields:
- `fleet` — which fleet instance (`infiniclaw00`, `infiniclaw01`)
- `branch` — which git branch the relay tracks (default: `main`)
- `systemRoom` — Matrix room ID for this system's infrastructure room

The relay's git sync loop uses `branch` instead of hardcoded `main`:

```
git fetch origin
git rev-list HEAD..origin/<branch> --count
git pull --rebase origin <branch>
```

## Matrix Topology

### Fleet Spaces (bot work)

Each fleet instance has its own Matrix space and duty rooms:

| Fleet | Space | Engineering | Bridge | Astrometrics |
|-------|-------|-------------|--------|--------------|
| IC00 | 🌌 InfiniClaw | 🌌⚙️ Engineering | 🌌🌉 Bridge | 🌌🔭 Astrometrics |
| IC01 | 🧪 InfiniClaw01 | 🧪⚙️ Engineering | 🧪🌉 Bridge | 🧪🔭 Astrometrics |

BehindTheCurtain is shared — the Captain sees both fleets.

### Systems Space (infrastructure)

A **Systems** space contains one room per system (physical machine). This separates infrastructure from bot work.

```
🖥️ Systems (space)
├── 🖥️🦁 HERACLES          # system room for HERACLES
├── 🖥️🔱 Poseidon           # system room for Poseidon
├── 🖥️🪽 Herm               # system room for Herm
└── 🖥️🧪 Staging1           # system room for staging host
```

Each system room has exactly two permanent members:
- **Relay** — posts heartbeat status, git sync results, health summaries, build results
- **Operator** — receives Captain messages targeted to this system, posts intervention logs

The Captain joins all system rooms. Bots do not join system rooms.

#### Purpose

| Use case | How |
|----------|-----|
| Talk to one operator | `@operator` in that system's room |
| See relay heartbeat | Relay posts periodic status to its system room |
| Debug a system | Read the system room — all relay events are there |
| Isolate noise | Relay status no longer pollutes Engineering or Bridge |

#### Relay Heartbeat

The relay posts a periodic status message to its system room (not duty rooms):

```
🟢 Herc · v1.3.14 · 3h uptime · ↻2 restarts · sync 30s ago
├ murdock: quarters · 2h · 0 restarts
└ nora: sleep
```

Frequency: every 5 minutes, or on significant events (restart, sync, bot lifecycle change).

#### Operator Addressing

The Captain addresses a specific system's operator by messaging that system room:

- `@operator` in 🖥️🦁 HERACLES → only Herc's operator responds
- `@operator` in BTC → nearest relay routes (fleet-wide)

This replaces `!operator on/off herc` — just message the system room directly.

### Secrets Repo

Shared repo, separate fleet configs:

```
secrets/
  bots/
    fleet.json        # IC00 bot assignments (disk cache of S3 state)
    fleet01.json      # IC01 bot assignments (disk cache of S3 state)
    {bot}/env         # Shared — bot credentials don't change per fleet
  operator/
    ships.json        # All systems, fleet field distinguishes
    intercom.json     # IC00 room credentials
    intercom01.json   # IC01 room credentials
```

The relay loads the fleet config matching its system's `fleet` field. On startup, S3 state is overlaid onto the disk cache — S3 is authoritative, disk is fallback.

## Bot Transport Between Fleets

Bots can be transported between fleet instances for testing:

```
!transport parker infiniclaw01
```

This moves Parker from IC00 to IC01:
1. Dismiss from IC00 duty room
2. Update IC01 fleet state in S3 with Parker's entry
3. Remove from IC00 fleet state in S3
4. IC01 relay picks up Parker on next state read
5. Parker now runs `develop` branch code

To return: `!transport parker infiniclaw00`

### Compatibility Testing

The primary use case: transport a bot running old code (from IC00) to IC01 where new code is deployed. The bot's container image is from IC00's build, but it interacts with IC01's relay running `develop`. This tests:

- Do new relay features break existing bot containers?
- Do new x-commands work with old bot code?
- Do display format changes render correctly with old bot data?

## Verification

1. `!fleet` shows only the current fleet's systems and bots
2. `!fleet all` from BTC shows both fleets
3. PR merged to `develop` appears on IC01 within one git sync cycle (3 min)
4. `!promote` fast-forwards `main` to `develop` HEAD
5. X-command with no target: nearest relay claims and responds
6. X-command targeting a bot: hosting relay handles it
7. Dead relay: other relays handle fleet-wide commands seamlessly
8. System room: Captain messages `@operator` and only that system's operator responds
9. Relay heartbeat appears in system room every 5 minutes

> **Status:** Not yet implemented. This document describes the target architecture. Implementation requires: (1) `fleet`/`branch`/`systemRoom` fields in ships.json, (2) relay git sync parameterized by branch, (3) S3 fleet-state read/write replacing git-based fleet.json coordination, (4) nearest-relay claim protocol (📡 reaction lock), (5) Systems space and rooms created in Matrix, (6) `!promote` x-command, (7) relay heartbeat to system room.
