# InfiniClaw Development

Multi-bot orchestration on Matrix. Two bots: Johnny5 (commander) and Cid (engineer). See `docs/DESIGN.md` for full architecture.

## Key paths

| What | Where |
|------|-------|
| Platform source | `nanoclaw/src/` |
| Bot instructions (base) | `nanoclaw/CLAUDE.md` |
| Bot personas | `bots/personas/{bot}/CLAUDE.md` |
| Container Dockerfiles | `bots/container/{bot}/Dockerfile` |
| Shared skills | `nanoclaw/container/skills/` |
| Bot-specific skills | `bots/personas/{bot}/skills/` |
| Profile env (gitignored) | `bots/profiles/{bot}/env` |
| Runtime state (gitignored) | `_runtime/` |

## Dev commands

```bash
cd nanoclaw
npm run build             # Compile TypeScript
npm run dev               # Build + watch
npm run cli start         # Deploy + start all bots via launchd
npm run cli stop          # Stop all bots
npm run cli chat <bot>    # Terminal chat (mirrors to Matrix)
npm run cli send <room> <msg>  # Send operator message to room
```

Rebuild container images: `./bots/container/build.sh all` (or `build.sh commander`).

## Architecture rules

- **Container runtime is Podman.** Config: `CONTAINER_RUNTIME = 'podman'` in `src/config.ts`.
- **Mount security is enforced host-side** at `~/.config/nanoclaw/mount-allowlist.json`. Never mount `~/` or any dotfiles.
- **Skills are one-way** (persona+shared → session on each container spawn). Bots write new skills directly to their persona dir via writable mount.
- **MCP servers are two-way** (save-back on spawn, then restore).
- **All bots see all messages.** No code-level message filtering. Bots decide what to respond to via their CLAUDE.md.
- **IPC is per-group namespaced.** Main group gets elevated commands (restart_bot, rebuild_image, etc.).
- **Two code paths handle container output**: `processGroupMessages()` in `index.ts` for user messages, and `task-scheduler.ts` for scheduled tasks. Both must forward progress to chat.

## Source structure (nanoclaw/src/)

| File | Purpose |
|------|---------|
| `index.ts` | Orchestrator: startup, message loop, Matrix connection, working indicator |
| `service.ts` | Start/stop/deploy/chat/send logic |
| `container-runner.ts` | Spawn Podman containers with mounts |
| `task-scheduler.ts` | Scheduled task execution |
| `group-queue.ts` | Per-group concurrency control |
| `ipc.ts` | IPC command handler (container → host) |
| `db.ts` | SQLite operations |
| `router.ts` | Message formatting and outbound routing |
| `config.ts` | All env-driven configuration |
| `channels/matrix.ts` | Matrix channel |
| `channels/whatsapp.ts` | WhatsApp channel |
| `channels/local-cli.ts` | Terminal channel |
| `skill-sync.ts` | One-way skill sync on container spawn |
| `status.ts` | Status reporting |

## Startup sequence

1. Load profiles and SQLite
2. Connect channels (Matrix must connect before subsystems start)
3. Start scheduler loop (60s poll for due tasks)
4. Start message loop (250ms poll for new messages)
5. Inject resume message if resuming from a previous session
