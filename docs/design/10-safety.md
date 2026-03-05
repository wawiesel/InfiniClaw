# 10 — Safety and Security

## OOM Handling

When a container exits with OOM (code 137), the system tracks consecutive OOMs per room. After 3 consecutive OOMs, a 60-second cooldown is enforced before the next container spawn. This prevents runaway token burn from restart loops.

### Memory Architecture

Three limits must be coordinated:

| Layer | Setting | Purpose |
|-------|---------|---------|
| Container memory | `CONTAINER_MEMORY_MB` in bot env | Podman `--memory`. Hard cgroup limit — kernel kills at this threshold. |
| V8 heap | `NODE_OPTIONS=--max-old-space-size=N` in Dockerfile | Caps V8 old-generation heap. Triggers GC pressure before cgroup kill. |
| Container reservation | `CONTAINER_MEMORY_RESERVATION_MB` in bot env | Podman `--memory-reservation`. Soft limit for scheduling. |

**Rule: V8 heap must be less than container memory.** Leave at least 2GB headroom for the Node.js runtime, MCP servers, spawned subprocesses, and file I/O buffers.

### Prevention Layers

1. **Session file size cap** — `SESSION_MAX_BYTES` (2MB) in agent-runner. Sessions exceeding this rotate to a fresh session with a summary carried forward.
2. **V8 heap limit** — set in each bot's Dockerfile via `NODE_OPTIONS`. Must be large enough to deserialize a worst-case session but smaller than the container limit.
3. **Host-side OOM handling** — on exit 137, the host clears the session from memory and database (no toxic session loop), tracks consecutive OOMs, enforces cooldown.
4. **Session recovery skill** — bots extract memories from old session files using a Python script (avoids loading large JSONL into the main brain).
5. **Context compaction** — during a running session, a `PreCompact` hook archives the full transcript to `conversations/` before Claude Code compresses context.

**Root cause: session resume.** Claude Code sessions are JSONL files. On resume, the SDK deserializes the entire file — 2-5x the file size in memory due to JavaScript object overhead. A 1.1MB session was enough to OOM a 4GB V8 heap.

**Key settings:** `CONTAINER_MEMORY_MB` (bot env), `NODE_OPTIONS=--max-old-space-size=N` (Dockerfile), `SESSION_MAX_BYTES` (agent-runner), `OOM_MAX_CONSECUTIVE` and `OOM_COOLDOWN_MS` (src/main.ts).

## Rate Limit Handling

Matrix 429 errors trigger adaptive backoff in the send queue. Messages that exceed Matrix size limits (`M_TOO_LARGE`) are automatically truncated rather than failing.

## Container Isolation

Podman containers with memory caps, optional CPU limits. No network egress to arbitrary hosts.

## One Container Per Bot

`group-queue.ts` enforces this. Stale containers from crashes are cleaned up before spawning. Interrupt lobes coexist via `containerNameTag`.

## MCP Preflight

Agent-runner runs a 5-second check on every remote MCP server at startup. Unreachable servers are dropped. Failure reports go to Engineering automatically.
