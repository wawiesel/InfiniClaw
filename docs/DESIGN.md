# InfiniClaw Design

## What It Is

InfiniClaw is a multi-bot orchestration layer built on a maintained NanoClaw fork. It runs cooperating AI bots on Matrix, each isolated in its own Podman container. The Captain (human) sets direction. Bots execute everything else.

## Core Principles

- **Layer on NanoClaw, don't fork it.** Use everything from upstream. InfiniClaw wraps NanoClaw's entry points (`main.ts` wraps `index.ts`, `container-spawn.ts` wraps `container-runner.ts`). The upstream subtree at `external/nanoclaw/` stays clean.
- **Bots are autonomous.** They rebuild their own images, fix broken MCP, update their own config, monitor their own health, and recover from failures — all without human intervention. The Operator (host-side agent) exists only as an escape hatch for OS-level problems.
- **Bots must be responsive at all times.** Long work is delegated to lobes. The main brain stays available. If it's busy anyway, the host spawns an interrupt lobe as a safety net.
- **No redactions.** Status messages are never deleted. They have a live state and a finished state: `⏳ working (3m)` → `⏳ worked (3m)`.
- **No silent failures.** Every failed message send must be retried or surfaced as a visible error. If a bot can't deliver, it logs the failure with full context and retries. Silent `.catch(() => {})` is a bug.
- **System actions get an emoji prefix.** Any message that isn't a direct conversation response (restarts, working indicator, brain reload, startup) must start with an emoji.
- **Work with Claude Code, not against it.** Bots run on the Claude Agent SDK. When the SDK has a preferred way to do something, use it. If the SDK introduces a tool that overlaps with ours, prefer one-way sync from the SDK over blocking it.
- **SSL passthrough.** Containers and host processes must forward corporate SSL variables (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`) and mount host certificates for TLS inspection proxies.

## Architecture

### Rooms

Messages go to **rooms**, not to bots directly. Each room is a Matrix room mapped to a NanoClaw "group" (the upstream term from its WhatsApp origins). Multiple bots can share a room.

### Machines and Presence

Bots are distributed across machines. Each machine runs a subset of the fleet, configured in `~/.config/infiniclaw/machine.json`. Secrets are shared via a private git repo (`~/.config/infiniclaw/secrets/`).

Each machine writes its own presence file to `operator/presence/<hostname>.json` in the secrets repo at deploy time. All machines read all presence files to determine fleet-wide bot availability.

### Roles and Rank

**Roles** are abstract capability sets: navigator, engineer, architect. **Personas** are concrete bot identities assigned to a role. The mapping lives in `roster.json` in the secrets repo.

Each role defines what a bot can do:

| Role | Capabilities |
|------|-------------|
| Navigator | Explore filesystem, execute tasks, report to Captain. Write access to knowledge vault. Email and calendar access. Cannot modify other bots. |
| Engineer | Maintain and improve the codebase. Rebuild container images. Modify any bot's persona, skills, MCP. Write access to InfiniClaw. Can restart other bots. |
| Architect | Create new bots, major redesigns. Write access to InfiniClaw, NanoClaw, WKS, AEGIS. Can deploy and test on the Holodeck. |

All bots share: read-only home directory access, ability to edit own persona CLAUDE.md/skills/MCP, ability to restart self.

### Commanding Officer

Each room has a **commanding officer (CO)** — the lowest-rank active bot on that room. The CO:
- Responds to all messages (`REQUIRES_TRIGGER=false`), not just `@BotName` callouts
- Gets a star badge in their Matrix display name (e.g. "BotName ⭐")

CO promotion is automatic at deploy time based on `roster.json` ranks and which bots are active across all machines. Bots query the live roster via the `crew_roster` MCP tool, which reads `crew-status.json` generated at deploy from fleet-wide presence data.

### Containers

One bot = one Podman container. Each container runs the agent-runner (Claude Agent SDK) with the bot's persona, tools, and mounts. The host injects secrets as env vars — nothing is baked into images.

Containers run with memory caps (`CONTAINER_MEMORY_MB`, default 6GB) and optional CPU limits. There must never be multiple containers for the same bot, except interrupt lobes (which use `containerNameTag: 'interrupt'` to coexist).

### Message Flow

```
User message → Matrix → main.ts message loop → SQLite → processGroupMessages()
  → container-spawn.ts → podman container runs agent-runner
    → agent-runner calls Claude SDK → streams output markers to stdout
  → main.ts parses stdout → forwards to Matrix (progress + results)
  → working indicator: ⏳ working... → ⏳ working (Xm) → ⏳ worked (Xm)

Scheduled task → task-scheduler.ts poll → group-queue.ts
  → same container spawn path → output forwarded to Matrix

IPC command → container writes JSON to /workspace/ipc/output/
  → ipc-watcher.ts polls directory → processes command → writes response
```

### Message Queue

FIFO per room. One container at a time. `group-queue.ts` enforces this with overflow queueing and retry backoff.

**Interrupt lobe:** When the main container has been running >30 seconds and a new message arrives from the Captain or a callout, the host spawns a **parallel container** (Sonnet, stateless, fire-and-forget) to handle it immediately. The main container keeps running.

This gives two-pronged responsiveness:
1. **Persona-level**: bots delegate long work to lobes so their main brain stays available.
2. **Host-level**: if the main container is busy anyway, the host spawns an interrupt lobe.

### Lobes

Bots spawn delegate "lobes" for parallel execution:
- `delegate_to_lobe` — delegation with Matrix threading. Supports claude, codex, gemini, and ollama backends.
- `query_local_llm` — quiet one-shot Ollama query for formatting, classification, extraction. No chat output.

Every lobe runs in a Matrix thread. The main brain stays sequential — lobes handle subtasks.

### Threading

- Every lobe operation runs in a thread, not on the main timeline.
- Typing indicators are suppressed when the bot is working in a thread.
- Bots with `requiresTrigger` use auto-threading: the triggering message becomes the thread root.

## Configuration

### CLAUDE.md Layers

Bots receive instructions from three CLAUDE.md files:

| Layer | Source | Bot can edit? | How |
|-------|--------|---------------|-----|
| Base | `external/nanoclaw/CLAUDE.md` | No | Read-only in the instance |
| Persona | `bots/personas/{bot}/CLAUDE.md` | Yes | Writable bind mount at `/workspace/extra/{bot}-persona/CLAUDE.md` |
| Group | `bots/personas/{bot}/groups/{room}/CLAUDE.md` | No | Read-only copy in `/workspace/group/CLAUDE.md` |

Base + persona are concatenated into the instance-level CLAUDE.md. Group is loaded as the project-level CLAUDE.md in the container's working directory.

### MCP Configuration

**Source of truth:** `bots/personas/{bot}/groups/{group}/.mcp.json`

Last writer wins. Bots edit it via writable bind mount. Changes take effect on next container spawn.

```
Persona .mcp.json (on disk)
  ↓ read at spawn time by readPersonaGroupMcpServers()
  ↓ passed as mcpServers in ContainerInput JSON via stdin
  ↓ agent-runner passes to Claude SDK query()
  → Claude connects to MCP servers
```

Two mechanisms exist (don't confuse them):

| Mechanism | Source | What it configures | When read |
|-----------|--------|-------------------|-----------|
| SDK passthrough | Persona `.mcp.json` | SSE/URL-based servers (host-side) | Container spawn |
| `mcp-sync.ts` | Persona `mcp-servers/{name}/mcp.json` | Command-based servers (in-container) | Deploy |

### Mount System

Two-tier design: read-only everywhere, write access where needed.

**Tier 1: Read-only home mirror** — The host home directory is mounted at its real path inside every container, read-only. Bots read files using the same paths as on the host. Added automatically by `container-mounts.ts`.

**Tier 2: Read-write workspace mounts** — Per-bot directories mounted at `/workspace/extra/...` via `container-config.json`. Validated against the host-side allowlist (`~/.config/nanoclaw/mount-allowlist.json`). The Captain grants/revokes temporary mounts via `!allow <path> [minutes]` / `!deny <path>`.

### Secrets

- **No credentials in git.** Bot env files live in the secrets repo (`~/.config/infiniclaw/secrets/`). `.mcp.json` files (may contain OAuth tokens) are gitignored.
- **Secrets flow:** profile env files → loaded by host process → injected as `--env` into containers. Nothing baked into images.
- **Mount allowlist** is stored outside the repo (`~/.config/nanoclaw/mount-allowlist.json`) so containers can't tamper with it.

## Security

- **Container isolation** — Podman containers with memory caps, optional CPU limits. No network egress to arbitrary hosts.
- **Per-room IPC namespaces** — Each room gets its own IPC directory (`_runtime/data/ipc/{room}/`). Prevents cross-room privilege escalation.
- **Main room elevation** — Only the main room's containers can run privileged IPC commands (`restart_bot`, `rebuild_image`, `git_push`). Other rooms are restricted to task scheduling and thread management.
- **One container per bot** — `group-queue.ts` enforces this. Stale containers from crashes are cleaned up before spawning. Interrupt lobes coexist via `containerNameTag`.
- **MCP preflight** — Agent-runner runs a 5-second check on every remote MCP server at startup. Unreachable servers are dropped. Failure reports go to Engineering automatically.

## Bot Autonomy

| Capability | How |
|-----------|-----|
| Rebuild own container image | IPC task `rebuild_image` |
| Restart self or other bots | IPC task `restart_bot` |
| Push code to remote | IPC task `git_push` |
| Fix broken MCP config | Edit persona `.mcp.json`, request restart |
| Monitor health | Collect metrics, report via Matrix |
| Move between machines | Transporter skill: S3 sync + Matrix coordination |
| Update own instructions | Edit persona CLAUDE.md via writable mount |
| Add/modify skills | Write SKILL.md to persona skills directory |

**Self-healing loop:**

```
Bot detects problem (MCP down, health check fails, OOM)
  → Bot diagnoses root cause (read logs, check config)
  → Bot fixes the cause (edit config, update image, adjust memory)
  → Bot requests restart via IPC
  → Host process restarts bot with fixed config
  → Bot verifies fix on startup
  → Bot reports resolution via Matrix
```

**Operator (escape hatch only):** Cross-machine coordination when Matrix is down, OS-level fixes (launchd, podman, network), secret rotation requiring human auth, emergency intervention for restart loops.

## Code Structure

InfiniClaw wraps NanoClaw entry points via npm workspaces (`import from 'nanoclaw/config.js'`). See `src/README.md` for the full file map.

| Layer | Location | Purpose |
|-------|----------|---------|
| InfiniClaw host | `src/` | Orchestrator, Matrix channel, container spawning, IPC, CLI |
| NanoClaw framework | `external/nanoclaw/src/` | Container lifecycle, SQLite, queuing, routing, scheduling |
| Container agent | `external/nanoclaw/container/agent-runner/` | Runs inside containers: Claude SDK, MCP tools, IPC |
| Bot definitions | `bots/` | Personas, roles, Dockerfiles, skills |

## Known Issues — Engineering Backlog

These are real problems. Simplify, don't add complexity.

### Duplicate working indicator

`⏳ working...` appears twice when the interrupt lobe handles a message and then the main container re-processes it. The indicator system (`createIndicatorSet` in `main.ts`) is overbuilt with retry logic, adaptive timers, and bump functions. It should be one message that gets edited. Strip it down.

### No streaming to Matrix

Bots produce nothing visible while thinking, then dump the full response. The agent-runner emits output markers only when Claude calls `send_message`. Matrix supports message editing (`m.replace`), so progressive display is possible — send a placeholder, edit as tokens arrive. This requires streaming raw LLM tokens from the container to the host.

### `restorePersona()` is redundant

Persona directories are now bind-mounted into containers. The `restorePersona()` function in `service.ts` that copies persona content into the instance is legacy. Remove it. Deploy flow should be: rsync nanoclaw → write crew status → start launchd.

### `syncPersona()` is fragile

With direct bind mounts, bot edits already persist to the repo. The sync-back step on stop is a no-op for mounted paths and a bug source for everything else. Remove it.

### Scheduled task mount error

Scheduled tasks fail with `statfs .../container/agent-runner/src: no such file or directory`. The agent-runner source mount path is only valid during development. Scheduled task containers need the same mount resolution as regular containers.

### Rate limit visibility

Matrix SDK initial sync causes 429s distinct from outbound message rate limits. The existing alerting only tracks outbound sends. Initial sync rate limits are silent. Log initial sync duration.
