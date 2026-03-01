# InfiniClaw Design

## Purpose

InfiniClaw is a multi-bot orchestration layer built on a maintained NanoClaw fork. It provides cooperating bots on Matrix:

Messages go to **rooms**, not to bots directly. Each room has a role; bots fill that role.

Rooms:

1. **The Bridge** — has a commander. Current commander: **Johnny5**.
2. **Engineering** — has an engineer. Current engineer: **Cid**.
3. **Holodeck** — testing room for new bots (not yet active).


## Roles

### Commander
- Responsible for exploring the file system, executing tasks, and reporting back to the captain
- Can modify his own persona CLAUDE.md, skills, and MCP
- Cannnot modify another bot's persona, skills, or MCP
- Has write access to the knowledge vault
- Uses WKS MCP tools to manipulate/explort file system and connect in the knowledge vault
- Has read access to entire home directory

### Engineer 
- Responsible for Infiniclaw codebase including updating nanoclaw underneath our updates
- Responsible for maintaining bot containers
- Can modify his own persona CLAUDE.md, skills, and MCP
- Can modify another bot's persona, skills, and MCP
- Can deploy and test new bots on the Holodeck
- Has read access to entire home directory
- Has write access to the Infiniclaw codebase

## Core Principles

- Use everything from Nanoclaw possible
- We layer our own logic on top of Nanoclaw
  - We use Matrix for communication
  - We use Podman for container management
  - We use WKS MCP tools for file system manipulation
- We have the lobe concept where a bot can spawn a delegate agent that merges back into the main bot using Matrix threads
- Bots must be responsive at all times. Matrix features like emoji and reactions help with this.
- The base bot is Claude based and can upgrade/downgrade his brain by himself.
- **Output Formatting & Math**: All tool calls are rendered as collapsible blocks showing their input and output. Escaped newlines (`\n`) are preserved. Matrix environments must natively support robust rendering for mathematical equations (e.g. MathJax) wherever the LLM outputs LaTeX equivalents.
- **System Actions**: Any message that is not a direct response to a conversation (e.g., restarts, working hourglass, brain reload, start up) must be prefixed with an emoji.
- **No redactions.** Status messages are never deleted or redacted. They have a "live" state while active and a "finished" state when done. This preserves a readable timeline — e.g., `⏳ working (3m)` → `⏳ worked (3m)`, `💤 idling (5m)` → `💤 idled (5m)`.
- **Network Passthrough (SSL)**: Container agents and host processes must explicitly handle forwarding corporate variables (like `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`) and mounting the host's SSL certificates so they don't fail when routed through company TLS inspection proxies.
- **Work with Claude Code, not against it.** Bots run on the Claude Agent SDK. When the SDK has a preferred way to do something (tools, memory, task tracking), use it or sync from it — don't fight it with competing systems. If the SDK introduces a new tool that overlaps with ours, prefer one-way sync from the SDK's system over blocking it. Blocking is a last resort.

### Lobes (delegate agents)

Bots can spawn delegate "lobes" for parallel execution via two tools:
- `delegate_to_lobe` — Atomic delegation with Matrix threading. Supports codex (OpenAI), gemini (Google), claude (Anthropic), and ollama (local) lobes.
- `query_local_llm` — Quiet one-shot Ollama query for formatting, classification, extraction. No chat output.

Lobe output is streamed to chat and returned to the main brain for integration.

**Execution Rules:**
- Any **long-running operations** must be delegated to a lobe rather than blocking the main bot.
- Every lobe activity **must be performed within a thread** to keep the main room channel clear.
- **One-way sync** must be active for all bots to reliably propagate repository skills/config down into the active container sessions.


### Terminology: "room" vs "group"

NanoClaw's code uses "group" internally (from its WhatsApp origins: `group_folder`, `groupJid`, `GROUPS_DIR`, `registered_groups`). InfiniClaw calls these **rooms** in all human-facing text. They are the same thing — a Matrix room mapped to a NanoClaw group.

The `bots/` directory is the **active roster** — the currently deployed roles, their personas, skills, and config. Each entry is a role (commander, engineer), not a specific bot identity.

### CLAUDE.md layers

Bots receive instructions from three CLAUDE.md files, assembled at different stages:

**1. Base** (`external/nanoclaw/CLAUDE.md`) — framework instructions shared by all bots. Copied to `instance/CLAUDE.md` during deploy.

**2. Persona** (`bots/personas/{bot}/CLAUDE.md`) — bot identity, rules, capabilities. Appended to `instance/CLAUDE.md` during deploy (so the agent sees base + persona as one file).

**3. Group** (`bots/personas/{bot}/groups/{room}/CLAUDE.md`) — per-room context. Copied to `instance/groups/{room}/CLAUDE.md` during deploy. The container mounts `instance/groups/{room}/` as `/workspace/group/` (the SDK's cwd), so the agent loads this as the project-level CLAUDE.md.

The agent sees **all three** — base+persona as the instance-level CLAUDE.md (loaded via `systemPrompt` or the root CLAUDE.md path), and group as the project-level CLAUDE.md in its working directory.

**Editability from inside a container:**

| Layer | Bot can edit? | How |
|-------|--------------|-----|
| Base | No | Read-only in the instance |
| Persona | Yes | Writable mount at `/workspace/extra/{bot}-persona/CLAUDE.md`. Changes persist directly to `bots/personas/{bot}/CLAUDE.md` in the repo. |
| Group | No (read-only copy) | The container gets a copy in `/workspace/group/CLAUDE.md`. Edits affect the running session only — they're overwritten on next deploy. Source of truth is `bots/personas/{bot}/groups/{room}/CLAUDE.md` in the repo. |

**Deploy flow:** `rsyncInstance()` copies code → `restorePersona()` appends persona to base and seeds group files.

**Restart flow:** `syncPersona()` runs (currently a guard only), then redeploy runs `restorePersona()` again with the latest persona content. Skills are one-way (persona → session). MCP config is read from persona at spawn time (see MCP Configuration below).

### MCP Configuration

**Source of truth:** `bots/personas/{bot}/groups/{group}/.mcp.json`

This is the ONE file that matters. Bots can edit it (writable persona mount). The operator can edit it on the host. There is no merge — **last writer wins**.

**How it flows:**

```
Persona .mcp.json (on disk)
  ↓ read at spawn time by readPersonaGroupMcpServers()
  ↓ passed as mcpServers in ContainerInput JSON via stdin
  ↓ agent-runner passes to Claude SDK query()
  → Claude connects to MCP servers
```

**Two config mechanisms (don't confuse them):**

| Mechanism | Source | What it configures | When read |
|-----------|--------|-------------------|-----------|
| SDK passthrough | Persona `.mcp.json` `mcpServers` | SSE/URL-based servers (host-side services) | Container spawn |
| `mcp-sync.ts` | Persona `mcp-servers/{name}/mcp.json` | Command-based servers (in-container) | Deploy (`loadMcpServersToSettings`) |

Both merge into the SDK's `mcpServers` at different stages. The persona `.mcp.json` is for external servers (SSE endpoints on the host). The `mcp-servers/` directory is for servers that run inside the container.

**Bot edits:**

Bots edit `/workspace/extra/{bot}-persona/groups/{group}/.mcp.json` inside the container. This is a bind mount to the real persona file — edits persist immediately to the host filesystem. Changes take effect on the next container spawn (the running container already has its SDK config baked in from spawn time).

**Rules:**
- The persona `.mcp.json` is authoritative. Never override it with a stale copy.
- `enableAllProjectMcpServers: true` in `settings.json` also causes Claude Code to discover `.mcp.json` files in the project tree. These are additive, not a separate source of truth.
- `container-config.json` holds non-MCP container config (ports, mounts). Not MCP servers.
- On restart, the host re-reads the persona `.mcp.json`. Whatever the bot last wrote is what the next container gets.

### Security

- **No credentials in git.** `.mcp.json` files (contain OAuth secrets) and `bots/profiles/*/env` are gitignored.
- **Mount allowlist** at `~/.config/nanoclaw/mount-allowlist.json` — stored outside the repo so containers can't tamper with it. Every mount requested by `container-config.json` is validated against this allowlist before the container spawns. The Captain can grant/revoke temporary mounts via `CAPTAIN_USER_ID`.
- **Per-room IPC namespaces** — each room gets its own IPC directory under `_runtime/data/ipc/{room}/`. Prevents cross-room privilege escalation.
- **Main room elevation** — only the main room's containers can run privileged IPC commands (`restart_bot`, `rebuild_image`, `git_push`, etc.). Non-main rooms are restricted to task scheduling and their own thread management.
- **Container isolation** — Podman containers run with memory caps (`CONTAINER_MEMORY_MB`, default 12GB) and optional CPU limits. The podman VM memory must exceed the container limit to leave headroom for the VM kernel and page cache (e.g. 24GB VM for a 16GB container). `_runtime/` is never version-controlled.
- **One container per bot** — There must never be multiple containers running for the same bot. `group-queue.ts` enforces one-at-a-time per room, but stale containers can accumulate from crashes or unclean shutdowns. The host process must clean up any existing container for a bot before spawning a new one.
- **Secrets flow**: profile env files → loaded by host process → injected as env vars into containers via `--env`. No secrets are baked into container images.

### Mount System

Two-tier design: read-only access everywhere, write access where needed.

**Tier 1: Read-only home mirror (built-in)**
- The host home directory is mounted at its real path (`/Users/ww5`) inside every container, read-only.
- Bots can read any file using the same path as on the host.
- Dotfiles are visible but read-only. Sensitive credentials (SSH keys, tokens) cannot be exfiltrated because the container has no network egress to arbitrary hosts.
- Added automatically by `container-mounts.ts` — not configurable per-bot.

**Tier 2: Read-write workspace mounts (per-bot)**
- Specific directories are mounted read-write at `/workspace/extra/...` via `container-config.json`.
- Validated against the host-side allowlist (`~/.config/nanoclaw/mount-allowlist.json`).
- The Captain can grant/revoke temporary rw access via `!allow <path> [minutes]` / `!deny <path>`.
- Each bot gets only the rw mounts it needs:
  - Commander: `~/_vault` (rw), `~/InfiniClaw/bots/profiles/commander` (rw)
  - Engineer: `~/2026-Nanoclaw/InfiniClaw` (rw)

## Code Structure

**Architectural Strategy: Thin Fork & Thick Wrappers**
InfiniClaw is built on top of the upstream NanoClaw framework located in `external/nanoclaw/` (a git subtree). The goal is to keep `external/nanoclaw/` as a "super thin fork" that can be cleanly patched and merged from upstream.

To accomplish this, `src/` (InfiniClaw) optimally builds on top of NanoClaw by wrapping its entry points (`main.ts` wrapping `index.ts`, `container-spawn.ts` wrapping `container-runner.ts`) or inserting plugin/hook calls. While this introduces some understandable duplication, it isolates InfiniClaw-specific logic (like the matrix channel, custom IPC commands, and secrets proxying) from the core framework.

InfiniClaw imports upstream modules via npm workspaces (`import from 'nanoclaw/config.js'`).

### InfiniClaw source (`src/`)

| File | Purpose |
|------|---------|
| `main.ts` | Orchestrator: startup, channel connection, message loop, working indicator |
| `cli.ts` | CLI entry point: parses `start\|stop\|chat\|send` |
| `service.ts` | CLI operations: start, stop, chat, send, deployBot, syncPersona, restorePersona |
| `container-spawn.ts` | Spawn Podman containers with InfiniClaw mounts/secrets |
| `ipc-watcher.ts` | IPC polling with extended message types and commands |
| `ipc-commands.ts` | Extended IPC command handlers |
| `brain-management.ts` | Brain mode switching (model selection) |
| `chat-activity.ts` | Chat activity tracking and idle detection |
| `message-filtering.ts` | Message deduplication and filtering |
| `conversation-log.ts` | Conversation logging to disk |
| `container-mounts.ts` | InfiniClaw-specific container volume mounts |
| `container-secrets.ts` | Provider secret normalization and cert mapping |
| `podman-bootstrap.ts` | Podman machine setup and validation |
| `skill-sync.ts` | One-way skill copy: persona + shared → container session on each spawn |
| `mcp-sync.ts` | Two-way MCP server sync: save-back from container, then restore from persona |
| `status.ts` | Bot status reporting and status message management |
| `channels/matrix.ts` | Matrix channel: connect, send, edit, react, redact, sync |
| `channels/local-cli.ts` | Terminal channel for `cli chat` |

### NanoClaw upstream (`external/nanoclaw/src/`)

| File | Purpose |
|------|---------|
| `config.ts` | All env-driven configuration (intervals, paths, limits, trigger patterns) |
| `db.ts` | SQLite: messages, sessions, registered rooms, scheduled tasks, task runs |
| `router.ts` | Outbound message routing, cross-bot forwarding, message formatting |
| `container-runner.ts` | Builds Podman args, spawns containers, streams output |
| `task-scheduler.ts` | 60s poll loop for due tasks, spawns containers, forwards progress to chat |
| `group-queue.ts` | Per-room concurrency: ensures one container per room, queues overflow, retry backoff |
| `mount-security.ts` | Validates container mounts against host-side allowlist |
| `env-utils.ts` | Environment variable helpers |
| `podman-utils.ts` | Podman CLI helpers |
| `logger.ts` | Pino logger |
| `types.ts` | Shared types: Channel, RegisteredGroup, ScheduledTask, MountAllowlist |
| `channels/whatsapp.ts` | WhatsApp channel (Baileys) |

### Container agent (`external/nanoclaw/container/agent-runner/`)

Runs inside each Podman container. Receives a prompt via stdin JSON, calls Claude Agent SDK, streams output via stdout JSON lines, reads follow-up messages from IPC input directory.

### Message Queue Architecture

InfiniClaw uses a **FIFO (first-in, first-out)** queue per room. This is intentional.

**Decision: FIFO over priority/interrupt**

We considered interrupt-style scheduling (thread messages preempt main-room work) but chose FIFO for now:

| Approach | Pros | Cons |
|----------|------|------|
| FIFO (current) | Simple, predictable, no starvation | Long main task blocks thread replies |
| Priority/interrupt | Thread feels responsive even during long tasks | Complex state management, risk of starvation, harder to reason about |

FIFO is the right starting point. If latency in threads becomes a real problem, we can layer priority on top — but we don't pay that complexity cost until we need it.

**Threading model**

- Every lobe operation runs inside a Matrix thread (not on the main timeline)
- Typing indicators are suppressed on the main room when the bot is working in a thread. This means bots that always work in threads (e.g. `requiresTrigger` bots using auto-threading) will never show "typing" in the room.
- The bot maintains a single sequential "big brain" — lobes provide parallelism for delegated subtasks, not for splitting the main agent
- Lobe drafts are staged to `/workspace/group/drafts/` for review before posting

### Key data flows

```
User message → Matrix → main.ts message loop → SQLite → processGroupMessages()
  → container-runner.ts spawns Podman container
    → agent-runner calls Claude SDK → streams JSON lines to stdout
  → main.ts reads stdout → forwards to Matrix (progress + results)
  → working indicator: ⏳ working... → ⏳ working (Xm) → ⏳ worked (Xm)

Scheduled task → task-scheduler.ts poll → group-queue.ts
  → same container-runner.ts spawn path
  → task-scheduler.ts reads stdout → forwards to Matrix

IPC command → container writes JSON to /workspace/ipc/output/
  → ipc-watcher.ts watches directory → processes command → writes response
```
