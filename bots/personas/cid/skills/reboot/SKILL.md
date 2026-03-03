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

**What goes where:**

| Change | Location |
|--------|----------|
| Bot capabilities | `bots/personas/{bot}/skills/` |
| Bot identity/rules | `bots/personas/{bot}/CLAUDE.md` |
| Room context | `bots/personas/{bot}/groups/{room}/CLAUDE.md` |
| InfiniClaw orchestrator | `src/` |
| Upstream nanoclaw fixes | `external/nanoclaw/src/` |
| Container image | `external/nanoclaw/container/` + `bots/container/` |

## Repo Layout

```
$INFINICLAW_ROOT/
├── src/                    <- InfiniClaw source (orchestrator, channels, deploy)
│   ├── main.ts             <- startup, message loop
│   ├── service.ts          <- deploy, restart, sync, build logic
│   ├── container-spawn.ts  <- podman container management
│   ├── ipc-commands.ts     <- extended IPC command handlers
│   ├── channels/matrix.ts  <- Matrix channel
│   └── ...
├── external/nanoclaw/      <- git subtree (upstream framework)
│   ├── src/                <- upstream source
│   └── container/          <- agent-runner, skills
├── bots/
│   ├── personas/{bot}/     <- CLAUDE.md, skills, groups, container-config
│   └── container/{bot}/    <- Dockerfiles
└── _runtime/               <- gitignored (instances, logs, data)
```

## Git Subtree Operations

Run from `$INFINICLAW_ROOT`:

```bash
# Pull upstream nanoclaw changes
git subtree pull --prefix=external/nanoclaw https://github.com/wawiesel/nanoclaw main --squash

# Push local nanoclaw changes upstream
git subtree push --prefix=external/nanoclaw https://github.com/wawiesel/nanoclaw main
```

Always `--squash` on pull to keep InfiniClaw history clean. Commit InfiniClaw-level and nanoclaw-level changes separately when possible.

## Rules

- **Skills over code** — add bot capabilities as skills, not source changes.
- **Build after changes** — always `npm run build` after modifying source.
- **Commit separately** — keep nanoclaw source changes in their own commits for clean subtree push.
- **Never edit `/workspace/project/`** — that's the deployed copy, overwritten on restart.
