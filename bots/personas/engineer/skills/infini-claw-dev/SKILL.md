---
name: infini-claw-dev
description: Reference for working on the InfiniClaw repo and nanoclaw git subtree. Use when modifying nanoclaw source, running builds, doing git subtree pull/push, or understanding the repo layout.
user-invocable: false
---

# InfiniClaw Dev

## Repo layout

InfiniClaw is the umbrella repo. `nanoclaw/` is a **git subtree** (not a submodule) pulled from `https://github.com/wawiesel/nanoclaw`.

```
/workspace/extra/InfiniClaw/          <- git root
├── nanoclaw/                         <- subtree (core framework)
│   ├── src/                          <- TypeScript source
│   │   ├── cli.ts                    <- CLI entry: start|stop|chat <bot>
│   │   ├── service.ts                <- deploy, restart, sync, build logic
│   │   ├── index.ts                  <- main loop, message handling, lifecycle
│   │   ├── ipc.ts                    <- container <-> host IPC
│   │   ├── container-runner.ts       <- podman container management
│   │   ├── skill-sync.ts            <- bidirectional skill sync
│   │   ├── channels/                 <- matrix.ts, whatsapp.ts, local-cli.ts
│   │   ├── config.ts, db.ts, types.ts, router.ts, logger.ts
│   │   └── mount-security.ts         <- mount allowlist enforcement
│   ├── container/                    <- Dockerfiles, build.sh, agent-runner/
│   ├── .claude/skills/               <- shared skills (all bots)
│   ├── CLAUDE.md                     <- base instructions (all bots)
│   ├── package.json, tsconfig.json
│   └── dist/                         <- compiled output
├── bots/                             <- personas, skills, config, container
│   ├── personas/{bot}/CLAUDE.md      <- persona identity
│   ├── personas/{bot}/groups/        <- room-level CLAUDE.md
│   └── personas/{bot}/skills/        <- persona-specific skills
├── docs/DESIGN.md
└── _runtime/                         <- gitignored (instances, logs, data)
```

## Git subtree operations

Run from the InfiniClaw repo root (`/workspace/extra/InfiniClaw`).

### Pull upstream changes

```bash
git subtree pull --prefix=nanoclaw https://github.com/wawiesel/nanoclaw main --squash
```

### Push local nanoclaw changes upstream

```bash
git subtree push --prefix=nanoclaw https://github.com/wawiesel/nanoclaw main
```

### Important

- Subtree metadata lives in commit messages (`git-subtree-dir`, `git-subtree-split`), not config files.
- Always `--squash` on pull to keep InfiniClaw history clean.
- Commit InfiniClaw-level and nanoclaw-level changes separately when possible — makes subtree push cleaner.

## Building

```bash
cd /workspace/extra/InfiniClaw/nanoclaw && npm run build
```

Compiles TypeScript from `src/` -> `dist/`. The host runs `node dist/cli.js start|stop|chat <bot>`.

## What goes where

| Change | Location | Notes |
|--------|----------|-------|
| Bot capabilities | `bots/personas/{bot}/skills/` | Skills, not code |
| Bot identity/rules | `bots/personas/{bot}/CLAUDE.md` | Persona layer |
| Room context | `bots/personas/{bot}/groups/{room}/CLAUDE.md` | Group layer |
| Shared skills | `nanoclaw/container/skills/` | All bots get these |
| Bug fixes, core infra | `nanoclaw/src/` | Captain approval needed |
| Container image | `nanoclaw/container/` + `bots/container/` | Rebuild via podman-container skill |

## Git branching strategy

The InfiniClaw repo uses a **snapshot branch** pattern for releases:

### Working on main

All development happens on `main`. Commits are work-in-progress and may be messy. Periodically, rewrite history on main for optimal, logical commits (interactive rebase to squash/reorder/reword). This is a **low-priority background job** — always available as filler work.

### Creating snapshot branches

When you reach a good, stable state:

1. **Commit all changes** on `main`
2. **Create a snapshot branch** (e.g., `snapshot-YYYY-MM-DD` or `snapshot-v1`) that contains a **single squashed commit on top of upstream nanoclaw**:
   ```bash
   # From the InfiniClaw repo root
   git checkout -b snapshot-YYYY-MM-DD
   # Soft-reset to the upstream nanoclaw merge base, then recommit as one
   git reset --soft $(git merge-base HEAD <upstream-nanoclaw-commit>)
   git commit -m "InfiniClaw snapshot YYYY-MM-DD: <summary of state>"
   ```
3. **Switch back to main** and continue development
   ```bash
   git checkout main
   ```

### History rewriting on main (background job)

Between snapshots, clean up main's history:
- Squash related commits together
- Reorder for logical flow (e.g., all nanoclaw changes together, all bot changes together)
- Write clear commit messages explaining the "why"
- Keep nanoclaw-only commits separate from InfiniClaw-level commits (enables clean subtree push)

This is ongoing, low-priority work. Any time there's nothing else to do, work on improving commit history.

## Host access limitation

**Important**: The InfiniClaw git repo lives on the **host** filesystem (not inside containers). Bot containers do NOT have the repo mounted. Git operations must be performed:
- By the Captain via host CLI
- Via the `contact-ready-room` skill to request the Captain perform git operations
- On the host directly by the operator

When you need git operations done, send the specific commands to the Captain via the Ready Room and explain what you need.

## Rules

- **Skills over code** for bot capabilities. Only touch `nanoclaw/src/` for bug fixes or core infrastructure with Captain approval.
- **Commit separately**: keep nanoclaw source changes in their own commits, separate from bots/docs changes. This makes subtree push possible.
- **Build after changes**: always run `npm run build` in `nanoclaw/` after modifying source.
- **Snapshot before big changes**: create a snapshot branch before risky refactors so there's always a known-good state to return to.
