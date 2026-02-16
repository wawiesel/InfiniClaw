---
name: podman-container
description: Build and update container images for yourself and the commander. Use when adding packages, tools, or dependencies to a bot's container image (apt, pip, npm globals, entrypoint changes).
---

# Container Image Management

Edit Dockerfiles and trigger host-side rebuilds. No podman inside the container — use IPC.

## Files

```
/workspace/extra/InfiniClaw/bots/container/
  build.sh                    # Build script (host-side only)
  engineer/Dockerfile         # Your image
  commander/Dockerfile        # Johnny5's image
```

## How to rebuild

Trigger a host-side rebuild via IPC:

```bash
echo '{"action":"rebuild_image","bot":"engineer"}' > /workspace/ipc/tasks/rebuild-eng-$(date +%s).json
echo '{"action":"rebuild_image","bot":"commander"}' > /workspace/ipc/tasks/rebuild-cmd-$(date +%s).json
```

Images are tagged `nanoclaw-engineer:latest` and `nanoclaw-commander:latest`.

A rebuild takes effect on the **next container spawn**. To force a new spawn, restart the bot after rebuilding.

## Image philosophy

- **Engineer** (you): Lean. Git, ripgrep, python3, Claude Code. No browser.
- **Commander** (Johnny5): Full-featured. Browser (Chromium), data tools (docling, tesseract), build-essential. Grows as you observe what Johnny5 needs.
