# nanoclaw/src/ — Framework Core

Reusable bot framework. InfiniClaw wraps these modules — they should not contain InfiniClaw-specific logic.

- **config.ts** — All env-driven configuration: intervals, paths, limits, trigger patterns.
- **db.ts** — SQLite schema and queries: messages, sessions, rooms, scheduled tasks, task run logs.
- **router.ts** — Outbound message routing, cross-bot forwarding (`@BotName`), message formatting.
- **container-runner.ts** — Composable container lifecycle: build podman args, spawn, stream stdout, parse output markers, handle timeout/close. Both NanoClaw and InfiniClaw use `runContainer()`.
- **task-scheduler.ts** — 60-second poll loop for due scheduled tasks. Spawns containers via group-queue.
- **group-queue.ts** — Per-room concurrency: one container at a time per room, overflow queue, retry backoff.
- **mount-security.ts** — Validate container bind mounts against host-side allowlist.
- **env-utils.ts** — Parse env files, env line helpers.
- **podman-utils.ts** — Podman CLI helpers: stop containers, recover from errors.
- **logger.ts** — Pino logger instance.
- **types.ts** — Shared types: `Channel`, `RegisteredGroup`, `ScheduledTask`, `MountAllowlist`.
- **channels/whatsapp.ts** — WhatsApp channel via Baileys (NanoClaw's original channel).
