# docs/design/

Architecture and design specifications for InfiniClaw. Documents are ordered by dependency — each layer builds on the ones before it. Read `00-overview.md` first for core principles.

## Foundation

- `00-overview.md` — Definitions (fleet, ship, relay, bot, operator, space, room, duty room), core principles, code structure
- `01-operator.md` — Operator as escape hatch (host-side tmux, max intelligence, idle in mature fleet), bootstrap foundations (Matrix + S3 + secrets → BehindTheCurtain → first ship → first bot), accounts, Captain communication (all ships with operatorRelay=true receive BTC; !operator on/off per ship), inter-operator inbox, x-commands, operating modes (📡 Watch/👑 Captain/🔧 Fix with mode icon in message prefix), autonomy metrics (interventions/day, 1d/7d rolling)
- `02-matrix.md` — Matrix server, accounts, room naming convention (double-emoji on all rooms and spaces), ship spaces (example not prescriptive), room setup (m.space.child + m.space.parent both required), message format, `<m>` mention pills, reactions (📡/👀/🔔 status pipeline, 👍️/👎️/💯/❌️ scoring), special mentions (@operator, @loudspeaker broadcast/fleet-status, @room intercom), bot Matrix navigation tools, verification
- `03-container.md` — Persistent Podman containers (one per bot, not per turn), internal concurrency (agent runner + persistent main brain + lobes), branch brains on host, image builds, mount table (corrected runtime paths), secrets flow

## Bot Runtime

- `04-ship.md` — Machine registry (`commissioned` flag vs bot `status`, ships.json with hostname+emoji+shortname key), relay (ship control plane: x-command dispatch, bot lifecycle, code sync, branch brain spawning), 7 background loops (git sync, secrets sync, health, heartbeat [GitHub issues], relay tasks, curtain, metrics), speaker election (lowest-rank commissioned ship — rank is sole tiebreaker), relay x-commands (!fleet, !push/!pull, !commission/!decommission, !operator), message conventions (ship tag on main timeline only, thread steps omit tag), per-machine config, ship metrics (uptime, sync failures, x-command latency)
- `05-bot.md` — Identity, bot attributes (triggerType, status, rank, activeBrainModel), mention/callout flow, response rules, unified display format (`<ship><location>·<health><activity>·Name·<role><rank>` with short/medium/long verbosity), boot progress (thread steps omit ship tag), `!wake` restart behavior, resume behavior (IPC inject if active; else spawn), bot metrics (response latency, branch brain success, crashes)
- `06-brain.md` — Three brain types (main/branch/lobe), persistent main brain, triage-and-delegate model, branch model selection, lobe MCP (not yet implemented), credential mapping (BRAIN_MODEL not forwarded to branch brains — #24; nested branching prompt-only — #25)
- `07-ipc.md` — Container ↔ host IPC (messages/tasks/input directories at `_runtime/instances/{bot}/data/ipc/`), atomic file processing, per-room namespaces, main room elevation, wake/sleep cooldowns
- `08-threading.md` — Branch and Merge model, branch brains (host-side `claude --print`), streaming output, concurrency limit, lobes (MCP, any provider, quarters threads), correct branch protocol; verification items annotated with not-yet-implemented status

## Organization

- `09-roles-and-rooms.md` — Roles, room topology, command hierarchy (Captain → Operator/Co → XO → Chiefs → Crew; Chief = highest-rank bot per room; Chief Navigator = XO), bot statuses (pip progression), lifecycle commands (!wake/!sleep/!report/!dismiss/!go), quarters trigger rules, quarters as retrospective memory space
- `10-fleet.md` — fleet.json, transport protocol, S3 coordination, fleet metrics (availability, autonomy score)
- `11-commands.md` — X-commands (`!`-prefixed fleet control), room-scoped targeting (presence-based for most commands, assignment-based for !report, universal from BTC), `!pull [ship]` (no arg = all ships) / `!push [ship]` commands, `!operator` toggle, `!metrics` (context-aware, 1d/7d rolling), status formats, alert threads. `!rejoin` and `!refresh` removed — `!wake` handles both restart and wake.
- `12-co.md` — Chain of command (CO/XO/Chief), Chief election and delegation, Work Breakdown Structure (WBS) — per-room task list with dependencies, auto-assignment on bot startup, reabsorption on off-duty
- `13-intercom.md` — Intercom accounts (bridge/engineering/astrometrics) used by relay to listen/reply; operators send as `@operator` account; loudspeaker replies (`[emoji pip Ship]` prefix), `@loudspeaker:` bot broadcast (implemented), `@loudspeaker` alone = fleet status, `@room:` targeted routing (not yet implemented), `@ <text>` callout is Captain-only

## Resilience

- `14-configuration.md` — CLAUDE.md layers (3 separate files, not concatenated: base at allow-list path, persona at `/workspace/persona/CLAUDE.md` rw, room at `/workspace/CLAUDE.md` ro), MCP per-role config, startup checklist (aspirational — actual boot is a system resume message with active todos + last 5 messages)
- `15-safety.md` — OOM handling (`KILL_137_MAX_CONSECUTIVE`/`KILL_137_COOLDOWN_MS`, `SESSION_MAX_BYTES`), memory limits, rate limiting; MCP preflight aspirational
- `16-autonomy.md` — Bot capabilities (rebuild, git push, peer verification), self-healing loop, holodeck
- `21-cross-machine-health.md` — Cross-machine health protocol: 5-min beacon flush (vs 30-min full), `HealthReport` extensions (`relay_uptime_s`, `secrets_sync`, `git_sync`), staleness classification (LIVE/STALE/OFFLINE), fleet aggregation via S3 pull model, `check_health` scope param (`local`/`fleet`), Matrix alerting on machine status transitions. Status: **Implemented** (all 6 steps, `feat/wbs-relay` branch).

## Higher Features

- `17-skills.md` — Pooled capability modules per role
- `18-deployment.md` — Code pipeline, holodeck simulation gates
- `19-infrastructure.md` — Ships as VMs, Gitea/MinIO redundancy
- `20-metrics.md` — Full metrics taxonomy: Productivity (messages/day, token throughput, score, task completion), Reliability (uptime %, response latency, crashes, OOM, RSS), Autonomy (interventions, autonomy score, MTBI), Infrastructure (relay restarts, sync failures, fleet RSS). Marks ✅ tracked vs 🔲 planned. Uptime as rolling % (not duration). All rolling 1d/7d — no cumulative totals.

Engineers cannot modify these files (enforced by pre-commit hook). Architecture changes go through the Architect role.

**No source code references.** Design docs describe behavior and architecture, not implementation details. Source code paths and function names belong in the implementation README, which links back to each design doc. The pre-commit hook enforces this rule.

**Status markers.** Unimplemented features within design docs are annotated with `> **Status:** ...` blockquotes explaining what is not yet built. This prevents specs from being mistaken for documentation of working code.

See `docs/solutions/matrix.md` for Element Desktop math rendering setup.

Historical planning files (`_old/IMPLEMENTATION_ROADMAP.md`) have been removed. Design history lives in git log.
