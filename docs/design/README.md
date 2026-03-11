# docs/design/

Architecture and design specifications for InfiniClaw. Documents are ordered by dependency — each layer builds on the ones before it. Read `00-overview.md` first for core principles.

## Foundation

- `00-overview.md` — Core principles (responsive triage, branch-not-interrupt, autonomous fleet, Matrix as state, presence over spam), code structure
- `01-matrix.md` — Matrix server, accounts, room naming convention (double-emoji on all rooms and spaces), ship spaces (example not prescriptive), room setup, message format, `<m>` mention pills, reactions (📡/👀/🔔), special mentions, verification
- `02-container.md` — Persistent Podman containers (one per bot, not per turn), internal concurrency (agent runner + persistent main brain + lobes), Thread Brains on host, image builds, mount table, secrets flow

## Bot Runtime

- `03-ship.md` — Machine registry (`commissioned` flag vs bot `status`), relay process (loudspeaker tags, BehindTheCurtain mirror), speaker election, auto-sync loops, relay commands (!fleet, !push/!pull [ship], !commission/!decommission, !operator), per-machine config
- `04-bot.md` — Identity, bot attributes (triggerType, status, rank), mention/callout flow, response rules, display name format, boot progress (`relay <action>` prefix), `!wake` restart behavior, resume behavior
- `05-brain.md` — Persistent main brain, message delivery (SQLite → IPC), turn timeout (90s default, `podman stop`), credential mapping (BRAIN_* → CLAUDE_CODE_*/ANTHROPIC_*), quota fallback, session continuity
- `06-ipc.md` — Container ↔ host IPC (messages/tasks/input directories), atomic file processing, per-room namespaces, main room elevation, wake/sleep cooldowns
- `07-threading.md` — Branch and Merge model, Thread Brains (host-side `claude --print`), streaming output, concurrency limit, async lobes (codex/gemini/claude/ollama), delegation flow, correct branch protocol

## Organization

- `08-roles-and-rooms.md` — Roles, room topology, bot statuses (pip progression), lifecycle commands (!wake/!sleep/!report/!dismiss/!go), quarters trigger rules
- `09-fleet.md` — fleet.json, transport protocol, S3 coordination
- `10-commands.md` — Operator `!` commands (report/dismiss/go/wake/sleep), status formats, alert threads
- `11-co.md` — Commanding Officer election and delegation
- `12-intercom.md` — Intercom broadcast accounts, loudspeaker replies, @room cross-room mentions

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
