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
- **Fix code and process, not behavior.** When a bot behaves incorrectly, fix the underlying system — the code, the IPC flow, the routing logic — not the bot's in-context behavior. Workarounds that patch behavior without addressing root cause accumulate debt and mask real problems.
- **SSL passthrough.** Containers and host processes must forward corporate SSL variables (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`) and mount host certificates for TLS inspection proxies.

## Architecture

### Rooms

Messages go to **rooms**, not to bots directly. Each room is a Matrix room mapped to a NanoClaw "group" (the upstream term from its WhatsApp origins). Multiple bots can share a room.

### Machines and Presence

Bots are distributed across machines. Each machine runs a subset of the fleet, configured in `~/.config/infiniclaw/machine.json`. Secrets are shared via a private git repo (`~/.config/infiniclaw/secrets/`).

Each machine writes its own presence file to `operator/presence/<hostname>.json` in the secrets repo at deploy time. All machines read all presence files to determine fleet-wide bot availability.

### Roles and Rank

**Roles** are abstract capability sets: navigator, engineer, architect. **Personas** are concrete bot identities assigned to a role. The mapping lives in `roster.json` in the secrets repo. Bots are organized by role in `bots/{role}/{bot}/`.

Each role defines what a bot can do:

| Role | Rank | Capabilities | Restrictions |
|------|------|-------------|-------------|
| Navigator | 1 (highest) | Explore filesystem, execute tasks, report to Captain. Write access to knowledge vault. Email and calendar access. | Cannot modify other bots. |
| Engineer | 2 | Maintain and improve the codebase. Rebuild container images. Modify any bot's persona, skills, MCP. Write access to InfiniClaw. Can restart other bots. | Upstream nanoclaw owned by Architect. |
| Architect | 3 (lowest) | Create new bots, major redesigns. Write access to InfiniClaw, NanoClaw, WKS, AEGIS. Can deploy and test on the Holodeck. | Must test on Holodeck before promoting. |

All bots share: read-only home directory access, ability to edit own persona CLAUDE.md/skills/MCP, ability to restart self.

### Commanding Officer

Each room has a **commanding officer (CO)** — the lowest-rank active bot on that room. The CO:
- Gets a star badge in their Matrix display name (e.g. "BotName ⭐")
- All bots require @callout — CO designation is for rank/authority and display badge only

CO election is dynamic via `!roster join/leave` intercom signals sent at CLI start/stop. Display name badges: ⭐ = CO, 🟢 = active, 🔴 = dismissed/offline. Bots query the live roster via the `crew_roster` MCP tool, which reads `crew-status.json` generated at deploy from fleet-wide presence data.

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

### Message Routing

Bots see all room messages as context but only **respond** when it's their job. The host collects all bot Matrix user IDs at startup (`collectBotMatrixUserIds`) and uses them to distinguish human from bot messages.

**Response triggers (human messages only):**
- **Callout** — a human message contains `@BotName`
- **Participating thread** — a human posts in a thread the bot previously sent a message in
- **CO main timeline** — the commanding officer responds to any unaddressed human message on the main timeline

**Bot messages never trigger a response.** They are included in the prompt as context so bots know what other bots said, but they don't cause a container spawn.

**Thread participation** — a bot "participates" in a thread if it has previously sent a message there (`is_from_me = 1`). Messages from threads the bot doesn't participate in are excluded from context.

### Message Filtering

Before routing, messages pass through filtering (`message-filtering.ts`):
- **Self-echo** — bots ignore their own messages (`is_from_me` flag + content prefix).
- **Pattern filtering** — messages matching `IGNORE_PATTERNS` (system noise, status messages) are skipped.
- **Sender filtering** — messages from `IGNORE_SENDERS` are hidden entirely (optional, for edge cases).

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
- Typing indicators are always sent, including when the bot is working in a thread.
- Bots with `requiresTrigger` use auto-threading: the triggering message becomes the thread root.

### Status Indicators

Three indicator types, all following the no-redaction principle (edit in place, never delete):

| Indicator | Meaning | Live state | Finished state |
|-----------|---------|------------|----------------|
| `⏳` | Bot is processing | `⏳ working (3m)` | `⏳ worked (3m)` |
| `💤` | Bot is waiting for input | `💤 idling (5m)` | `💤 idled (5m)` |
| `⏳` | Bot is resuming session | `⏳ resuming...` | `⏳ resumed (Xs)` |

Indicators are sent as a message, then edited in place with elapsed time. On boot/restart, bots announce themselves with a single-line status: emoji + name + role + room + model + hostname.

### Brain Management

Each bot's LLM is configured via env (`BRAIN_MODEL`, `BRAIN_OAUTH_TOKEN` / `BRAIN_API_KEY`). Bots can switch models at runtime via the `set_brain_mode` MCP tool + restart.

**Quota fallback:** When the primary provider returns a quota/credit error, the system automatically falls back to Ollama (local model), rewrites the bot's env file, and notifies the Captain. 10-minute cooldown prevents thrashing.

### Session Continuity

On restart, the agent-runner recovers the most recent session to avoid losing conversation context. The host injects a resume message that includes the bot's current todo list so it picks up where it left off without rediscovering tasks from conversation history.

## Configuration

### CLAUDE.md Layers

Bots receive instructions from three CLAUDE.md files:

| Layer | Source | Bot can edit? | Container path |
|-------|--------|---------------|----------------|
| Base | `external/nanoclaw/CLAUDE.md` | No | Concatenated into instance CLAUDE.md |
| Persona | `bots/{role}/{bot}/CLAUDE.md` | Yes | `/workspace/persona/CLAUDE.md` (rw) |
| Room | `bots/{role}/ROOM.md` | No | `/workspace/CLAUDE.md` (ro) |

Base + persona are concatenated into the instance-level CLAUDE.md. Room context is mounted read-only at `/workspace/CLAUDE.md` — Claude CLI finds it via directory traversal from the working directory.

### MCP Configuration

**Source of truth:** `bots/{role}/mcp.json`

Per-role, shared by all bots of that role. Changes take effect on next container spawn.

```
bots/{role}/mcp.json (on disk)
  ↓ read at spawn time by readPersonaGroupMcpServers()
  ↓ passed as mcpServers in ContainerInput JSON via stdin
  ↓ agent-runner passes to Claude SDK query()
  → Claude connects to MCP servers
```

### Mount System

Two-tier design: read-only everywhere, write access where needed.

**Tier 1: Read-only home mirror** — The host home directory is mounted at its real path inside every container, read-only. Bots read files using the same paths as on the host. Added automatically by `container-mounts.ts`.

**Tier 2: Read-write workspace mounts** — Per-bot directories mounted at `/workspace/extra/...` via `container-config.json`. Validated against the host-side allowlist (`~/.config/infiniclaw/allow-list.json`). The Captain grants/revokes temporary mounts via `!allow <path> [minutes]` / `!deny <path>`.

### Secrets

- **No credentials in git.** Bot env files live in the secrets repo (`~/.config/infiniclaw/secrets/`). `.mcp.json` files (may contain OAuth tokens) are gitignored.
- **Secrets flow:** profile env files → loaded by host process → injected as `--env` into containers. Nothing baked into images.
- **Mount allowlist** is stored outside the repo (`~/.config/nanoclaw/mount-allowlist.json`) so containers can't tamper with it.

### Operator Commands

The Captain controls the fleet via `!` commands typed in Matrix. Commands are processed by a lightweight **supervisor** process (one per machine), not by each bot's host process. Each machine's supervisor only acts on its local bots. Untargeted commands (e.g. `!dismiss` with no bot name) are scoped to the room — only bots whose `MAIN_GROUP_NAME` matches the room are affected on each machine.

| Command | Effect |
|---------|--------|
| `!todo` | All bots reply with their task list. |
| `!todo <bot>` | Only that bot replies with its task list. |
| `!dismiss` | Fully stop all bots in the room (process manager stop + container cleanup). |
| `!dismiss <bot>` | Fully stop that bot. |
| `!join` | Fully start all bots assigned to the room (deploy + start via process manager). |
| `!join <bot>` | Fully start that bot. |
| `!restart` | Full stop + redeploy + start for all bots in the room. |
| `!restart <bot>` | Full stop + redeploy + start for that bot. |
| `!roster` | Each machine lists its bots. |
| `!operator <text>` | Send text to operator tmux session. Captain/intercom only. |
| `!allow <bot> <path> [minutes]` | Grant temporary rw mount. Captain/intercom only. |
| `!deny <bot> <path>` | Revoke a mount grant. Captain/intercom only. |

#### Dismiss and Join (`!dismiss` / `!join`)

`!dismiss` and `!join` are full lifecycle commands — there is no dormant mode.

- **`!dismiss`**: Stops the bot via the process manager (pm2 stop + delete), kills any running containers, sends intercom "X has left", sets display name to "X 🔴". The bot process does not stay alive.
- **`!join`**: Deploys fresh code, rebuilds the container image if needed, starts the bot via the process manager, sends intercom "X has joined", sets display name to "X 🟢".

#### Restart (`!restart`)

Full cycle: stop the bot, kill containers, deploy fresh code, rebuild the container image if needed, start the bot via the process manager. Display name briefly shows "X 🔄" during the cycle.

#### Supervisor

A lightweight always-on process, one per machine. The supervisor connects to Matrix rooms via intercom accounts (credentials from `operator/intercom.json`) and watches for `!` commands from the Captain or intercom senders. It manages bot lifecycle by calling service functions directly — no shelling out to the CLI.

Each machine's supervisor only handles its local bots (determined by `machine.json`). Untargeted commands are room-scoped: the supervisor matches the room against each bot's `MAIN_GROUP_NAME` to determine which bots are affected.

Started automatically by `npm run cli start` and runs as a managed process alongside bots.

### Chat Activity Tracking

The host tracks per-room state: current objective, last progress, last completion, last error — all with timestamps, persisted to the database. This provides state continuity across restarts.

### Holodeck

Architects can test changes in isolation before deploying to production. The holodeck creates a git worktree from a feature branch, deploys to a separate instance (`_runtime/instances/{bot}-holodeck/`), and runs as its own launchd service in terminal-only mode (no Matrix). CLI commands: `holodeck create|chat|teardown|promote`. Promote merges the branch and redeploys the live bot.

## Safety

### OOM Handling

When a container exits with OOM (code 137), the system tracks consecutive OOMs per room. After 3 consecutive OOMs, a 60-second cooldown is enforced before the next container spawn. This prevents runaway token burn from restart loops.

**Memory architecture** — three limits must be coordinated:

| Layer | Setting | Purpose |
|-------|---------|---------|
| Container memory | `CONTAINER_MEMORY_MB` in bot env | Podman `--memory`. Hard cgroup limit — kernel kills at this threshold. |
| V8 heap | `NODE_OPTIONS=--max-old-space-size=N` in Dockerfile | Caps V8 old-generation heap. Triggers GC pressure before cgroup kill. |
| Container reservation | `CONTAINER_MEMORY_RESERVATION_MB` in bot env | Podman `--memory-reservation`. Soft limit for scheduling. |

**Rule: V8 heap must be less than container memory.** Leave at least 2GB headroom for the Node.js runtime, MCP servers, spawned subprocesses, and file I/O buffers.

**Prevention layers:**

1. **Session file size cap** — `SESSION_MAX_BYTES` (2MB) in agent-runner. Sessions exceeding this rotate to a fresh session with a summary carried forward.
2. **V8 heap limit** — set in each bot's Dockerfile via `NODE_OPTIONS`. Must be large enough to deserialize a worst-case session but smaller than the container limit.
3. **Host-side OOM handling** — on exit 137, the host clears the session from memory and database (no toxic session loop), tracks consecutive OOMs, enforces cooldown.
4. **Session recovery skill** — bots extract memories from old session files using a Python script (avoids loading large JSONL into the main brain).
5. **Context compaction** — during a running session, a `PreCompact` hook archives the full transcript to `conversations/` before Claude Code compresses context.

**Root cause: session resume.** Claude Code sessions are JSONL files. On resume, the SDK deserializes the entire file — 2-5x the file size in memory due to JavaScript object overhead. A 1.1MB session was enough to OOM a 4GB V8 heap.

**Key settings:** `CONTAINER_MEMORY_MB` (bot env), `NODE_OPTIONS=--max-old-space-size=N` (Dockerfile), `SESSION_MAX_BYTES` (agent-runner), `OOM_MAX_CONSECUTIVE` and `OOM_COOLDOWN_MS` (src/main.ts).

### Restart Cooldown

60-second cooldown enforced between restarts of the same bot via IPC. Prevents bots from burning context in rapid restart cycles.

### Rate Limit Handling

Matrix 429 errors trigger adaptive backoff in the send queue. Messages that exceed Matrix size limits (`M_TOO_LARGE`) are automatically truncated rather than failing.

## Security

- **Container isolation** — Podman containers with memory caps, optional CPU limits. No network egress to arbitrary hosts.
- **Per-room IPC namespaces** — Each room gets its own IPC directory (`_runtime/data/ipc/{room}/`). Prevents cross-room privilege escalation.
- **Main room elevation** — Only the main room's containers can run privileged IPC commands (`restart_bot`, `rebuild_image`, `git_push`). Other rooms are restricted to task scheduling and thread management. IPC commands also have per-command cooldowns.
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

### Intercom System

Cross-room communication uses **intercom relay accounts** — dedicated Matrix accounts, one per room. When a bot or operator sends a message to a different room, it goes through that room's intercom account.

| Room | Intercom Account |
|------|-----------------|
| Bridge | `bridge-intercom` |
| Engineering | `engineering-intercom` |
| Astrometrics | `astrometrics-intercom` |

**Operator usage:** `bash operator/intercom-send.sh <room> "<message>"`. Messages appear as `Operator (<hostname>): <message>`.

**Bot usage (CO only):** Only the CO can use the intercom. `send_message` checks `crew-status.json` at runtime — non-CO bots get an error. Messages appear as `<BotName> (<SourceRoom>): <message>`.

Intercom credentials are stored in `operator/intercom.json` in the secrets repo. Accounts must be joined to their respective rooms on the Matrix homeserver.

### Operator Callout (`!operator`)

The Captain can send commands to a human operator's tmux session from any Matrix room by typing `!operator <text>`. The text is sent as keystrokes to the `operator` tmux session on each machine. If no session exists, one is created with `claude` as the initial command. Captain/intercom only.

Operators also run `inbox-watch.sh` which polls git for cross-machine tasks — the fallback channel when Matrix is down.

## Startup Checklist

Sent automatically to each bot's main room on every boot, wrapped in a collapsible `<details>` block so it doesn't dominate the timeline.

### Sections by role

| Section | All bots | Engineer only | Navigator only |
|---------|----------|---------------|----------------|
| Skills | ✅ | ✅ | ✅ |
| MCP Servers | ✅ | ✅ | ✅ |
| Active Todos | ✅ | ✅ | ✅ |
| Machine Health | — | ✅ (named machine) | — |
| Weekly Goals | — | — | ✅ |
| Knowledge Search (latest entry) | — | — | ✅ |

### Rules

- **All bots** show: Skills table, MCP Servers table, Active Todos table.
- **Engineers** additionally show a Machine Health table. The table header must name the machine explicitly (e.g. `🏥 Machine Health — HERACLES`). Engineers are always in Engineering rooms.
- **Navigators** additionally show:
  1. The Captain's global weekly goal list.
  2. The latest entry from a knowledge search (most recently updated knowledge base item).
- The entire checklist is wrapped in a `<details><summary>` block so it collapses by default.

### Collapsible format

```html
<details>
<summary>🚀 Cid startup checklist</summary>

### 🔧 Skills
...tables...

</details>
```

## Code Structure

InfiniClaw wraps NanoClaw entry points via npm workspaces (`import from 'nanoclaw/config.js'`). See `src/README.md` for the full file map.

| Layer | Location | Purpose |
|-------|----------|---------|
| InfiniClaw host | `src/` | Orchestrator, Matrix channel, container spawning, IPC, CLI |
| NanoClaw framework | `external/nanoclaw/src/` | Container lifecycle, SQLite, queuing, routing, scheduling |
| Container agent | `external/nanoclaw/container/agent-runner/` | Runs inside containers: Claude SDK, MCP tools, IPC |
| Bot definitions | `bots/` | Personas, roles, Dockerfiles, skills |

**Thick wrapper, not plugin hooks.** `main.ts`, `container-spawn.ts`, and `ipc-watcher.ts` are near-total forks of their upstream counterparts. Adding hook/plugin interfaces to NanoClaw was considered and rejected — it would introduce fragile interface coupling and make subtree pulls harder. Since upstream changes infrequently, forking the loop and rewriting directly is the correct design choice at this scale. Any upstream changes are manually ported.

