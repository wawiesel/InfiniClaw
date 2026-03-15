# docs/design/

Architecture and design specifications for InfiniClaw. Documents are ordered by dependency — each layer builds on the ones before it. Read `00-overview.md` first for core principles.

## Foundation

- `00-overview.md` — Definitions (fleet, ship, relay, bot with 7 lifecycle statuses, operator, space, room with `<location><room>` naming, duty room), foundations (Matrix + S3 + secrets repo), core principles, code structure (InfiniClaw host / NanoClaw core / container agent / bot definitions)
- `01-operator.md` — Operator as escape hatch (host-side tmux, max intelligence, idle in mature fleet), bootstrap foundations (Matrix + S3 + secrets → BehindTheCurtain → first ship → first bot), accounts, Captain communication (all ships with operatorRelay=true receive BTC; !operator on/off per ship), inter-operator inbox, x-commands, operating modes (📡 Watch/👑 Captain/🔧 Fix with mode icon in message prefix), autonomy metrics (interventions/day, 1d/7d rolling)
- `02-matrix.md` — Matrix server, accounts (bot display names via `unifiedBotDisplay('short')`), room naming convention (double-emoji on all rooms and spaces), ship spaces (example not prescriptive), room setup (m.space.child + m.space.parent both required), message format, `<m>` mention pills, reactions (📡/👀/🔔 status pipeline, 👍️/👎️/💯/❌️ scoring), special mentions (@operator Captain/operator-only tmux routing, @loudspeaker broadcast/fleet-status, @room intercom), bot MCP tools (navigation, reactions, media, threads, health, roster, brain mode, BB, lobes, git), verification
- `03-container.md` — Persistent Podman containers (one per bot, not per turn), internal concurrency (agent runner + persistent main brain + lobes), branch brains in containers (BRANCH_BRAIN_IMAGE, bots/container/branch-brain/Dockerfile), image builds (CONTAINER_IMAGE), mount table, secrets flow (CONTAINER_ENV_* prefix stripping, credential allowlist — #37)

## Bot Runtime

- `04-ship.md` — Machine registry (`commissioned` flag vs bot `status`, ships.json with hostname+emoji+shortname key), relay (ship control plane: x-command dispatch, bot lifecycle, code sync, branch brain spawning), 8 background loops (git sync, secrets sync, health, heartbeat [GitHub issues], relay tasks, curtain, metrics, duty cycle), speaker election (lowest-rank commissioned ship — rank is sole tiebreaker), relay x-commands (!fleet, !push/!pull, !commission/!decommission, !operator), message conventions (ship tag on main timeline only, thread steps omit tag), per-machine config, ship metrics (uptime, sync failures, x-command latency)
- `05-bot.md` — Identity, bot attributes (triggerType, status, rank, activeBrainModel), mention/callout flow, response rules, unified display format (short/long verbosity: `<prefix> <Name> <type/role><rank>·<health>·<activity>`), health grades (A/B/C/F with thresholds), activity levels (·/🔹/⚡/🔥 by tok/day), rank medals, location emojis, boot progress (thread steps omit ship tag), `!wake` restart behavior, resume behavior (IPC inject if active; else spawn), duty cycle status flow (onduty→retrospective→dream→ready, pip progression 🟢📝💤✅), bot metrics (response latency, branch brain success, crashes)
- `06-brain.md` — Three brain types (main/branch/lobe), persistent main brain, triage-and-delegate model, branch runs in container (fallback host), branch model selection, lobe MCP (not yet production-ready), credential mapping (BRAIN_MODEL now forwarded via mapBrainEnv — #24 fixed; nested branching prompt-only — #25)
- `07-ipc.md` — Container ↔ host IPC (messages/tasks/input directories at `_runtime/instances/{bot}/data/ipc/`), atomic file processing (500ms poll), per-room namespaces, main room elevation, per-command cooldowns (60s restart/push/pull, 5m rebuild), relay-tasks (git_push, branch_brain at 2s poll), holodeck IPC commands, verification protocol
- `08-threading.md` — Branch and Merge model, branch brains (podman container, fallback to host `claude --print`), streaming output, concurrency limit, main-timeline summary (🧵 title — ✅ done after 30s debounce), thread reactivation (follow-up in completed BB thread spawns new BB, 4h TTL in `branch-tasks.json`), lobes (MCP, any provider, quarters threads), correct branch protocol

## Organization

- `09-roles-and-rooms.md` — Roles, room topology, command hierarchy (Captain → Operator/Co → XO → Chiefs → Crew; Chief = highest-rank bot per room; Chief Navigator = XO), bot statuses (pip progression: 🟢/📝/💤/✅ for onduty/retrospective/dream/ready), lifecycle commands (!wake/!sleep/!report/!dismiss/!go), quarters trigger rules, quarters as retrospective memory space, duty cycle (quarters→onduty→retrospective→sleep→dream→ready, ondutyAt in fleet.json, no resync while on duty)
- `10-fleet.md` — fleet.json schema (role/rank/ship/status/triggerType/quartersRoom/activeBrainModel/ondutyAt), transport protocol (transit→quarters on materialize), S3 coordination, fleet metrics (availability, autonomy score)
- `11-commands.md` — X-commands (`!`-prefixed fleet control), room-scoped targeting (presence-based for most commands, assignment-based for !report, universal from BTC), `!pull [--force] [ship]` (semver version gate, status-preserving restarts) / `!push [ship]` commands, `!health` (alias for `!metrics fleet`), `!operator` toggle, `!metrics` (context-aware, 1d/7d rolling), `!allow`/`!deny` quarters shorthand (bot inferred), status formats, alert threads, version string format (`fmtVersion()`). `!rejoin` and `!refresh` removed — `!wake` handles both restart and wake.
- `12-co.md` — Chain of command (CO/XO/Chief), Chief election and delegation, Work Breakdown Structure (WBS) — S3-backed per-room deliverable hierarchy, PERT estimation, critical path scheduling, Chief-only write access (MCP enforced), 0/100 completion, EVM metrics (SPI/CPI), Kanban flow, reabsorption on off-duty, disk echo in secrets repo
- `13-intercom.md` — Intercom accounts (bridge/engineering/astrometrics), loudspeaker replies (`[emoji Ship]` prefix), `@loudspeaker:` bot broadcast / `@loudspeaker` alone = fleet status (both implemented), `@room:` targeted routing (not yet implemented)

## Resilience

- `14-configuration.md` — CLAUDE.md layers (base/persona/room), MCP per-role config, chat activity tracking (per-room objective/progress/error), startup checklist (skills/MCP/todos/machine health/weekly goals by role)
- `15-safety.md` — OOM handling, memory limits, rate limiting
- `16-autonomy.md` — Bot capabilities (rebuild, git push, peer verification), self-healing loop, holodeck

## Higher Features

- `17-skills.md` — Pooled capability modules per role
- `18-deployment.md` — Code pipeline, holodeck simulation gates
- `19-infrastructure.md` — Ships as VMs, Gitea/MinIO redundancy
- `20-metrics.md` — Full metrics taxonomy: Productivity (messages/day, token throughput, score, task completion), Reliability (fleet availability ✅, uptime %, response latency, crashes, OOM, RSS), Autonomy (interventions, autonomy score, MTBI), Infrastructure (relay restarts, sync failures, fleet RSS). Marks ✅ tracked vs 🔲 planned. Token throughput, response latency, MTBI, fleet availability now ✅ implemented. Messages/day still 🔲 planned. All rolling 1d/7d — no cumulative totals.

Engineers cannot modify these files (enforced by pre-commit hook). Architecture changes go through the Architect role.

**No source code references.** Design docs describe behavior and architecture, not implementation details. Source code paths and function names belong in the implementation README, which links back to each design doc. The pre-commit hook enforces this rule.

**Status markers.** Unimplemented features within design docs are annotated with `> **Status:** ...` blockquotes explaining what is not yet built. This prevents specs from being mistaken for documentation of working code.

See `docs/solutions/matrix.md` for Element Desktop math rendering setup.

Historical planning files (`_old/IMPLEMENTATION_ROADMAP.md`) have been removed. Design history lives in git log.
