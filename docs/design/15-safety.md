# 15 — Safety and Security

## Exit-137 (SIGKILL) Backoff

When a container exits with code 137 (SIGKILL — which includes OOM kills, external kills, and timeout kills), the system tracks consecutive exit-137 events per room. After `KILL_137_MAX_CONSECUTIVE` (default 3) consecutive exits, a `KILL_137_COOLDOWN_MS` (default 60s) cooldown is enforced before the next container spawn. This prevents runaway token burn from restart loops.

The system cannot distinguish OOM from other SIGKILL causes (host kill, timeout kill), so all exit-137 events are treated equally.

### Memory Architecture

Three limits must be coordinated:

| Layer | Setting | Purpose |
|-------|---------|---------|
| Container memory | `CONTAINER_MEMORY_MB` in bot env | Podman `--memory`. Hard cgroup limit — kernel kills at this threshold. |
| V8 heap | `NODE_OPTIONS=--max-old-space-size=N` in Dockerfile | Caps V8 old-generation heap. Triggers GC pressure before cgroup kill. |
| Container reservation | `CONTAINER_MEMORY_RESERVATION_MB` in bot env | Podman `--memory-reservation`. Soft limit for scheduling. |

**Rule: V8 heap must be less than container memory.** Leave at least 2GB headroom for the Node.js runtime, MCP servers, spawned subprocesses, and file I/O buffers.

### Prevention Layers

1. **Session file size cap** — `SESSION_MAX_BYTES` (2MB) in agent-runner. When a session JSONL exceeds this limit, the old session file is left on disk and a new session is started. A system note is prepended to the current prompt so the bot is aware of the rotation. This avoids loading the large file via `--resume`, preventing OOM.
2. **V8 heap limit** — set in each bot's Dockerfile via `NODE_OPTIONS`. Must be large enough to deserialize a worst-case session but smaller than the container limit.
3. **Host-side exit-137 handling** — on exit 137, the host tracks consecutive kills per room via `kill137Consecutive` and enforces cooldown via `kill137CooldownUntil`. The session is cleared from memory (no toxic session loop).
4. **Session recovery skill** — bots extract memories from old session files using a Python script (avoids loading large JSONL into the main brain).
5. **Host memory watchdog** — the host process monitors its own RSS via `setInterval` and logs warnings when memory usage is high.

**Root cause: session resume.** Claude Code sessions are JSONL files. On resume, the SDK deserializes the entire file — 2-5x the file size in memory due to JavaScript object overhead. A 1.1MB session was enough to OOM a 4GB V8 heap.

**Key settings:** `CONTAINER_MEMORY_MB` (bot env), `NODE_OPTIONS=--max-old-space-size=N` (Dockerfile), `SESSION_MAX_BYTES` (agent-runner), `KILL_137_MAX_CONSECUTIVE` and `KILL_137_COOLDOWN_MS` (host main process).

## Message Size Handling

Messages that exceed Matrix size limits (`M_TOO_LARGE`) are automatically truncated to 16KB and retried. The private homeserver (Conduwuit) does not enforce rate limits, so no 429 backoff is needed.

## Container Isolation

Podman containers with memory caps, optional CPU limits. Network access is provided via `slirp4netns` (user-mode networking) — containers can reach external APIs (Anthropic, GitHub) but cannot access the host network directly.

## One Container Per Bot

The container spawn logic enforces this. Before each spawn, stale containers for the same bot/group are killed. On relay startup, orphaned containers from previous runs are cleaned up. Concurrency is handled internally via branch brains.

## MCP Connection

Agent-runner writes MCP server config to both `~/.claude/settings.json` (global) and `.mcp.json` (project-level) before launching Claude Code. Claude Code connects to MCP servers natively at startup. If a server is unreachable, Claude Code drops it and continues.

## Media Download Safety

The media download handler implements two layers of protection against oversized media:

1. **Content-Length pre-check** — if the server provides a `Content-Length` header exceeding `MEDIA_MAX_BYTES`, the response body is cancelled before any data is read.
2. **Streaming byte-count abort** — the response body is streamed directly to disk via `getReader()`. A running `bytesWritten` counter aborts the stream and deletes the partial file if the limit is exceeded mid-download.

This prevents unbounded memory buffering from adversarial or large media.

## Verification

1. **Exit-137 recovery** — Simulate a SIGKILL (kill container with code 137).
   *Check:* Host tracks kill count, bot restarts cleanly.

2. **Cooldown enforced** — Trigger 3 consecutive exit-137 events.
   *Check:* 60-second cooldown applied before next spawn attempt.

3. **Session rotation** — Session file exceeds 2MB.
   *Check:* New session created with system note, old session left on disk.

4. **Message truncation** — Send a message exceeding Matrix size limit.
   *Check:* Message truncated to 16KB, retry succeeds.

5. **MCP connection** — Start bot with an unreachable MCP server in mcp.json.
   *Check:* Claude Code drops the server at startup, bot continues without it.

6. **Media download limit** — Upload a file exceeding MEDIA_MAX_BYTES.
   *Check:* Download aborted, partial file cleaned up, bot not affected.
