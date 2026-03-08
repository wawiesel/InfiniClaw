# nanoclaw `src/` — What Goes Here

This is the **NanoClaw framework** — the upstream multi-platform bot runtime that InfiniClaw builds on. It handles message storage, container queue management, IPC, scheduling, and channel abstractions.

**Owner:** Albert. InfiniClaw engineers make minor fixes only — significant changes require Albert's review and should be submitted as PRs upstream.

## What belongs here

- Platform-agnostic bot runtime (container queue, message loop, DB)
- Channel interface definitions (Matrix, CLI)
- IPC file protocol between host and containers
- Task scheduling
- Message formatting utilities
- Upstream sender allowlist logic

## What does NOT belong here

- InfiniClaw-specific logic → `../../src/`
- Agent runner (inside container) → `../container/agent-runner/src/`
- Bot personas → `../../../bots/`

## Key files

| File | Purpose |
|------|---------|
| `types.ts` | Core interfaces: `Channel`, `NewMessage`, `RegisteredGroup` |
| `router.ts` | `formatMessages` (XML → bot prompt), `formatThreadContext`, `findChannel` |
| `db.ts` | SQLite message/chat/group store. `storeMessage`, `getRecentMessages`, `getThreadMessages` |
| `group-queue.ts` | Per-group container queue — serializes agent runs, handles active-container IPC piping |
| `container-runner.ts` | Spawns podman containers for agent runs |
| `ipc.ts` | `startIpcWatcher` — watches IPC task/message/context dirs, dispatches to handlers |
| `task-scheduler.ts` | Cron/interval task scheduler — reads tasks from DB, fires IPC prompts |
| `sender-allowlist.ts` | Per-room sender allow/block rules |
| `channels/` | Channel implementations (Matrix, WhatsApp etc) |
| `index.ts` | Re-exports; backward-compat shims |
| `config.ts` | `ASSISTANT_NAME`, `TRIGGER_PATTERN`, shared constants |
| `logger.ts` | Pino logger setup |
| `mount-security.ts` | Path traversal guards for container mounts |

## Engineer observations (updated 2026-03-08)

- **`formatMessages`**: Outputs `<message sender="..." time="...">content</message>` XML blocks. Since InfiniClaw `5b94b50`, includes `thread="$id"` attribute when `m.thread_id` is set — lets bots see which thread each message belongs to.
- **`formatThreadContext`**: Generates `<thread_context>` block for prior thread messages not in the current window. Added by InfiniClaw (marked `// [InfiniClaw] removed upstream in v1.2.2`).
- **`getThreadMessages`**: Fetches all messages with a given `thread_id` from DB. Used by `main.ts` to build `activeReplyThreadIds` thread context.
- **SQLite in containers**: `better-sqlite3` native module is compiled for host arch and doesn't work inside containers. Use `strings` on the DB file or read JSON snapshots instead.
- **IPC dirs**: Tasks dir = `/workspace/ipc/tasks/` (host→container). Messages dir = separate path for bot→host message sends. Context dir for lower-priority injections.
- **`group-queue.ts` `sendMessage`**: Writes a follow-up message to the active container's stdin IPC file. Returns false if no active container. Used by `main.ts` `writeMessageToActiveContainerIpc`.
