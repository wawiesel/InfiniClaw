# docs/design/

Architecture and design specifications for InfiniClaw. Documents are ordered by dependency — each layer builds on the ones before it. Read `00-overview.md` first for core principles.

## Foundation

- `00-overview.md` — Definitions (fleet, ship, relay, bot, operator, space, room, duty room), core principles, code structure
- `01-operator.md` — Operator as escape hatch (host-side tmux, max intelligence, idle in mature fleet), bootstrap sequence (operator first → BehindTheCurtain → first ship → first bot), accounts, Captain communication routing (speaker default, 📞 broadcast), inter-operator inbox, x-commands, autonomy metrics (interventions/day, 1d/7d rolling)
- `02-matrix.md` — Matrix server, accounts, room naming convention (double-emoji on all rooms and spaces), ship spaces (example not prescriptive), room setup, message format, `<m>` mention pills, reactions (📡/👀/🔔), special mentions, bot Matrix navigation tools, verification
- `03-container.md` — Persistent Podman containers (one per bot, not per turn), internal concurrency (agent runner + persistent main brain + lobes), branch brains on host, image builds, mount table, secrets flow

## Bot Runtime

- `04-ship.md` — Machine registry (`commissioned` flag vs bot `status`), relay (ship control plane: x-command dispatch, bot lifecycle, code sync, branch brain spawning), speaker election, relay x-commands (!fleet, !push/!pull, !commission/!decommission, !operator), message conventions (ship tag on main timeline only, thread steps omit tag), per-machine config, ship metrics (uptime, sync failures, x-command latency)
- `05-bot.md` — Identity, bot attributes (triggerType, status, rank), mention/callout flow, response rules, display name format (`<pip> <name> <shipEmoji>`), boot progress (thread steps omit ship tag), `!wake` restart behavior, resume behavior, bot metrics (response latency, task completion, crashes)
- `06-brain.md` — Three brain types (main/branch/lobe), persistent main brain, triage-and-delegate model, branch model selection, lobe MCP (any provider, quarters threads), credential mapping
- `07-ipc.md` — Container ↔ host IPC (messages/tasks/input directories), atomic file processing, per-room namespaces, main room elevation, wake/sleep cooldowns
- `08-threading.md` — Branch and Merge model, branch brains (host-side `claude --print`), streaming output, concurrency limit, lobes (MCP, any provider, quarters threads), correct branch protocol

## Organization

- `09-roles-and-rooms.md` — Roles, room topology, bot statuses (pip progression), lifecycle commands (!wake/!sleep/!report/!dismiss/!go), quarters trigger rules
- `10-fleet.md` — fleet.json, transport protocol, S3 coordination, fleet metrics (availability, autonomy score)
- `11-commands.md` — X-commands (`!`-prefixed fleet control), `!metrics` (1d/7d rolling), status formats, alert threads
- `12-co.md` — Commanding Officer election and delegation
- `13-intercom.md` — Intercom broadcast accounts, loudspeaker replies, @room cross-room mentions

## Resilience

- `14-configuration.md` — CLAUDE.md layers, MCP, startup checklist
- `15-safety.md` — OOM handling, memory limits, rate limiting
- `16-autonomy.md` — Self-healing, auto-rebuild, holodeck

## Higher Features

- `17-skills.md` — Pooled capability modules per role
- `18-deployment.md` — Code pipeline, holodeck simulation gates
- `19-infrastructure.md` — Ships as VMs, Gitea/MinIO redundancy

Engineers cannot modify these files (enforced by pre-commit hook). Architecture changes go through the Architect role.

**No source code references.** Design docs describe behavior and architecture, not implementation details. Source code paths and function names belong in the implementation README, which links back to each design doc. The pre-commit hook enforces this rule.

See `docs/solutions/matrix.md` for Element Desktop math rendering setup.
