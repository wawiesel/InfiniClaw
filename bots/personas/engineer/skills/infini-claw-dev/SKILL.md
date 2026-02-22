---
name: infini-claw-dev
description: Reference for working on the InfiniClaw repo and nanoclaw git subtree. Use when modifying source, running builds, doing git subtree pull/push, or understanding the repo layout.
user-invocable: false
---

# InfiniClaw Dev

## Repo layout

InfiniClaw is the umbrella repo. `external/nanoclaw/` is a **git subtree** (not a submodule) pulled from `https://github.com/wawiesel/nanoclaw`. InfiniClaw's own source lives in `src/` and imports NanoClaw modules via npm workspaces (`import from 'nanoclaw/config.js'`).

```
/workspace/extra/InfiniClaw/          <- git root
├── package.json                      <- workspace root (npm workspaces)
├── tsconfig.json                     <- InfiniClaw build config
├── vitest.config.ts                  <- InfiniClaw test config
├── src/                              <- InfiniClaw source
│   ├── main.ts                       <- orchestrator: startup, message loop
│   ├── cli.ts                        <- CLI entry: start|stop|chat|send
│   ├── service.ts                    <- deploy, restart, sync, build logic
│   ├── container-spawn.ts            <- podman container management
│   ├── ipc-watcher.ts                <- IPC polling with extended types
│   ├── ipc-commands.ts               <- extended IPC command handlers
│   ├── brain-management.ts           <- model selection
│   ├── chat-activity.ts              <- activity tracking
│   ├── container-mounts.ts           <- InfiniClaw container volumes
│   ├── container-secrets.ts          <- provider secret normalization
│   ├── channels/matrix.ts            <- Matrix channel
│   ├── channels/local-cli.ts         <- Terminal channel
│   ├── skill-sync.ts, mcp-sync.ts    <- skill/MCP sync
│   └── __tests__/                    <- InfiniClaw tests
├── dist/                             <- InfiniClaw compiled output
├── external/
│   └── nanoclaw/                     <- subtree (upstream framework)
│       ├── src/                      <- upstream source
│       │   ├── config.ts, db.ts, types.ts, router.ts, logger.ts
│       │   ├── container-runner.ts, task-scheduler.ts, group-queue.ts
│       │   ├── mount-security.ts, env-utils.ts, podman-utils.ts
│       │   └── channels/whatsapp.ts
│       ├── container/                <- agent-runner/, skills/, build.sh
│       ├── CLAUDE.md                 <- base instructions (all bots)
│       ├── package.json              <- with "exports" field
│       └── dist/                     <- upstream compiled output
├── bots/                             <- personas, skills, config, container
│   ├── personas/{bot}/CLAUDE.md      <- persona identity
│   ├── personas/{bot}/groups/        <- room-level CLAUDE.md
│   ├── personas/{bot}/skills/        <- persona-specific skills
│   └── container/{bot}/Dockerfile    <- container images
├── docs/DESIGN.md
└── _runtime/                         <- gitignored (instances, logs, data)
```

## Git subtree operations

Run from the InfiniClaw repo root (`/workspace/extra/InfiniClaw`).

### Pull upstream changes

```bash
git subtree pull --prefix=external/nanoclaw https://github.com/wawiesel/nanoclaw main --squash
```

### Push local nanoclaw changes upstream

```bash
git subtree push --prefix=external/nanoclaw https://github.com/wawiesel/nanoclaw main
```

### Important

- Subtree metadata lives in commit messages (`git-subtree-dir`, `git-subtree-split`), not config files.
- Always `--squash` on pull to keep InfiniClaw history clean.
- Commit InfiniClaw-level and nanoclaw-level changes separately when possible — makes subtree push cleaner.

## Building

```bash
npm run build    # builds nanoclaw first, then InfiniClaw
npm test         # runs InfiniClaw tests
```

Compiles TypeScript: nanoclaw `src/` → `external/nanoclaw/dist/`, InfiniClaw `src/` → `dist/`. The host runs `node dist/cli.js start|stop|chat <bot>`.

## What goes where

| Change | Location | Notes |
|--------|----------|-------|
| Bot capabilities | `bots/personas/{bot}/skills/` | Skills, not code |
| Bot identity/rules | `bots/personas/{bot}/CLAUDE.md` | Persona layer |
| Room context | `bots/personas/{bot}/groups/{room}/CLAUDE.md` | Group layer |
| Shared skills | `external/nanoclaw/container/skills/` | All bots get these |
| InfiniClaw source | `src/` | Main orchestrator, channels, deploy |
| Upstream fixes | `external/nanoclaw/src/` | Captain approval needed |
| Container image | `external/nanoclaw/container/` + `bots/container/` | Rebuild via podman-container skill |

## Rules

- **Skills over code** for bot capabilities. Only touch source for bug fixes or core infrastructure with Captain approval.
- **Commit separately**: keep nanoclaw source changes in their own commits, separate from src/ and bots/docs changes. This makes subtree push possible.
- **Build after changes**: always run `npm run build` after modifying source.
