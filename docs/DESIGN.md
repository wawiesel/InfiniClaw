# InfiniClaw Design

## Purpose

InfiniClaw is a multi-bot orchestration layer built on top of a maintained NanoClaw fork.
It provides cooperating bots on Matrix:

- `engineer` aka **Cid** — chief engineer, infra + operations + lifecycle control
- `commander` aka **Johnny5** — right-hand commander, takes orders and executes tasks

The operator (Captain) gives orders to Johnny5 in the Ready Room. Cid works in Engineering, responding when addressed with `@Cid`. Cid can proactively improve Johnny5's code and restart him.

## Roles

### Operator (Captain)
- Gives orders in the Ready Room and Engineering
- Addresses Johnny5 directly for task execution
- Addresses Cid with `@Cid` for infrastructure work

### Commander — Johnny5 (`@Johnny5`)
- Takes orders in the Ready Room — responds to everything except `@Cid` callouts
- The Ready Room is Johnny5's main room (`requiresTrigger: false`)
- Sees ALL messages (no code-level filtering) — decides what to respond to via CLAUDE.md
- Cannot modify his own code — requests changes from Cid
- Only `~/_vault` is mounted (read-write). No home directory, no dotfiles, no InfiniClaw.

### Engineer — Cid (`@Cid`)
- Works in Engineering, responds when addressed with `@Cid`
- Can modify and restart Johnny5 to improve him
- Manages infrastructure, builds, and deployments
- Containers get InfiniClaw mounted read-write

## Core Principles

1. Single platform, separate product
- Platform/runtime changes live in the NanoClaw fork.
- Product-specific policy/orchestration and per-bot container build/packaging live in InfiniClaw.

2. Script-first operations
- Setup and runtime must be executable from scripts.
- LLM/skills are wrappers over deterministic scripts, not the source of truth.

3. Runtime state isolation
- Code is versioned; runtime state is not.
- Bot state is isolated per instance under `_runtime/instances/`.

4. Explicit ownership and boundaries
- Cid can manage container/runtime and may patch Johnny5's code.
- Johnny5 does not perform container lifecycle operations or modify his own code.

## Architecture

### Runtime model

- Sibling NanoClaw host processes managed by launchd:
  - `com.infiniclaw.engineer` → `_runtime/instances/engineer/nanoclaw/`
  - `com.infiniclaw.commander` → `_runtime/instances/commander/nanoclaw/`

- Each host process spawns agent-runner containers (via podman) for task execution:
  - Engineer containers: `nanoclaw-engineer:latest` (lean)
  - Commander containers: `nanoclaw-commander:latest` (full-featured, grows over time)

### Persona system (three-layer CLAUDE.md)

Bot identity is version-controlled in `bots/personas/`:

1. **Base** (`nanoclaw/CLAUDE.md`) — Framework: how NanoClaw works, IPC, status messages. All bots get this.
2. **Persona** (`bots/personas/{bot}/CLAUDE.md`) — Identity: who you are, your rules, your style.
3. **Group** (`bots/personas/{bot}/groups/{group}/CLAUDE.md`) — Room context: capabilities, accumulated memory.

On `scripts/start`, persona CLAUDE.md is appended to the instance's base CLAUDE.md. Group files are synced bidirectionally (save runtime changes, then restore from personas/).

### Container images

| Image | Bot | Purpose |
|-------|-----|---------|
| `nanoclaw-engineer:latest` | Cid | Lean — git, ripgrep, Python3, Claude Code. No browser. |
| `nanoclaw-commander:latest` | Johnny5 | Full — browser, Python, build tools. Grows as needed. |

### Container mount policy

| Bot | Mount | Container path | Access |
|-----|-------|---------------|--------|
| Cid | `/home/2026-Nanoclaw/InfiniClaw` | `/workspace/extra/InfiniClaw` | read-write |
| Johnny5 | `/home/_vault` | `/workspace/extra/home/_vault` | read-write |

**Hard rules:**
- No home directory mount (`~/`). Only specific subdirectories.
- No dotfiles/dotdirs (`~/.ssh`, `~/.config`, etc.) ever accessible from containers.
- Johnny5 has NO access to InfiniClaw code.
- Cid has NO access to the Captain's home directory beyond InfiniClaw.

Mount security is enforced by `~/.config/nanoclaw/mount-allowlist.json` (host-side, tamper-proof from containers).

### Process topology

```
Mac Host (launchd)
├── com.infiniclaw.engineer → node _runtime/instances/engineer/nanoclaw/dist/index.js
│   ├── Connects to Matrix as @cidolfus-bot (Cid)
│   ├── Responds to @Cid in Engineering
│   ├── Spawns nanoclaw-engineer containers for tasks
│   └── Can restart commander via IPC (restart_bot)
│
├── com.infiniclaw.commander → node _runtime/instances/commander/nanoclaw/dist/index.js
│   ├── Connects to Matrix as @johnny5-bot (Johnny5)
│   ├── Takes orders in the Ready Room
│   └── Spawns nanoclaw-commander containers for tasks
│
└── ~/.config/nanoclaw/mount-allowlist.json (shared, host-side)
```

## Directory structure

```text
InfiniClaw/
  README.md
  .gitignore
  scripts/
    start                     # Sync, build, install launchd, start all bots
    stop                      # Unload launchd, stop containers
    chat                      # Interactive terminal chat: ./scripts/chat <bot>
    common.sh                 # Shared shell helpers
    validate-deploy.sh        # Pre-restart code validation (used by IPC)
  nanoclaw/                   # NanoClaw fork (planned submodule)
  bots/
    personas/
      {bot}/CLAUDE.md         # Bot identity and rules
      {bot}/groups/{group}/   # Room context and accumulated memory
      {bot}/skills/           # Bot-specific skills (Python scripts, etc.)
    profiles/
      {bot}/env               # Bot env config (gitignored)
    container/
      {bot}/Dockerfile        # Per-bot agent container image
      build.sh                # Build one or all container images
    config/
      mount-allowlist.json    # Template for ~/.config/nanoclaw/
  docs/
    DESIGN.md                 # This file
    assets/                   # Images, banners
  _runtime/                   # Gitignored runtime state
    instances/                # Per-bot runtime instances (synced from nanoclaw/)
    data/                     # SQLite, sessions, IPC
    logs/                     # Bot stdout/stderr logs
    run/                      # PID files
    staging/                  # Deploy validation staging area
```

## Operations

### First-time setup

1. Configure profiles: `bots/profiles/{bot}/env`
2. Build container images: `./bots/container/build.sh`
3. Start: `./scripts/start`

### Start / Stop

- `./scripts/start` — syncs vendored code, builds TS, installs launchd plists, starts all bots
- `./scripts/stop` — syncs personas, unloads launchd plists, stops orphan containers

### Interactive chat

- `./scripts/chat <bot>` — terminal chat with any bot (mirrors to Matrix)

### IPC commands (from engineer agent containers)

| Command | Effect |
|---------|--------|
| `restart_bot` (self) | Validate TS → exit → launchd restarts |
| `restart_bot` (other) | Validate TS → sync + build instance → launchctl kickstart |
| `rebuild_image` | Run `bots/container/build.sh {bot}` to rebuild container image |
| `bot_status` | Return launchctl status + recent error log |

### Deployment workflow (Cid)

1. **Code changes**: Edit `nanoclaw/src/`, then IPC `restart_bot` with `bot: "commander"`.
2. **Container image changes**: Edit `bots/container/commander/Dockerfile`, then IPC `rebuild_image`.
3. **Both**: `rebuild_image` first, then `restart_bot`.

## Security posture

- No credentials in git.
- Runtime secrets sourced from env and local secure stores.
- `_runtime/` excluded from version control.
- Mount allowlist stored outside project root (tamper-proof from containers).
- Johnny5 cannot access InfiniClaw code from inside containers.
- Least-privilege execution by role.
