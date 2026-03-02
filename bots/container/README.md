# container/ — Bot Container Images

Dockerfiles for building each bot's Podman container image. Images are named `nanoclaw-{bot}:latest`.

## Build

```bash
# Build all
./build.sh all

# Build one
./build.sh cid
```

## What's in a container

Each container runs the agent-runner (`external/nanoclaw/container/agent-runner/`) with:
- Claude Agent SDK
- Bot-specific system packages (from Dockerfile)
- MCP tools (crew_roster, send_message, delegate_to_lobe, IPC commands)
- Read-only home directory mount
- Read-write workspace mounts (per-bot, validated against allowlist)

The host injects secrets as env vars via `podman run --env`. No secrets are baked into images.
