# InfiniClaw Design

## Purpose

InfiniClaw is a multi-bot orchestration layer built on top of a maintained NanoClaw fork. It provides cooperating bots on Matrix:

- `engineer` aka **Cid** — chief engineer, infra + operations + lifecycle control
- `commander` aka **Johnny5** — commander, takes orders and executes tasks
- `hologram` aka **Albert** — test entity, lives in the Holodeck for validation

The operator (Captain) gives orders to Johnny5 in the Bridge. Cid works in Engineering, responding when addressed with `@Cid`. Albert runs in the Holodeck for testing new features before promotion to production.

## Roles

### Operator (Captain)
- Gives orders in the Bridge and Engineering
- Addresses Johnny5 directly for task execution
- Addresses Cid with `@Cid` for infrastructure work
- Tests new features with Albert in the Holodeck

### Commander — Johnny5 (`@Johnny5`)
- Takes orders in the Bridge — responds to everything except `@Cid` callouts
- The Bridge is Johnny5's main room (`requiresTrigger: false`)
- Sees ALL messages (no code-level filtering) — decides what to respond to via CLAUDE.md
- Can modify his own persona CLAUDE.md and skills (two-way sync)
- `$HOME` mounted read-only; `$HOME/_vault` mounted read-write

### Engineer — Cid (`@Cid`)
- Works in Engineering, responds when addressed with `@Cid`
- Can modify all bots' personas, skills, and source code
- Manages infrastructure, builds, and deployments
- InfiniClaw repo mounted read-write

### Hologram — Albert (`@Albert`)
- Lives in the Holodeck — isolated testing environment
- Uses engineer's container image with Ollama brain (local models)
- Can modify his own persona CLAUDE.md and skills (two-way sync)

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
- `com.infiniclaw.hologram` → `$INFINICLAW/_runtime/instances/hologram/nanoclaw/`

Each host process spawns agent-runner containers (via Podman) for task execution.

### Persona system (three-layer CLAUDE.md)

Bot identity is version-controlled in `bots/personas/`:

1. **Base** (`$INFINICLAW/nanoclaw/CLAUDE.md`) — Framework: how NanoClaw works, IPC, status messages. All bots get this.
2. **Persona** (`$INFINICLAW/bots/personas/{bot}/CLAUDE.md`) — Identity: who you are, your rules, your style. **Two-way sync**: bots can edit their own persona CLAUDE.md via writable mount.
3. **Group** (`$INFINICLAW/groups/{group}/CLAUDE.md`) — Room context: capabilities, accumulated memory. **One-way sync**: repo → bot, read-only in containers.

On deploy, persona CLAUDE.md is appended to the instance's base CLAUDE.md. Group files are seeded from the persona to the instance. Skills and MCP servers sync bidirectionally on every container spawn.

### Sync directions

| Artifact | Direction | Bot can edit? | Persists across restart? |
|----------|-----------|---------------|--------------------------|
| Group CLAUDE.md | Repo → bot | No | N/A (read-only) |
| Persona CLAUDE.md | Two-way | Yes | Yes (writable mount) |
| Skills | Two-way | Yes | Yes (sync on spawn) |
| MCP servers | Two-way | Yes | Yes (sync on spawn) |

To update a bot's persona CLAUDE.md externally: stop the bot, edit the file in the repo, restart. Otherwise the bot's runtime version takes precedence.

### Container images

| Image | Bots | Purpose |
|-------|------|---------|
| `nanoclaw-engineer:latest` | Cid, Albert | Lean — git, ripgrep, Python3, Claude Code |
| `nanoclaw-commander:latest` | Johnny5 | Full — browser, Python, OCR, build tools, data analysis |

### Container mounts

| Mount | Container path | Access | Notes |
|-------|---------------|--------|-------|
| Group folder | `/workspace/group` | read-write | Working directory |
| Claude sessions | `/home/node/.claude` | read-write | Settings, skills, MCP, memory |
| Persona dir | `/workspace/extra/{bot}-persona` | read-write | Persona CLAUDE.md, skills, MCP |
| Project root | `/workspace/project` | read-write | Main group only (Cid) |
| IPC namespace | `/workspace/ipc` | read-write | Per-group isolated |
| Additional mounts | `/workspace/extra/*` | varies | From container-config.json |

Mount security is enforced by `$HOME/.config/nanoclaw/mount-allowlist.json` (host-side, tamper-proof from containers).

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
├── com.infiniclaw.hologram → node $INFINICLAW/_runtime/instances/hologram/nanoclaw/dist/index.js
│   ├── Connects to Matrix as @albert-bot (Albert)
│   ├── Tests features in the Holodeck
│   └── Spawns nanoclaw-engineer containers (Ollama brain)
│
└── $HOME/.config/nanoclaw/mount-allowlist.json (shared, host-side)
```

## Directory structure

```text
$INFINICLAW/
  README.md
  .gitignore
  nanoclaw/                   NanoClaw fork (git subtree from wawiesel/nanoclaw)
    src/                      Platform source (TypeScript)
    container/
      agent-runner/           In-container agent runner
      skills/                 Shared skills (all bots)
  bots/
    personas/
      {bot}/CLAUDE.md         Bot identity and rules (two-way sync)
      {bot}/skills/           Bot-specific skills (two-way sync)
      {bot}/mcp-servers/      Bot-specific MCP servers (two-way sync)
      {bot}/container-config.json  Additional mounts + declarative MCP
      {bot}/groups/{group}/   Room context (one-way: repo → bot)
    profiles/
      {bot}/env               Bot env config (gitignored)
    container/
      {bot}/Dockerfile        Per-bot agent container image
      build.sh                Build one or all container images
    config/
      mount-allowlist.json    Template for $HOME/.config/nanoclaw/
  groups/                     Group working directories
  docs/
    DESIGN.md                 This file
    assets/                   Images, banners
  _runtime/                   Gitignored runtime state
    instances/                Per-bot runtime instances (synced from nanoclaw/)
    data/                     SQLite, sessions, IPC, cache
    logs/                     Bot stdout/stderr logs
    staging/                  Deploy validation staging area
```

## Operations

### First-time setup

1. Configure profiles: `$INFINICLAW/bots/profiles/{bot}/env`
2. Build container images: `$INFINICLAW/bots/container/build.sh all`
3. Start: `cd $INFINICLAW/nanoclaw && npm run cli start`

### Start / Stop

- `cd $INFINICLAW/nanoclaw && npm run cli start` — deploys code, installs launchd plists, starts all bots
- `cd $INFINICLAW/nanoclaw && npm run cli stop` — syncs personas, unloads launchd plists, stops containers

### Interactive chat

- `cd $INFINICLAW/nanoclaw && npm run cli chat <bot>` — terminal chat with any bot (mirrors to Matrix)

### IPC commands (from engineer containers)

| Command | Effect |
|---------|--------|
| `restart_bot` (self) | Validate TS → exit → launchd restarts |
| `restart_bot` (other) | Deploy instance → launchctl kickstart |
| `rebuild_image` | Run `bots/container/build.sh {bot}` |
| `bot_status` | Return launchctl status + recent error log |

### Deployment workflow (Cid)

1. **Code changes**: Edit `$INFINICLAW/nanoclaw/src/`, then `restart_bot`.
2. **Container image changes**: Edit Dockerfile, then `restart_bot` (deploys first, then rebuilds image).
3. **Persona/skill changes**: Edit in persona dir, then `restart_bot` for the target bot.

## Security posture

- No credentials in git.
- Runtime secrets sourced from env and local secure stores.
- `_runtime/` excluded from version control.
- Mount allowlist stored outside project root (tamper-proof from containers).
- Per-group IPC namespaces prevent cross-group privilege escalation.
- Least-privilege execution by role.
