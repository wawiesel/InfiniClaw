# 04 — Fleet

## Rooms

Messages go to **rooms**, not to bots directly. Each room is a Matrix room mapped to a NanoClaw "group" (the upstream term from its WhatsApp origins). Multiple bots can share a room.

## Machines and Presence

Bots are distributed across machines. Each machine runs a subset of the fleet, configured in fleet.json (`bots.<name>.machine`). Secrets are shared via a private git repo (`~/.config/infiniclaw/secrets/`).

**Every machine runs a relay at all times**, even when deactivated. A deactivated machine (`active: false` in machines.json) keeps its relay running and listening for commands but does not start bots. This ensures all machines stay reachable — an operator can `!activate` a machine remotely at any time.

Machines are ranked in `machines.json` (`rank` field). The lowest-rank **active** machine is the "speaker" — it replies for aggregate commands like `!health` that would otherwise produce duplicate responses from every relay. Per-machine commands (`!fleet`, `!sync`) still reply from each machine with its local state.

Each machine writes its own presence file to `operator/presence/<hostname>.json` in the secrets repo at deploy time. All machines read all presence files to determine fleet-wide bot availability.

## Roles and Rank

**Roles** are abstract capability sets: navigator, engineer, architect. **Personas** are concrete bot identities assigned to a role. The mapping lives in `roster.json` in the secrets repo. Bots are organized by role in `bots/{role}/{bot}/`.

Each role defines what a bot can do:

| Role | Rank | Capabilities | Restrictions |
|------|------|-------------|-------------|
| Navigator | 1 (highest) | Explore filesystem, execute tasks, report to Captain. Write access to knowledge vault. Email and calendar access. | Cannot modify other bots. |
| Engineer | 2 | Maintain and improve the codebase. Rebuild container images. Modify any bot's persona, skills, MCP. Write access to InfiniClaw. Can restart other bots. | Upstream nanoclaw owned by Architect. |
| Architect | 3 (lowest) | Create new bots, major redesigns. Write access to InfiniClaw, NanoClaw, WKS, AEGIS. Can deploy and test on the Holodeck. | Must test on Holodeck before promoting. |

All bots share: read-only home directory access, ability to edit own persona CLAUDE.md/skills/MCP, ability to restart self.
