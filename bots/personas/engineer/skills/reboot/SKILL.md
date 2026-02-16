---
name: reboot
description: Restart yourself or the commander. Full redeploy — syncs code, persona, skills, and rebuilds the container image.
---

# Reboot

Use the `restart_self` MCP tool to restart bots. This is a full redeploy — not just a process restart.

## Restart yourself

```
restart_self(bot: "engineer")
```

## Restart Johnny5

```
restart_self(bot: "commander")
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

## When to use

- After editing nanoclaw source (bug fixes approved by the Captain)
- After creating or modifying skills
- After editing CLAUDE.md files
- After changing Dockerfiles or agent-runner code
- After config or profile changes
- When a bot is stuck or unresponsive
