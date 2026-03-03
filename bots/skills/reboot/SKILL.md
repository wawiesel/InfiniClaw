---
name: reboot
description: Restart, rebuild, or redeploy bots. Reference for InfiniClaw source changes, builds, and git subtree operations. Use after any source, skill, CLAUDE.md, or Dockerfile change.
---

# Reboot, Build & Dev Reference

## Restart a Bot

```
restart_self(bot: "cid")      # Restart yourself
restart_self(bot: "johnny5")  # Restart Johnny5
restart_self(bot: "albert")   # Restart Albert
```

What happens on restart:
1. `tsc --noEmit` validation — if it fails, bot stays up and you get errors to fix
2. Rsync nanoclaw source, install deps if changed, build TypeScript
3. Restore persona (appends persona CLAUDE.md, seeds group files)
4. Rebuild container image (picks up Dockerfile changes)
5. Restart bot process via PM2/launchd

Skills, CLAUDE.md changes, and container image updates all take effect after reboot.

## Edit Container Images

Dockerfiles live at:
```
$INFINICLAW_ROOT/bots/container/
  cid/Dockerfile       # Your image — lean (git, ripgrep, python3, Claude Code)
  johnny5/Dockerfile   # Full-featured (Chromium, docling, tesseract, build-essential)
```

To rebuild without a full bot restart:
```bash
echo '{"type":"rebuild_image","bot":"cid"}' > /workspace/ipc/tasks/rebuild-$(date +%s).json
```
Takes effect on next container spawn — restart bot afterwards to force it.

## Source Editing & Building

```bash
cd $INFINICLAW_ROOT
# Edit source in src/ or external/nanoclaw/src/
npm run build          # builds nanoclaw first, then InfiniClaw
npm test               # runs InfiniClaw tests
```

Compiles TypeScript: nanoclaw `src/` → `external/nanoclaw/dist/`, InfiniClaw `src/` → `dist/`. The host runs `node dist/cli.js start|stop|chat <bot>`.

## Repo Layout

```
$INFINICLAW_ROOT/          <- git root
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
└── _runtime/                         <- gitignored (instances, logs, data)
```

## What Goes Where

| Change | Location | Notes |
|--------|----------|-------|
| Bot capabilities | `bots/personas/{bot}/skills/` | Skills, not code |
| Bot identity/rules | `bots/personas/{bot}/CLAUDE.md` | Persona layer |
| Room context | `bots/personas/{bot}/groups/{room}/CLAUDE.md` | Group layer |
| Shared skills | `external/nanoclaw/container/skills/` | All bots get these |
| InfiniClaw source | `src/` | Main orchestrator, channels, deploy |
| Upstream fixes | `external/nanoclaw/src/` | Captain approval needed |
| Container image | `external/nanoclaw/container/` + `bots/container/` | Rebuild via image task |

## Git Subtree Operations

Run from `$INFINICLAW_ROOT`:

```bash
# Pull upstream nanoclaw changes
git subtree pull --prefix=external/nanoclaw https://github.com/wawiesel/nanoclaw main --squash

# Push local nanoclaw changes upstream
git subtree push --prefix=external/nanoclaw https://github.com/wawiesel/nanoclaw main
```

- Subtree metadata lives in commit messages (`git-subtree-dir`, `git-subtree-split`), not config files.
- Always `--squash` on pull to keep InfiniClaw history clean.
- Commit InfiniClaw-level and nanoclaw-level changes separately when possible — makes subtree push cleaner.

## Rules

- **Skills over code** — add bot capabilities as skills, not source changes. Only touch source for bug fixes or core infrastructure with Captain approval.
- **Build after changes** — always `npm run build` after modifying source.
- **Commit separately** — keep nanoclaw source changes in their own commits for clean subtree push.
- **Never edit `/workspace/project/`** — that's the deployed copy, overwritten on restart.
