---
name: reboot
description: Restart yourself or the commander. Full redeploy — syncs code, persona, skills, rebuilds container image. Use after source changes, skill edits, CLAUDE.md updates, Dockerfile changes, or when a bot is stuck.
---

# Reboot

Use the `restart_self` MCP tool. This is a full redeploy — not just a process restart.

## Commands

```
restart_self(bot: "engineer")    # Restart yourself
restart_self(bot: "commander")   # Restart Johnny5
```

## What happens

1. Validate code with `tsc --noEmit` — if it fails, bot stays up and you get errors to fix
2. Save persona groups (preserves room memory)
3. Rsync nanoclaw source to instance
4. Install deps if package-lock changed
5. Build TypeScript
6. Restore persona (appends persona CLAUDE.md, seeds group files)
7. Rebuild container image (picks up agent-runner changes)
8. Restart bot process via launchd

Skills, CLAUDE.md changes, and container image updates all take effect after reboot.
