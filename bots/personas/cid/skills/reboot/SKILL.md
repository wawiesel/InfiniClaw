---
name: reboot
description: Restart or rebuild bots. Full redeploy syncs code, persona, and skills. Container image rebuild for adding packages/tools. Use after any source, skill, CLAUDE.md, or Dockerfile change.
---

# Reboot & Container Management

## Restart a Bot

```
restart_self(bot: "engineer")    # Restart yourself
restart_self(bot: "commander")   # Restart Johnny5
```

What happens on restart:
1. `tsc --noEmit` validation — if it fails, bot stays up and you get errors to fix
2. Rsync nanoclaw source, install deps if changed, build TypeScript
3. Restore persona (appends persona CLAUDE.md, seeds group files)
4. Rebuild container image (picks up Dockerfile changes)
5. Restart bot process via launchd

Skills, CLAUDE.md changes, and container image updates all take effect after reboot.

## Edit Container Images

Dockerfiles live at:
```
$INFINICLAW_ROOT/bots/container/
  engineer/Dockerfile     # Your image
  commander/Dockerfile    # Johnny5's image
```

To rebuild without a full bot restart (e.g. just adding a package):
```bash
echo '{"type":"rebuild_image","bot":"engineer"}' > /workspace/ipc/tasks/rebuild-eng-$(date +%s).json
echo '{"type":"rebuild_image","bot":"commander"}' > /workspace/ipc/tasks/rebuild-cmd-$(date +%s).json
```
Images tagged `nanoclaw-engineer:latest` / `nanoclaw-commander:latest`. Takes effect on next container spawn — restart bot afterwards to force it.

## Image Philosophy

- **Engineer** (you): Lean. Git, ripgrep, python3, Claude Code. No browser.
- **Commander** (Johnny5): Full-featured. Browser (Chromium), data tools (docling, tesseract), build-essential.
