# nanoclaw `src/` — Upstream Library

Clean fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). Platform-agnostic bot runtime: message storage, container queue management, IPC, scheduling, and channel abstractions.

**This directory tracks upstream.** Do not add InfiniClaw-specific code here. Extensions go in `../../src/` (see `nanoclaw-ext.d.ts`, `db-ext.ts`, etc.).

## Key files

| File | Purpose |
|------|---------|
| `types.ts` | Core interfaces: `Channel`, `NewMessage`, `RegisteredGroup` |
| `router.ts` | `formatMessages` (XML → bot prompt), `findChannel` |
| `db.ts` | SQLite message/chat/group store |
| `group-queue.ts` | Per-group container queue — serializes agent runs, IPC piping, fair slot scheduling |
| `container-runner.ts` | Spawns podman containers for agent runs; syncs agent-runner source to per-group dirs when host files are newer |
| `container-runtime.ts` | Container runtime detection; defaults to `podman`, overridable via `CONTAINER_RUNTIME_BIN` env var |
| `credential-proxy.ts` | Credential proxy for secure secret injection |
| `ipc.ts` | IPC watcher — task/message/context dirs |
| `task-scheduler.ts` | Cron/interval task scheduler |
| `sender-allowlist.ts` | Per-room sender allow/block rules |
| `channels/` | Channel implementations |
| `index.ts` | Main loop: `processGroupMessages` sends only the last agent result to prevent duplicates |
| `config.ts` | `ASSISTANT_NAME`, `TRIGGER_PATTERN` (`<m>Name</m>` match), shared constants (trailing newline cleanup) |
| `env-utils.ts` | Env file parsing: `parseEnvLine`, `parseEnvFile`, `upsertEnvLine`, `isOllamaBaseUrl` |
| `logger.ts` | Pino logger setup |
| `timezone.ts` | Timezone resolution |
| `mount-security.ts` | Path traversal guards for container mounts |

## Notes

- `formatMessages(messages, timezone)` requires timezone arg since v1.2.12
- `better-sqlite3` native module is compiled for host arch — doesn't work inside containers
- IPC dirs: Tasks = `/workspace/ipc/tasks/` (host→container), Messages = separate path for bot→host sends
