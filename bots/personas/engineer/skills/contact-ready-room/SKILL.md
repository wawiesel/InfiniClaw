---
name: contact-ready-room
description: Send a message to Johnny5 in the Bridge. Use when you need to report status, request decisions, or coordinate with the commander.
---

# Contact Bridge

Use `mcp__nanoclaw__send_message` with `recipient: "Johnny5"` to send a message to Johnny5 in the Bridge.

## Example

```
mcp__nanoclaw__send_message(text: "Deployment complete — all services are green.", recipient: "Johnny5")
```

## Rules

- Be concise. Give status, results, and decisions needed.
- Do not duplicate your final response as a send_message — only use this for explicit cross-bot communication.
