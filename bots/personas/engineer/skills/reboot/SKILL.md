---
name: reboot
description: Restart yourself or the commander. Use after code changes, config updates, or when a bot is stuck.
---

# Reboot

Use the `restart_self` MCP tool to restart bots. It validates code before restarting — if `tsc --noEmit` fails, the bot stays running and you get the errors to fix.

## Restart yourself

```
restart_self(bot: "engineer")
```

## Restart Johnny5

```
restart_self(bot: "commander")
```

## What happens

1. Host stages code and runs `tsc --noEmit`
2. If validation fails: bot stays up, errors reported to chat — fix and retry
3. If validation passes: bot exits, launchd restarts it with new code

## When to use

- After editing nanoclaw source (bug fixes approved by the Captain)
- After config or profile changes that need a process restart
- When a bot is stuck or unresponsive
