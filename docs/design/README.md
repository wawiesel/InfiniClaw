# docs/design/

Architecture and design specifications for InfiniClaw. Documents are ordered by dependency — each layer builds on the ones before it. Read `00-overview.md` first for core principles.

## Foundation

- `00-overview.md` — Core principles, code structure
- `01-matrix.md` — Matrix server, rooms, spaces, accounts
- `02-containers.md` — Podman isolation, images, mounts, secrets

## Bot Runtime

- `03-ships.md` — Machine registry, relay process, auto-sync
- `04-bot.md` — Identity, trigger pattern, filtering, message routing
- `05-brain.md` — LLM integration, session continuity, model management
- `06-ipc.md` — Container ↔ host communication, namespaces, cooldowns
- `07-threading.md` — Branch and Merge model, Thread Brains, lobes

## Organization

- `08-roles-and-rooms.md` — Roles, room topology, bot statuses, lifecycle
- `09-fleet.md` — fleet.json, transport protocol, S3 coordination
- `10-commands.md` — Operator `!` commands, status formats, alert threads
- `11-co.md` — Commanding Officer election and delegation
- `12-intercom.md` — Cross-room broadcast accounts, operator messaging

## Resilience

- `13-configuration.md` — CLAUDE.md layers, MCP, startup checklist
- `14-safety.md` — OOM handling, memory limits, rate limiting
- `15-autonomy.md` — Self-healing, auto-rebuild, holodeck

## Higher Features

- `16-skills.md` — Pooled capability modules per role
- `17-deployment.md` — Code pipeline, holodeck simulation gates
- `18-infrastructure.md` — Ships as VMs, Gitea/MinIO redundancy

Engineers cannot modify these files (enforced by pre-commit hook). Architecture changes go through the Architect role.
