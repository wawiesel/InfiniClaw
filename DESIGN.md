# InfiniClaw Design

## Purpose

InfiniClaw is a multi-bot orchestration layer built on top of a maintained NanoClaw fork.
It provides two cooperating bots on a shared Matrix room called the Bridge:

- `engineer` aka **Cid** — chief engineer, infra + operations + lifecycle control
- `commander` aka **Johnny5** — right-hand commander, takes orders and executes tasks

The operator (Captain) gives orders to Johnny5 on the Bridge. Cid watches autonomously from the Bridge, only responding when addressed directly with `@Cid`. Cid can proactively improve Johnny5's code and restart him based on what he observes.

## Roles

### Operator (Captain)
- Gives orders on the Bridge
- Addresses Johnny5 directly for task execution
- Addresses Cid with `@Cid` for infrastructure work

### Commander — Johnny5 (`@Johnny5`)
- Takes orders on the Bridge — responds to everything except `@Cid` callouts
- The Bridge is Johnny5's main room (`requiresTrigger: false`)
- Sees ALL messages (no code-level filtering) — decides what to respond to via CLAUDE.md
- Executes tasks in his workspace/container
- Cannot modify his own code — requests changes from Cid
- Only `~/_vault` is mounted (read-write). No home directory, no dotfiles, no InfiniClaw.

### Engineer — Cid (`@Cid`)
- Watches the Bridge autonomously for opportunities to improve
- Only responds on the Bridge when addressed with `@Cid`
- Bridge responses must be brief (1-2 sentences): acknowledge and say "working in Engineering"
- All detailed work, code, logs, analysis goes in the Engineering room
- Posts a short summary back to the Bridge when done
- Can modify and restart Johnny5to improve him
- Manages infrastructure, builds, and deployments
- Containers get InfiniClaw mounted read-write

## Core Principles

1. Single platform, separate product
- Platform/runtime changes live in the NanoClaw fork.
- NanoClaw maintains the baseline container for core functionality.
- Product-specific policy/orchestration and per-bot container build/packaging live in InfiniClaw.

2. Script-first operations
- Setup and runtime must be executable from scripts.
- LLM/skills are wrappers over deterministic scripts, not the source of truth.

3. Runtime state isolation
- Code is versioned; runtime state is not.
- Bot state is isolated per instance under `./instances`.

4. Explicit ownership and boundaries
- Cid can manage container/runtime and may patch Johnny5'scode.
- Johnny5does not perform container lifecycle operations or modify his own code.

## Architecture

### Repositories

- `wawiesel/nanoclaw` (fork)
  - Runtime capability layer.
  - Upstream-sync + additive features that may be upstreamable.

- `wawiesel/InfiniClaw` (product)
  - Uses NanoClaw fork as embedded dependency (`./nanoclaw`, planned as submodule).
  - Adds profiles, scripts, deployment, policy, and docs.

### Runtime model

- Two sibling NanoClaw host processes managed by launchd:
  - `com.infiniclaw.engineer` → `instances/engineer/nanoclaw/`
  - `com.infiniclaw.commander` → `instances/commander/nanoclaw/`

- Each host process spawns agent-runner containers (via podman) for task execution:
  - Engineer containers: `nanoclaw-engineer:latest` (lean)
  - Commander containers: `nanoclaw-commander:latest` (full-featured, grows over time)

- Shared Matrix room (the Bridge) receives commands for both bots:
  - Any message → Johnny5 sees it (his main room, no trigger required)
  - Johnny5 decides via CLAUDE.md whether to respond (ignores @Cid callouts)
  - `@Cid ...` or `Cid: ...` → Cid responds (trigger pattern matches with or without `@`)
  - All bots see all messages — no code-level filtering
  - Rooms auto-register on first message (first room becomes `main`)

### Container images

| Image | Bot | Purpose |
|-------|-----|---------|
| `nanoclaw-engineer:latest` | Cid | Lean — git, ripgrep, Claude Code. No browser. |
| `nanoclaw-commander:latest` | Johnny5| Full — browser, Python, build tools. Grows as needed. |

Cid autonomously monitors Johnny5'sBridge interactions and adds dependencies to `nanoclaw-commander` as needed.

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
├── com.infiniclaw.engineer → node instances/engineer/nanoclaw/dist/index.js
│   ├── Connects to Matrix as @cidolfus-bot (Cid)
│   ├── Watches Bridge, responds to @Cid
│   ├── Spawns nanoclaw-engineer containers for tasks
│   └── Can restart commander via IPC (restart_bot)
│
├── com.infiniclaw.commander → node instances/commander/nanoclaw/dist/index.js
│   ├── Connects to Matrix as @johnny5-bot (Johnny5)
│   ├── Takes orders on the Bridge
│   └── Spawns nanoclaw-commander containers for tasks
│
└── ~/.config/nanoclaw/mount-allowlist.json (shared, host-side)
```

## File/Directory Plan

```text
InfiniClaw/
  DESIGN.md
  .gitignore
  start                       # Sync, build, install launchd, start both bots
  stop                        # Unload launchd, stop containers
  chat-engineer               # Interactive terminal chat with Cid
  chat-commander              # Interactive terminal chat with Johnny5
  nanoclaw/                   # NanoClaw fork (planned submodule)
  profiles/
    engineer/env              # Cid's env config
    commander/env             # Johnny5'senv config
  instances/
    engineer/nanoclaw/        # Cid's runtime instance (synced from nanoclaw/)
    commander/nanoclaw/       # Johnny5'sruntime instance (synced from nanoclaw/)
  container/
    engineer/Dockerfile       # Lean agent image for Cid
    commander/Dockerfile      # Full agent image for Johnny5
    build.sh                  # Build one or both container images
  config/
    mount-allowlist.json      # Template for ~/.config/nanoclaw/
  scripts/
    common.sh                 # Shared shell helpers
    validate-deploy.sh        # Pre-restart code validation (used by IPC)
  data/                       # gitignored runtime state
```

## Operations

### First-time setup

1. Configure profiles: `profiles/engineer/env`, `profiles/commander/env`
2. Build container images: `./container/build.sh`
3. Start: `./start`

### Start / Stop

- `./start` — syncs vendored code, builds TS, installs launchd plists, starts both bots
- `./stop` — unloads launchd plists, stops orphan containers

### Interactive chat

- `./chat-engineer` — terminal chat with Cid (mirrors to Matrix)
- `./chat-commander` — terminal chat with Johnny5(mirrors to Matrix)

### IPC commands (from engineer agent containers)

| Command | Effect |
|---------|--------|
| `restart_bot` (self) | Validate TS → exit → launchd restarts |
| `restart_bot` (other) | Validate TS → sync + build instance → launchctl kickstart |
| `rebuild_image` | Run `container/build.sh {bot}` to rebuild container image |
| `bot_status` | Return launchctl status + recent error log |

### Commander deployment (Cid's workflow)

Cid can deploy changes to Johnny5without operator intervention:

1. **Code changes**: Edit `nanoclaw/src/`, then IPC `restart_bot` with `bot: "commander"`.
   The host process syncs code, builds TS, and restarts commander via launchctl.

2. **Container image changes**: Edit `container/commander/Dockerfile`, then IPC `rebuild_image`
   with `bot: "commander"`. Next time Johnny5spawns an agent container, it uses the new image.

3. **Both**: `rebuild_image` first, then `restart_bot`.

### Engineer self-update (rare)

Cid can modify his own code in `nanoclaw/src/` and call `restart_bot` with `bot: "engineer"`.
The host validates TS compilation before exiting — if validation fails, Cid stays running and
gets the errors in chat. This is intentionally friction-heavy; most changes should target Johnny5.

## What belongs where

### NanoClaw fork

Keep:
- Channel/runtime capabilities (Matrix, IPC extensions, runtime selection, auth/session handling).
- Generic MCP and transport improvements.
- Security and reliability fixes.
- Baseline container image for default NanoClaw functionality.
- Behavior that could plausibly be accepted upstream.

Do not keep:
- Organization-specific cert bundles.
- InfiniClaw deployment/image packaging specifics.
- Persona-specific CLAUDE/group policy content.

### InfiniClaw repo

Keep:
- Bot profiles (`engineer`, `commander`).
- Role policy and command contract.
- Per-bot Dockerfiles and container images.
- Start/stop/chat/install scripts.
- Mount allowlist template.
- Data layout and operational documentation.

## Security posture

- No credentials in git.
- Runtime secrets sourced from env and local secure stores.
- `data/` and `instances/` excluded from version control.
- Mount allowlist stored outside project root (tamper-proof from containers).
- Johnny5cannot access InfiniClaw code from inside containers.
- Least-privilege execution by role.

## Change management

- Keep PRs small and single-purpose.
- In NanoClaw fork PRs, prefer separable commits by capability:
  - matrix, runtime, mcp-ipc, mcp-ollama, mcp-codex, channel-specific fixes, docs
- In InfiniClaw PRs, keep container/image changes separate from policy/profile/script changes.
- Sync NanoClaw fork main with upstream before rebasing feature branches.
