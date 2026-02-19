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

## Version branches & git strategy

We maintain **named version branches** (aqua, bingo, charlie, ...) as stable checkpoints.

### Creating a version branch

When you reach a good stable state:

1. Commit all changes to `main`
2. Create the version branch from the subtree merge point with a squashed commit:
   ```bash
   git checkout -b <name> a89d41c   # subtree merge commit
   git merge --squash main
   git commit -m "<name>: <description of this version state>"
   ```
3. Switch back to main: `git checkout main`

This gives a clean single-commit diff against upstream nanoclaw for each version.

### Current branches

- `aqua` — first checkpoint (mount security, holodeck, lobes, resume, skills, NEXT.md)

### Background task: history rewriting

Ongoing low-priority work: rewrite the main branch history for optimal commit separation. Goal is clean, logical commits that could each be cherry-picked independently. This is the default background task when no higher-priority work exists.

## Holodeck (blue-green testing)

Test nanoclaw changes safely before promoting to production:

1. Create a feature branch: `git checkout -b feature-xyz`
2. Make changes, commit
3. Launch holodeck: IPC `holodeck_create` with `branch: "feature-xyz"`
4. Test in the Holodeck Matrix room — Cid+ runs the new code
5. If good: IPC `holodeck_promote` (merges to main, tears down)
6. If bad: IPC `holodeck_teardown` (kills instance, removes worktree)

The holodeck runs as a separate launchd service (`com.infiniclaw.holodeck`) with its own instance dir, data, and containers.

## Rules

- **Skills over code** for bot capabilities. Only touch `nanoclaw/src/` for bug fixes or core infrastructure with Captain approval.
- **Commit separately**: keep nanoclaw source changes in their own commits, separate from bots/docs changes. This makes subtree push possible.
- **Build after changes**: always run `npm run build` in `nanoclaw/` after modifying source.
- **Version branches**: create a new named branch at each stable milestone, squashing all changes into one commit on top of upstream nanoclaw.
- **History rewriting**: ongoing background task — reorganize main branch commits for clean separation. Always revertible via version branches.
