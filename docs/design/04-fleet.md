# 04 — Fleet

## Rooms

Messages go to **rooms**, not to bots directly. Each room is a Matrix room mapped to a NanoClaw "group" (the upstream term from its WhatsApp origins). Multiple bots can share a room.

## Ships and Presence

Bots are distributed across ships (machines). Each ship runs a subset of the fleet, configured in fleet.json (`bots.<name>.machine`). Secrets are shared via a private git repo (`~/.config/infiniclaw/secrets/`).

**Every ship runs a relay at all times**, even when decommissioned. A decommissioned ship (`active: false` in ships.json) keeps its relay running and listening for commands but does not start bots. This ensures all ships stay reachable — an operator can `!commission` a ship remotely at any time.

Ships are ranked in `ships.json` (`rank` field). The lowest-rank **active** ship is the "speaker" — it replies for aggregate commands like `!health` that would otherwise produce duplicate responses from every relay. Per-ship commands (`!fleet`, `!provision`) reply from each ship with its local state.

Fleet-wide bot availability is tracked in `fleet.json` and synced via git. The relay on each ship maintains an in-memory copy (`liveFleet`) as the runtime source of truth.

## Transport

`!transport <bot> <ship>` moves a bot between ships via a two-phase git protocol:

1. **Dematerialize** — source ship stops the bot, writes `machine: targetShip, active: false` to fleet.json, and pushes.
2. **Materialize** — target ship's 30s secrets sync sees the inactive bot assigned to it, activates it, starts it, and pushes the updated state.

Transport uses git (not Matrix) because it must survive relay restarts and network blips. If the target ship's relay missed a Matrix message, the bot would be lost. The git protocol guarantees delivery.

## Roles and Rank

**Roles** are abstract capability sets: navigator, engineer, architect. **Personas** are concrete bot identities assigned to a role. The mapping lives in `roster.json` in the secrets repo. Bots are organized by role in `bots/{role}/{bot}/`.

Each role defines what a bot can do:

| Role | Rank | Capabilities | Restrictions |
|------|------|-------------|-------------|
| Navigator | 1 (highest) | Explore filesystem, execute tasks, report to Captain. Write access to knowledge vault. Email and calendar access. | Cannot modify other bots. |
| Engineer | 2 | Maintain and improve the codebase. Rebuild container images. Modify any bot's persona, skills, MCP. Write access to InfiniClaw. Can restart other bots. | Upstream nanoclaw owned by Architect. |
| Architect | 3 (lowest) | Create new bots, major redesigns. Write access to InfiniClaw, NanoClaw, WKS, AEGIS. Can deploy and test on the Holodeck. | Must test on Holodeck before promoting. |

All bots share: read-only home directory access, ability to edit own persona CLAUDE.md/skills/MCP, ability to restart self.
