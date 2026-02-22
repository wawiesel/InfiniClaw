# InfiniClaw Development

Multi-bot orchestration on Matrix. Two bots: Johnny5 (commander) and Cid (engineer). See `docs/DESIGN.md` for full architecture.

## Key paths

| What | Where |
|------|-------|
| InfiniClaw source | `src/` |
| NanoClaw upstream (subtree) | `external/nanoclaw/` |
| Bot instructions (base) | `external/nanoclaw/CLAUDE.md` |
| Bot personas | `bots/personas/{bot}/CLAUDE.md` |
| Container Dockerfiles | `bots/container/{bot}/Dockerfile` |
| Shared skills | `external/nanoclaw/container/skills/` |
| Bot-specific skills | `bots/personas/{bot}/skills/` |
| Profile env (gitignored) | `bots/profiles/{bot}/env` |
| Runtime state (gitignored) | `_runtime/` |

## Dev commands

```bash
npm run build             # Compile TypeScript (nanoclaw + InfiniClaw)
npm run dev               # Build nanoclaw + watch InfiniClaw
npm run cli start         # Deploy + start all bots via launchd
npm run cli stop          # Stop all bots
npm run cli chat <bot>    # Terminal chat (mirrors to Matrix)
npm run cli send <room> <msg>  # Send operator message to room
npm test                  # Run InfiniClaw tests
```

Rebuild container images: `./bots/container/build.sh all` (or `build.sh commander`).

## Architecture rules

- **Container runtime is Podman.** Config: `CONTAINER_RUNTIME = 'podman'` in `external/nanoclaw/src/config.ts`.
- **Mount security is enforced host-side** at `~/.config/nanoclaw/mount-allowlist.json`. Never mount `~/` or any dotfiles.
- **Skills are one-way** (persona+shared → session on each container spawn). Bots write new skills directly to their persona dir via writable mount.
- **MCP servers are two-way** (save-back on spawn, then restore).
- **All bots see all messages.** No code-level message filtering. Bots decide what to respond to via their CLAUDE.md.
- **IPC is per-room namespaced.** Main room gets elevated commands (restart_bot, rebuild_image, etc.).
- **Two code paths handle container output**: `processGroupMessages()` in `main.ts` for user messages, and `task-scheduler.ts` for scheduled tasks. Both must forward progress to chat.

## Source structure

### InfiniClaw source (`src/`)

| File | Purpose |
|------|---------|
| `main.ts` | Orchestrator: startup, message loop, Matrix connection, working indicator |
| `cli.ts` | CLI entry point |
| `service.ts` | Start/stop/deploy/chat/send logic |
| `container-spawn.ts` | Spawn Podman containers with InfiniClaw mounts/secrets |
| `ipc-watcher.ts` | IPC polling with extended message types and commands |
| `brain-management.ts` | Brain mode switching (model selection) |
| `chat-activity.ts` | Chat activity tracking and idle detection |
| `message-filtering.ts` | Message deduplication and filtering |
| `conversation-log.ts` | Conversation logging to disk |
| `ipc-commands.ts` | Extended IPC command handlers |
| `container-mounts.ts` | InfiniClaw-specific container volume mounts |
| `container-secrets.ts` | Provider secret normalization and cert mapping |
| `podman-bootstrap.ts` | Podman machine setup and validation |
| `channels/matrix.ts` | Matrix channel |
| `channels/local-cli.ts` | Terminal channel |
| `skill-sync.ts` | One-way skill sync on container spawn |
| `mcp-sync.ts` | MCP server sync |
| `status.ts` | Status reporting |

### NanoClaw upstream (`external/nanoclaw/src/`)

Upstream files are read-only dependencies kept for clean subtree merges:

| File | Purpose |
|------|---------|
| `config.ts` | All env-driven configuration |
| `db.ts` | SQLite operations |
| `logger.ts` | Logging |
| `types.ts` | TypeScript types and interfaces |
| `router.ts` | Message formatting and outbound routing |
| `group-queue.ts` | Per-room concurrency control |
| `container-runner.ts` | Base container runner |
| `task-scheduler.ts` | Scheduled task execution |
| `mount-security.ts` | Mount allowlist enforcement |
| `env-utils.ts` | Environment variable utilities |
| `podman-utils.ts` | Podman utilities |

## npm workspaces

InfiniClaw uses npm workspaces. `external/nanoclaw` is a workspace, so `import { foo } from 'nanoclaw/config.js'` resolves to `external/nanoclaw/dist/config.js`.

## Subtree management

```bash
# Pull upstream NanoClaw changes
git subtree pull --prefix=external/nanoclaw https://github.com/wawiesel/nanoclaw main --squash
```

## Startup sequence

1. Load profiles and SQLite
2. Connect channels (Matrix must connect before subsystems start)
3. Start scheduler loop (60s poll for due tasks)
4. Start message loop (250ms poll for new messages)
5. Inject resume message if resuming from a previous session
