# InfiniClaw Design

## Purpose

InfiniClaw is a multi-bot orchestration layer built on top of a maintained NanoClaw fork.
It provides two cooperating bots in one Matrix control surface:

- `engineer-bot` (infra + operations + lifecycle control)
- `assistant-bot` (worker + coding/task execution)

The goal is reproducible operations with clear role boundaries, while keeping core runtime improvements in the NanoClaw fork.

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
- Bot state is isolated per instance under `./data` and ignored by git.

4. Explicit ownership and boundaries
- `engineer-bot` can manage container/runtime and may patch worker code when explicitly instructed.
- `assistant-bot` does not perform container lifecycle operations.

## Architecture

### Repositories

- `wawiesel/nanoclaw` (fork)
  - Runtime capability layer.
  - Upstream-sync + additive features that may be upstreamable.

- `wawiesel/InfiniClaw` (product)
  - Uses NanoClaw fork as embedded dependency (`./nanoclaw`, planned as submodule).
  - Adds profiles, scripts, deployment, policy, and docs.

### Runtime model

- Two sibling NanoClaw instances run from shared code but isolated state roots:
  - `data/engineer-bot/{data,store,groups,logs}`
  - `data/assistant-bot/{data,store,groups,logs}`

- Shared Matrix room receives commands for both bots using explicit addressing:
  - `engineer: ...`
  - `assistant: ...`

### Process topology

- `engineer-bot` process:
  - Infra controls (rebuild/restart/logs/dependency ops).
  - Optional code edits with explicit request.

- `assistant-bot` process:
  - Task execution and code workflow in its assigned workspace/container.

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
- Bot profiles (`engineer-bot`, `assistant-bot`).
- Role policy and command contract.
- Setup/start/stop/tmux scripts.
- Per-bot derived container definitions, build scripts, tags, and rollout logic.
- Environment-specific customizations for each bot role.
- Data layout and operational documentation.

## File/Directory Plan (InfiniClaw)

```text
InfiniClaw/
  DESIGN.md
  README.md
  .gitignore
  nanoclaw/                 # NanoClaw fork (planned submodule)
  profiles/
    engineer/
    assistant/
  scripts/
    setup.sh
    start-engineer.sh
    start-assistant.sh
    start-all.sh
    stop-all.sh
    status.sh
    tmux.sh
  deploy/
  docs/
  data/                     # gitignored runtime state
```

## Operations

### Setup

- Run `scripts/setup.sh` once:
  - validate prerequisites
  - initialize per-bot runtime directories
  - prepare per-bot env/profile files
  - install/build NanoClaw

### Start

- `scripts/start-all.sh` for background launch, or
- `scripts/tmux.sh` for live visibility of both bots.

### Observe

- tmux panes provide process output per bot.
- per-group container logs remain under each bot’s isolated group tree.

### Container update method

Container ownership split:

- NanoClaw: baseline image for core/default features.
- InfiniClaw: derived images for role-specific bots.

1. Update NanoClaw baseline container only for generic/core requirements.
2. Update InfiniClaw derived containers per bot role:
   - `engineer`
   - `commander`
3. Build versioned images (no production rollout from floating `latest`).
4. Update InfiniClaw runtime config to the new image tags.
5. Roll out in order:
   - `engineer` first
   - `commander` second
6. Verify health/logs in tmux and Matrix.
7. Roll back by restoring prior image tags + restart scripts.

## Security posture

- No credentials in git.
- Runtime secrets sourced from env and local secure stores.
- `data/` excluded from version control.
- Least-privilege execution by role.

## Change management

- Keep PRs small and single-purpose.
- In NanoClaw fork PRs, prefer separable commits by capability:
  - matrix
  - runtime
  - mcp-ipc
  - mcp-ollama
  - mcp-codex
  - channel-specific fixes
  - docs
- In InfiniClaw PRs, keep container/image changes separate from policy/profile/script changes.

- Sync NanoClaw fork main with upstream before rebasing feature branches.

## Immediate next steps

1. Add NanoClaw fork as `./nanoclaw` submodule.
2. Add `.gitignore` with `/data/`.
3. Scaffold `scripts/` and `profiles/`.
4. Add `README.md` with setup/start/tmux commands.
5. Pin first InfiniClaw baseline commit.
