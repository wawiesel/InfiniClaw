# docs/design/

Architecture and design specifications for InfiniClaw. Documents are ordered by dependency — each layer builds on the ones before it. Read `00-overview.md` first for core principles.

## Foundation

- `00-overview.md` — Core principles, code structure
- `01-matrix.md` — Matrix server, accounts, room setup, message format, verification
- `02-containers.md` — Podman isolation, image builds, mount table, secrets flow, credential proxy

## Bot Runtime

- `03-ships.md` — Machine registry, relay process, speaker election, auto-sync loops, transport
- `04-bot.md` — Identity, trigger pattern, response rules, persona system, resume behavior
- `05-brain.md` — LLM integration, session continuity, model management
- `06-ipc.md` — Container ↔ host communication, namespaces, cooldowns
- `07-threading.md` — Branch and Merge model, Thread Brains, lobes

## Organization

- `08-roles-and-rooms.md` — Roles, room topology, bot statuses, lifecycle, quarters trigger rules, threading rules
- `09-fleet.md` — fleet.json, transport protocol, S3 coordination
- `10-commands.md` — Operator `!` commands, status formats, alert threads
- `11-co.md` — Commanding Officer election and delegation
- `12-intercom.md` — Intercom broadcast accounts, loudspeaker replies, operator account

## Resilience

- `13-configuration.md` — CLAUDE.md layers, MCP, startup checklist
- `14-safety.md` — OOM handling, memory limits, rate limiting
- `15-autonomy.md` — Self-healing, auto-rebuild, holodeck

## Higher Features

- `16-skills.md` — Pooled capability modules per role
- `17-deployment.md` — Code pipeline, holodeck simulation gates
- `18-infrastructure.md` — Ships as VMs, Gitea/MinIO redundancy

Engineers cannot modify these files (enforced by pre-commit hook). Architecture changes go through the Architect role.

**No source code references.** Design docs describe behavior and architecture, not implementation details. Source code paths and function names belong in the implementation README, which links back to each design doc. The pre-commit hook enforces this rule.

See `docs/solutions/matrix.md` for Element Desktop math rendering setup.
