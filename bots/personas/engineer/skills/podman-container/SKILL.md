---
name: podman-container
description: Build and update Podman container images for yourself and the commander. Use when adding packages, tools, or dependencies to a bot's container.
---

# Podman Container Management

You own the container images for both bots. When a bot needs new packages, tools, or system dependencies, you edit its Dockerfile and rebuild.

## Files

```
/workspace/extra/InfiniClaw/bots/container/
  build.sh                    # Build script
  engineer/Dockerfile         # Your image
  commander/Dockerfile        # Johnny5's image
```

## Build commands

From inside your container, run:

```bash
# Build one
/workspace/extra/InfiniClaw/bots/container/build.sh engineer
/workspace/extra/InfiniClaw/bots/container/build.sh commander

# Build both
/workspace/extra/InfiniClaw/bots/container/build.sh all
```

The build context is `nanoclaw/container/` — Dockerfiles can `COPY agent-runner/` from there.

Images are tagged `nanoclaw-engineer:latest` and `nanoclaw-commander:latest`.

## When to rebuild

- Adding apt packages, pip packages, or npm global tools
- Changing the entrypoint or build steps
- Updating SDK patches (engineer Dockerfile has Claude Agent SDK patches)

A rebuild only takes effect on the **next container spawn** — no restart needed. The host uses the latest image each time it runs a container.

## Image philosophy

- **Engineer** (you): Lean. Git, ripgrep, python3, Claude Code. No browser, no heavy tools.
- **Commander** (Johnny5): Full-featured. Browser (Chromium), data tools (docling, tesseract), build-essential. This image grows as you observe what Johnny5 needs.
