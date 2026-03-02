# Preventing OOM Kills

OOM (Out-Of-Memory) kills happen when a container's memory usage exceeds its cgroup limit. The kernel sends SIGKILL (exit code 137) with no warning and no chance for graceful shutdown.

## Memory Architecture

Each bot container has three memory limits that must be coordinated:

| Layer | Setting | Purpose |
|-------|---------|---------|
| Container memory | `CONTAINER_MEMORY_MB` in bot env | Podman `--memory` flag. Hard cgroup limit — kernel kills at this threshold. |
| V8 heap | `NODE_OPTIONS=--max-old-space-size=N` in Dockerfile | Caps V8's old-generation heap. Triggers GC pressure before cgroup kill. |
| Container reservation | `CONTAINER_MEMORY_RESERVATION_MB` in bot env | Podman `--memory-reservation`. Soft limit for scheduling. |

**Rule: V8 heap must be less than container memory.** V8 heap is the biggest consumer, but the process also needs memory for the Node.js runtime, MCP servers, spawned subprocesses, file I/O buffers, and the operating system. Leave at least 2GB headroom.

Example for a heavy bot (Navigator):
```
CONTAINER_MEMORY_MB=10240      # 10 GB hard limit
NODE_OPTIONS=--max-old-space-size=8192  # 8 GB V8 heap
CONTAINER_MEMORY_RESERVATION_MB=4096   # 4 GB soft reservation
```

Example for a light bot (Engineer):
```
CONTAINER_MEMORY_MB=6144       # 6 GB hard limit
NODE_OPTIONS=--max-old-space-size=4096  # 4 GB V8 heap
CONTAINER_MEMORY_RESERVATION_MB=4096
```

## Why OOM Happens

### Session resume is the #1 cause

Claude Code sessions are stored as JSONL files (one JSON line per conversation turn). When a session is resumed, the SDK reads the entire file into memory and deserializes every message into JavaScript objects. Memory consumption during resume is:

- **2-5x the file size** due to JavaScript object overhead (property metadata, string encoding, prototype chains)
- **Unpredictable** — a 1MB session with many large tool outputs (file reads, web scrapes, PDF extractions) can consume 3-8 GB when deserialized
- **Spikey** — the deserialization creates temporary objects that GC hasn't collected yet, causing peak memory far above steady-state

A 1.1MB / 468-turn session with a 160KB largest single turn was enough to OOM a container with a 4GB V8 heap.

### Other memory consumers

- **MCP servers** — each MCP server is a subprocess consuming memory. The Google Workspace MCP server alone has caused OOM in Navigator containers.
- **Tool output buffering** — large Bash outputs, file reads, and web fetches are held in memory during processing
- **Lobe spawns** — `delegate_to_lobe` spawns a subprocess (Claude Code, Codex, or Gemini) inside the container
- **Browser automation** — Chromium via agent-browser is extremely memory-hungry

### What does NOT cause OOM

- **API context window** — Claude Code compresses conversation context when it approaches the API's token limit (200K). This is about tokens sent to the API, not memory usage. The full conversation still lives in memory.
- **Session file size alone** — The agent-runner caps sessions at 2MB (`SESSION_MAX_BYTES`). But 2MB of JSONL can still OOM if the V8 heap is too small.

## Prevention Layers

### Layer 1: Session file size cap (agent-runner)

`SESSION_MAX_BYTES = 2 * 1024 * 1024` in `external/nanoclaw/container/agent-runner/src/index.ts`

When a session file exceeds 2MB, the agent-runner rotates to a fresh session with a summary carried forward. This is the first line of defense.

**To adjust:** Change `SESSION_MAX_BYTES`. Reducing to 1MB gives more safety margin at the cost of more frequent context loss.

### Layer 2: V8 heap limit (Dockerfile)

Set in each bot's Dockerfile via `NODE_OPTIONS`. Must be large enough to deserialize a 2MB session (worst case ~8-10GB) but small enough to leave headroom within the container memory limit.

**Guidelines:**
- Bots that do heavy research (Navigator, Commander): 8GB heap, 10GB container
- Bots that do code work (Engineer, Architect): 4GB heap, 6GB container
- Never set V8 heap equal to container memory

### Layer 3: OOM error handling (host)

When a container exits with code 137:

1. `container-runner.ts` resolves as `status: 'error'` (never success, even if streaming output was delivered)
2. `main.ts` does NOT re-store the session ID when the run was an error
3. The OOM handler in `handleMessageBatch` clears the session from both the in-memory map and the database
4. Consecutive OOM tracking kicks in: after 3 consecutive OOMs on the same group, a cooldown period prevents restart loops

This means the bot starts fresh after an OOM — no toxic session loop.

### Layer 4: Session recovery skill

Bots have a `recover-session` skill that extracts memories from old session files using a Python script (to avoid loading large JSONL into the main brain). After OOM, bots can recover key learnings without resuming the toxic session.

### Layer 5: Context compaction (Claude Code)

During a running session, Claude Code fires a `PreCompact` hook when context pressure builds. The agent-runner's hook archives the full transcript to `conversations/` as a markdown file before compaction. This preserves the conversation history even after context is compressed.

## Operational Procedures

### Monitoring session sizes

```bash
# Check all session file sizes
find _runtime/instances/*/data/sessions/main/.claude/projects/-workspace-group/ \
  -name "*.jsonl" -exec ls -lh {} \;

# Check session IDs stored in DB
for db in _runtime/instances/*/store/messages.db; do
  bot=$(echo "$db" | cut -d/ -f4)
  session=$(sqlite3 "$db" "SELECT session_id FROM sessions WHERE group_folder='main';" 2>/dev/null)
  echo "$bot: ${session:-none}"
done
```

### Clearing a toxic session

If a bot is stuck in an OOM loop (should be auto-handled by the fix, but as a manual fallback):

```bash
# 1. Stop the bot
npm run cli stop

# 2. Clear session from DB
sqlite3 _runtime/instances/<bot>/store/messages.db \
  "DELETE FROM sessions WHERE group_folder = 'main';"

# 3. Optionally archive the session file
mv _runtime/instances/<bot>/data/sessions/main/.claude/projects/-workspace-group/<sessionId>.jsonl \
   _runtime/instances/<bot>/data/sessions/main/.claude/projects/-workspace-group/archive/

# 4. Start the bot
npm run cli start
```

### Reducing OOM risk for a specific bot

1. **Increase memory** — edit the bot's `env` file: `CONTAINER_MEMORY_MB=10240`
2. **Increase V8 heap** — edit the bot's Dockerfile: `ENV NODE_OPTIONS="--max-old-space-size=8192"`
3. **Reduce session cap** — lower `SESSION_MAX_BYTES` (affects all bots)
4. **Delegate heavy work** — instruct the bot to use lobes for large file processing, web scraping, and PDF extraction. Lobes run in separate processes with separate memory.

### After an OOM event

1. Check `_runtime/logs/<bot>.err` for the OOM kill line
2. Check `_runtime/instances/<bot>/groups/main/logs/container-*.log` for the last container's activity
3. If the session was auto-cleared (check DB), the bot should start fresh on next message
4. If the bot used `recover-session`, check its memory files for extracted learnings
5. If OOMs persist, increase memory or reduce session cap

## Configuration Reference

| Setting | Location | Default | Notes |
|---------|----------|---------|-------|
| `CONTAINER_MEMORY_MB` | Bot env file | 6144 | Podman hard limit |
| `CONTAINER_MEMORY_RESERVATION_MB` | Bot env file | 4096 | Podman soft limit |
| `NODE_OPTIONS` | Bot Dockerfile | `--max-old-space-size=4096` | V8 heap cap |
| `SESSION_MAX_BYTES` | agent-runner/src/index.ts | 2MB | Session rotation threshold |
| `OOM_MAX_CONSECUTIVE` | src/main.ts | 3 | Consecutive OOMs before cooldown |
| `OOM_COOLDOWN_MS` | src/main.ts | 60000 | Cooldown after consecutive OOMs |

## Historical OOM Events

From fleet health monitoring (as of 2026-03-01):
- Commander (Johnny5): 22 OOMs
- Engineer (Cid): 22 OOMs
- Navigator (Nora): 14 OOMs
- Architect (Albert): 0 OOMs (but 16K errors)
- Parker: 0 OOMs

Most OOMs traced to: large session resume after long research sessions (file reads, web scrapes, PDF processing accumulating in the session).
