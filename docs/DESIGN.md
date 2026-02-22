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
- **Network Passthrough (SSL)**: Container agents and host processes must explicitly handle forwarding corporate variables (like `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`) and mounting the host's SSL certificates so they don't fail when routed through company TLS inspection proxies.

### Lobes (delegate agents)

Bots can spawn delegate "lobes" for parallel execution. These are **not separate personas**, but rather **multitasking threads** that operate alongside the main bot:
- `delegate_codex` — OpenAI Codex for scoped file operations
- `delegate_gemini` — Google Gemini for research and analysis
- `delegate_ollama` — Local Ollama models for lightweight tasks
- `delegate_claude` — Anthropic Claude (Planned priority)

Lobe output is streamed to chat and returned to the main brain for integration. While currently underutilized, the lobes system is intended to be an active part of the robust architecture.

**Execution Rules:**
- Any **long-running operations** must be delegated to a lobe rather than blocking the main bot.
- Every lobe activity **must be performed within a thread** to keep the main room channel clear.
- **One-way sync** must be active for all bots to reliably propagate repository skills/config down into the active container sessions.


### Terminology: "room" vs "group"

NanoClaw's code uses "group" internally (from its WhatsApp origins: `group_folder`, `groupJid`, `GROUPS_DIR`, `registered_groups`). InfiniClaw calls these **rooms** in all human-facing text. They are the same thing — a Matrix room mapped to a NanoClaw group.

The `bots/` directory is the **active roster** — the currently deployed roles, their personas, skills, and config. Each entry is a role (commander, engineer), not a specific bot identity.

### Security

- **No credentials in git.** `.mcp.json` files (contain OAuth secrets) and `bots/profiles/*/env` are gitignored.
- **Mount allowlist** at `~/.config/nanoclaw/mount-allowlist.json` — stored outside the repo so containers can't tamper with it. Every mount requested by `container-config.json` is validated against this allowlist before the container spawns. The Captain can grant/revoke temporary mounts via `CAPTAIN_USER_ID`.
- **Per-room IPC namespaces** — each room gets its own IPC directory under `_runtime/data/ipc/{room}/`. Prevents cross-room privilege escalation.
- **Main room elevation** — only the main room's containers can run privileged IPC commands (`restart_bot`, `rebuild_image`, `git_push`, etc.). Non-main rooms are restricted to task scheduling and their own thread management.
- **Container isolation** — Podman containers run with memory caps (`CONTAINER_MEMORY_MB`, default 4GB) and optional CPU limits. `_runtime/` is never version-controlled.
- **Secrets flow**: profile env files → loaded by host process → injected as env vars into containers via `--env`. No secrets are baked into container images.

## Code Structure

### Host process (`nanoclaw/src/`)

| File | Origin | Purpose |
|------|--------|---------|
| `index.ts` | NanoClaw | Orchestrator: startup, channel connection, message loop, working indicator, session management |
| `service.ts` | **InfiniClaw** | CLI operations: start, stop, chat, send, deployBot, syncPersona, restorePersona |
| `cli.ts` | **InfiniClaw** | CLI entry point: parses `start\|stop\|chat\|send` |
| `container-runner.ts` | NanoClaw | Builds Podman args, spawns containers, streams output, mounts, skill/MCP sync |
| `task-scheduler.ts` | NanoClaw | 60s poll loop for due tasks, spawns containers, forwards progress to chat |
| `group-queue.ts` | NanoClaw | Per-room concurrency: ensures one container per room, queues overflow, retry backoff |
| `ipc.ts` | NanoClaw | Processes IPC commands from containers (restart, schedule, register, etc.) |
| `db.ts` | NanoClaw | SQLite: messages, sessions, registered rooms, scheduled tasks, task runs |
| `router.ts` | NanoClaw | Outbound message routing, cross-bot forwarding, message formatting |
| `config.ts` | NanoClaw | All env-driven configuration (intervals, paths, limits, trigger patterns) |
| `mount-security.ts` | NanoClaw | Validates container mounts against host-side allowlist |
| `skill-sync.ts` | **InfiniClaw** | One-way skill copy: persona + shared → container session on each spawn |
| `mcp-sync.ts` | **InfiniClaw** | Two-way MCP server sync: save-back from container, then restore from persona |
| `status.ts` | **InfiniClaw** | Bot status reporting and status message management |
| `logger.ts` | NanoClaw | Pino logger |
| `types.ts` | NanoClaw | Shared types: Channel, RegisteredGroup, ScheduledTask, MountAllowlist |
| `channels/matrix.ts` | **InfiniClaw** | Matrix channel: connect, send, edit, react, redact, sync |
| `channels/whatsapp.ts` | NanoClaw | WhatsApp channel (Baileys) |
| `channels/local-cli.ts` | **InfiniClaw** | Terminal channel for `cli chat` |

### Container agent (`nanoclaw/container/agent-runner/`)

Runs inside each Podman container. Receives a prompt via stdin JSON, calls Claude Agent SDK, streams output via stdout JSON lines, reads follow-up messages from IPC input directory.

### Key data flows

```
User message → Matrix → index.ts message loop → SQLite → processGroupMessages()
  → container-runner.ts spawns Podman container
    → agent-runner calls Claude SDK → streams JSON lines to stdout
  → index.ts reads stdout → forwards to Matrix (progress + results)
  → working indicator: 🔧 working... → edits with elapsed time → checkpoint

Scheduled task → task-scheduler.ts poll → group-queue.ts
  → same container-runner.ts spawn path
  → task-scheduler.ts reads stdout → forwards to Matrix

IPC command → container writes JSON to /workspace/ipc/output/
  → ipc.ts watches directory → processes command → writes response
```
