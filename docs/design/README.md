# docs/design/

Architecture and design specifications for InfiniClaw. Each numbered document covers one subsystem. Read `00-overview.md` first for context.

- `00-overview.md` — System overview, principles, architecture
- `01-messaging.md` — Matrix messaging layer, routing, filtering
- `02-threading.md` — Branch and Merge model, Thread Brains, lobes
- `03-ipc.md` — Inter-process communication (container to host)
- `04-fleet.md` — Fleet architecture: rooms, ships, roles, ranks
- `05-commanding-officer.md` — CO election and manager role
- `06-commands.md` — Operator `!` commands and relay protocol
- `07-intercom.md` — Cross-room relay accounts, operator messaging
- `08-autonomy.md` — Bot self-healing, rebuilds, holodeck
- `09-configuration.md` — CLAUDE.md layers (base from `bots/CLAUDE.md`), MCP, brain, session continuity
- `10-safety.md` — OOM handling, rate limits, isolation, MCP preflight
- `11-containers.md` — Podman isolation, mounts, secrets
- `12-deployment-chain.md` — Worktree workflow, holodeck simulation, gates
- `13-infrastructure-redundancy.md` — Ships as VMs, Gitea/MinIO redundancy
- `14-quarters.md` — Ship spaces, bot rooms, lifecycle commands
- `15-bartender.md` — Bartender skill
- `IMPLEMENTATION_ROADMAP.md` — Feature roadmap with implementation status

Engineers cannot modify these files (enforced by pre-commit hook). Architecture changes go through the Architect role.
