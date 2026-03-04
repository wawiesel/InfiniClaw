# InfiniClaw

Multi-bot fleet on Matrix, running Claude Agent SDK in Podman containers.

## Key Files

| File | Purpose |
|------|---------|
| `src/service.ts` | Bot lifecycle: start, stop, deploy, restart |
| `src/container-spawn.ts` | Spawns agent containers with mounts |
| `src/container-mounts.ts` | Builds volume mounts and syncs skills |
| `src/skill-sync.ts` | Symlinks role-assigned skills into session |
| `src/machine-config.ts` | Per-machine bot and secrets config |
| `external/nanoclaw/` | Core framework (container-runner, db, router, IPC) |
| `bots/{role}/{bot}/CLAUDE.md` | Per-bot persona (writable) |
| `bots/{role}/ROOM.md` | Shared room context (read-only) |
| `bots/{role}/skills.json` | Skills assigned to this role |
| `bots/{role}/mcp.json` | MCP servers for this role |
| `bots/skills/{name}/SKILL.md` | Shared skill pool |

## Development

```bash
npm run build          # Compile TypeScript
npm run cli start      # Start all bots on this machine
npm run cli stop       # Stop all bots
npm run cli stop <bot> # Stop one bot
npm run cli send <room> "<message>"  # Send message to a room
```

## Container Build Cache

The container buildkit caches aggressively. `--no-cache` alone does NOT invalidate COPY steps. To force a clean rebuild, prune the builder then re-run `./bots/container/build.sh`.
