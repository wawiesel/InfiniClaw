# InfiniClaw Design

## Purpose

InfiniClaw is a multi-bot orchestration layer built on a maintained NanoClaw fork. It provides cooperating bots on Matrix:

- `engineer` aka **Cid** — chief engineer, infra + operations + lifecycle control
- `commander` aka **Johnny5** — commander, takes orders and executes tasks

The operator (Captain) gives orders to Johnny5 in the Bridge. Cid works in Engineering, responding when addressed with `@Cid`.

## Roles

### Operator (Captain)
- Gives orders in the Bridge and Engineering
- Addresses Johnny5 directly for task execution
- Addresses Cid with `@Cid` for infrastructure work

### Commander — Johnny5 (`@Johnny5`)
- Takes orders in the Bridge — responds to everything except `@Cid` callouts
- The Bridge is Johnny5's main room (`requiresTrigger: false`)
- Sees ALL messages (no code-level filtering) — decides what to respond to via CLAUDE.md
- Can modify his own persona CLAUDE.md and skills via writable mount
- `$HOME/_vault` mounted read-write

### Engineer — Cid (`@Cid`)
- Works in Engineering, responds when addressed with `@Cid`
- Can modify all bots' personas, skills, and source code
- Manages infrastructure, builds, and deployments
- InfiniClaw repo mounted read-write

## Core Principles

1. **Single platform, separate product** — Runtime changes live in the NanoClaw fork. Product-specific policy and per-bot packaging live in InfiniClaw.

2. **Script-first operations** — Setup and runtime must be executable from scripts. LLM/skills are wrappers over deterministic scripts.

3. **Runtime state isolation** — Code is versioned; runtime state is not. Bot state is isolated per instance under `_runtime/instances/`.

4. **Explicit ownership and boundaries** — Cid manages container/runtime and can patch any bot. Other bots manage their own persona and skills.

## Architecture

### Runtime model

Sibling NanoClaw host processes managed by launchd:
- `com.infiniclaw.engineer` → `$INFINICLAW/_runtime/instances/engineer/nanoclaw/`
- `com.infiniclaw.commander` → `$INFINICLAW/_runtime/instances/commander/nanoclaw/`

Each host process spawns agent-runner containers (via Podman) for task execution.

### Bot instructions (CLAUDE.md)

Each bot has one CLAUDE.md assembled at deploy time from two sources:

1. **Base** (`nanoclaw/CLAUDE.md`) — framework instructions common to all bots
2. **Persona** (`bots/personas/{bot}/CLAUDE.md`) — identity, rules, and style for that bot

On deploy, the persona is appended to the base, producing a single `CLAUDE.md` in the instance. Each bot has one main room. Group-level context files (`bots/personas/{bot}/groups/main/CLAUDE.md`) are seeded into the instance's groups directory.

Bots can edit their own persona CLAUDE.md at runtime via a writable mount. To update externally: stop the bot, edit the file in the repo, restart.

### Sync directions

| Artifact | Direction | Bot can edit? |
|----------|-----------|---------------|
| Group CLAUDE.md | Repo → bot | No (read-only seed) |
| Persona CLAUDE.md | Two-way | Yes (writable mount) |
| Skills | One-way (persona+shared → session) | Yes (writes to persona dir, loaded on next spawn) |
| MCP servers | Two-way | Yes (save-back container → persona on spawn) |

### Container images

| Image | Bot | Purpose |
|-------|-----|---------|
| `nanoclaw-engineer:latest` | Cid | Lean — git, ripgrep, Python3, Claude Code |
| `nanoclaw-commander:latest` | Johnny5 | Full — browser, Python, OCR, build tools, data analysis |

### Container mounts

| Mount | Container path | Access | Notes |
|-------|---------------|--------|-------|
| Group folder | `/workspace/group` | read-write | Working directory |
| Claude sessions | `/home/node/.claude` | read-write | Settings, skills, MCP, memory |
| Persona dir | `/workspace/extra/{bot}-persona` | read-write | Persona CLAUDE.md, skills |
| Project root | `/workspace/project` | read-write | Main group only |
| IPC namespace | `/workspace/ipc` | read-write | Per-group isolated |
| Global memory | `/workspace/global` | read-only (non-main) | Cross-group shared state |
| Env/secrets | `/workspace/env-dir` | read-only | Runtime secrets |
| Cache | `/workspace/cache` | read-write | Model/build cache |
| Additional mounts | `/workspace/extra/*` | varies | From container-config.json |

Mount security enforced by `$HOME/.config/nanoclaw/mount-allowlist.json` (host-side, tamper-proof from containers).

### Cross-bot communication

Bots communicate across rooms using trigger-based forwarding:
- `@Johnny5 <message>` in Engineering → forwarded to Bridge
- `@Cid <message>` in Bridge → forwarded to Engineering
- Messages appear as `[From {Room}] sender: content`

Configured via `CROSS_BOT_TRIGGER` / `CROSS_BOT_ROOM_JID` in profile env.

### Lobes (delegate agents)

Bots can spawn delegate "lobes" for parallel execution:
- `delegate_codex` — OpenAI Codex for scoped file operations
- `delegate_gemini` — Google Gemini for research and analysis
- `delegate_ollama` — Local Ollama models for lightweight tasks

Lobe output is streamed to chat and returned to the main brain for integration.

### Scheduled tasks

The host process runs a scheduler loop (60s poll interval) that:
1. Checks SQLite for tasks with `next_run <= now` and `status = 'active'`
2. Enqueues them on the group queue (respects concurrency limits)
3. Spawns a container with the task prompt
4. Forwards progress and results to the task's chat room
5. Computes next run (cron/interval) and updates the DB

Tasks support `cron`, `interval`, and `once` schedule types. Bots create/pause/cancel tasks via IPC commands.

### Message flow

Two paths through the system:

1. **User message** → stored in SQLite → message loop (250ms poll) → `processGroupMessages()` → spawns container → streams progress + results to chat → working indicator in Matrix
2. **Scheduled task** → scheduler (60s poll) → group queue → spawns container → streams progress + results to chat

Both paths use the same `runContainerAgent()` function but different output handlers.

### Working indicator

When a bot is processing, the host sends a `🔧 working...` message to Matrix, then edits it every 30s with elapsed time. On completion it becomes `🔧 checkpoint (Xm)`.

### Session resume

Each container gets a Claude Agent SDK session ID stored in SQLite. On restart, the session ID is passed to the new container so it can resume with full conversation history. An `injectResumeMessage` is sent to the group to prompt the bot to check for in-progress work.

### Process topology

```
Mac Host (launchd)
├── com.infiniclaw.engineer → node $INFINICLAW/_runtime/instances/engineer/nanoclaw/dist/index.js
│   ├── Connects to Matrix as @cidolfus-bot (Cid)
│   ├── Responds to @Cid in Engineering
│   ├── Spawns nanoclaw-engineer containers for tasks
│   └── Can restart any bot via IPC
│
├── com.infiniclaw.commander → node $INFINICLAW/_runtime/instances/commander/nanoclaw/dist/index.js
│   ├── Connects to Matrix as @johnny5-bot (Johnny5)
│   ├── Takes orders in the Bridge
│   └── Spawns nanoclaw-commander containers for tasks
│
└── $HOME/.config/nanoclaw/mount-allowlist.json (shared, host-side)
```

## Directory structure

```text
$INFINICLAW/
  CLAUDE.md                     Development directives (not picked up by bots)
  README.md
  .gitignore
  nanoclaw/                     NanoClaw fork (git subtree from wawiesel/nanoclaw)
    CLAUDE.md                   Base bot instructions (framework layer)
    src/                        Platform source (TypeScript)
    container/
      agent-runner/             In-container agent runner
      skills/                   Shared skills (all bots)
  bots/
    personas/
      {bot}/CLAUDE.md           Bot identity and rules
      {bot}/skills/             Bot-specific skills
      {bot}/mcp-servers/        Bot-specific MCP servers
      {bot}/container-config.json  Additional mounts + declarative MCP
      {bot}/groups/{group}/     Group context (one-way: repo → bot)
    profiles/
      {bot}/env                 Bot env config (gitignored)
    container/
      {bot}/Dockerfile          Per-bot agent container image
      build.sh                  Build one or all container images
    config/
      mount-allowlist.json      Template for $HOME/.config/nanoclaw/
  docs/
    DESIGN.md                   This file
    assets/                     Images, banners
  _runtime/                     Gitignored runtime state
    instances/                  Per-bot runtime instances (synced from nanoclaw/)
    data/                       SQLite, sessions, IPC, cache
    logs/                       Bot stdout/stderr logs
    staging/                    Deploy validation staging area
```

## Operations

### First-time setup

1. Configure profiles: `$INFINICLAW/bots/profiles/{bot}/env`
2. Build container images: `$INFINICLAW/bots/container/build.sh all`
3. Start: `cd $INFINICLAW/nanoclaw && npm run cli start`

### Start / Stop

- `npm run cli start` — deploys code, installs launchd plists, starts all bots
- `npm run cli stop` — syncs personas, unloads launchd plists, stops containers

### Interactive chat

- `npm run cli chat <bot>` — terminal chat with any bot (mirrors to Matrix)

### Send message

- `npm run cli send <room> <message>` — send operator message to a bot's room

### IPC commands (from containers)

| Command | Access | Effect |
|---------|--------|--------|
| `restart_bot` | Main only | Self: validate TS → exit → launchd restarts. Other: deploy → kickstart |
| `stop_bot` | Main only | Stop another bot's launchd service |
| `rebuild_image` | Main only | Run `bots/container/build.sh {bot}` |
| `bot_status` | Main only | Return launchctl status + recent error log |
| `git_push` | Main only | Push current branch to remote |
| `schedule_task` | Any | Create a scheduled task (cron/interval/once) |
| `pause_task` | Any | Pause a scheduled task |
| `resume_task` | Any | Resume a paused task |
| `cancel_task` | Any | Cancel a scheduled task |
| `refresh_groups` | Main only | Reload registered groups from DB |
| `register_group` | Main only | Register a new Matrix room |
| `set_brain_mode` | Main only | Switch AI model for a bot |
| `set_thread` | Any (own group) | Set work thread for a group |

### Deployment workflow (Cid)

1. **Code changes**: Edit `$INFINICLAW/nanoclaw/src/`, then `restart_bot`.
2. **Container image changes**: Edit Dockerfile, then `restart_bot` (deploys first, then rebuilds if Dockerfile changed).
3. **Persona/skill changes**: Edit in persona dir, then `restart_bot` for the target bot.

## Security posture

- No credentials in git (`.mcp.json` files gitignored).
- Runtime secrets sourced from env and local secure stores.
- `_runtime/` excluded from version control.
- Mount allowlist stored outside project root (tamper-proof from containers).
- Per-group IPC namespaces prevent cross-group privilege escalation.
- Least-privilege execution by role. Main group gets elevated IPC access.
