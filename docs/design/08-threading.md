# 08 — Threading

InfiniClaw uses a "Branch and Merge" model. The main brain stays responsive on the main timeline. Complex work happens in visible Matrix threads via branch brains and lobes (see [06-brain](06-brain.md) for the brain taxonomy).

## Branch and Merge Overview

```
Main Brain (persistent, in container)
  ├── Simple request → reply on main timeline
  ├── Complex request → branch_to_thread(objective)
  │     → Bot posts thread title on main timeline
  │     → Relay forks bot's session via claude --fork-session
  │     → Fork streams into visible Matrix thread (same room as bot)
  │     → On exit: merge message posted, bot assimilates results
  └── Heavy/async work → invoke lobe MCP tool
        → Lobe works in a quarters thread (any provider)
        → On completion: summary posted to quarters main timeline
        → Bot picks up result naturally
```

## Branch Brains

Branch brains run as isolated **podman containers** when `BRANCH_BRAIN_IMAGE` is set (default: `localhost/infiniclaw-branch-brain:latest`). They are interactive `claude` processes (stdin open) that stream output into a Matrix thread in the bot's current room. Set `BRANCH_BRAIN_IMAGE=` (empty) to fall back to host-side spawn.

### How Branching Works

1. Main brain calls `branch_to_thread(objective, thread_id)`
2. Agent-runner writes a relay task file: `_runtime/relay-tasks/branch-brain-*.json`
3. Relay picks up the file, calls `spawnBranchBrain()`
4. Relay posts announcement on main timeline: `🧵 Branch Brain: {objective first line}`
5. Announcement event ID becomes the thread root
6. Relay finds the bot's latest session ID from `_runtime/instances/{bot}/data/sessions/main/.claude/`
7. Relay spawns container: `podman run --rm -i --network slirp4netns --memory 2g` with `--continue --fork-session` to inherit the main brain's context. Falls back to host `claude` if `BRANCH_BRAIN_IMAGE` unset
8. Branch brain streams assistant output — each text block posted into the Matrix thread as it arrives
9. Captain can follow progress in real-time or ignore

### Model Selection

The bot chooses which model to use from its configured branch models. For example, a bot with main=haiku and branch=[haiku, sonnet] might pick sonnet for a complex engineering task and haiku for a quick investigation. This is configured in the bot's persona and memory.

### Streaming Output

The relay parses `stream-json` format from the Claude CLI:
- `event.type === 'assistant'` with `event.message.content[].text` — posted as it arrives
- `event.type === 'result'` — fallback if no streaming output captured
- Messages posted individually (not batched)

### Concurrency Limit

`MAX_BRANCH_BRAINS_PER_BOT` (default 3, configurable via env) caps concurrent branch brains per bot. Excess requests are rejected with a warning posted into the triggering thread.

### After Completion

When a branch brain exits:
1. Merge message posted to the thread — a normal Matrix message with any level of detail the BB chooses (summary, full results, code snippets, etc.)
2. Main timeline summary posted: `🧵 <title> — ✅ done` (or `⛔ failed`)
3. Thread remains in Matrix history permanently
4. No restart needed — the main brain assimilates results on its next turn

### Credentials

Branch brains receive credentials from the bot's env file:

| Bot env key | Branch brain env |
|-------------|-----------------|
| `BRAIN_OAUTH_TOKEN` | `CLAUDE_CODE_OAUTH_TOKEN` |
| `BRAIN_API_KEY` | `ANTHROPIC_API_KEY` |

Also inherits: `ANTHROPIC_BASE_URL`, `NODE_EXTRA_CA_CERTS`, `GH_TOKEN` (from `secrets/operator/github-bot.json` so PR reviews appear as the fleet bot account).

### Full Interactive Session

Branch brains run as interactive sessions with full context from the main brain:

- **Forked context** — uses `--continue --fork-session` to inherit the main brain's full conversation history. The BB starts already knowing everything the main brain knows.
- **Interactive** — stdin stays open. The relay can inject context (main timeline messages) during execution.
- **Time-limited** — `BRANCH_BRAIN_TIMEOUT_MS` (default 10 min); relay sends interrupt when expired, BB gets ~30s (`BRANCH_BRAIN_FINALIZE_MS`) to finalize before SIGKILL.
- **Resumable** — session ID stored in `branch-tasks.json` for relay restart recovery.

### Context Injection

When a message arrives on the main timeline, the relay fans it out to all active branch brain stdin pipes with:

```
You are branch brain <title>. Here is a message from main timeline: <msg>. It may not apply to you. If it does, modify your task accordingly.
```

Branch brain responds in its thread if relevant; ignores silently if not.

## Lobes

Lobes are MCP tools that spawn non-blocking workers using any provider. Unlike branch brains, lobes do not receive the full conversation context — only what the bot explicitly passes.

### Available Providers

| Provider | Examples |
|----------|----------|
| `codex` | `gpt-5.3-codex`, `o3`, `o4-mini` |
| `gemini` | `gemini-3.1-pro-preview`, `gemini-2.5-flash` |
| `claude` | `sonnet`, `opus`, `haiku` |
| `ollama` | `qwen3:14b`, `qwen3:30b`, `devstral-small-2:24b` |

### Lobe Flow

1. Main or branch brain invokes the lobe MCP tool with an objective and context
2. Lobe spawns on the host (fire-and-forget)
3. Lobe posts progress into a thread in the bot's **quarters room** via loudspeaker
4. On completion: lobe posts a summary to the **quarters main timeline**
5. Bot picks up the summary naturally if active (quarters uses `triggerType: always`)
6. Bot can use Matrix navigation tools to fetch the lobe thread and investigate further

Lobes always post to quarters regardless of which room the bot is currently in. This keeps lobe output separate from the bot's active work context.

## The Merge

When a branch brain completes:
1. **Merge message** — BB posts a normal Matrix message in the thread with its results. This can be any level of detail: a one-line summary, full analysis, code snippets, or structured output. The BB decides the format.
2. **Main timeline summary** — `🧵 <title> — ✅ done` (or `⛔ failed`) posted on main timeline so the Captain sees the result without watching the thread
3. **Assimilation** — the main brain MUST process BB results on its next turn. This is enforced via MCP: the relay queues a merge event that the main brain receives as a message, containing the thread ID and summary. The bot reads the thread and decides how to incorporate the findings.
4. **No restart needed** — the main brain assimilates results naturally. A restart is never necessary.
5. **Termination** — branch brain fork exits, thread remains in Matrix history permanently

## Thread Reactivation

Matrix threads are permanent. Branch brains are ephemeral. But the thread context is immortal.

When the Captain sends a follow-up in a completed BB thread:
1. The relay detects the message is in a thread the bot previously completed
2. A new branch brain spawns with the original objective + follow-up message as context
3. The branch brain answers in the thread and exits normally

Completed threads are tracked in `_runtime/data/branch-tasks.json` with a 4-hour TTL. The registry is pruned on every read.

## Correct branch_to_thread Protocol

Bots must follow this exact sequence:

1. Post a thread title on the main timeline FIRST (e.g. "Branching: fix the display formatting")
2. Call `get_last_event_id` — this returns both `lastSent` and `lastReceived`
3. Use **`lastSent`** as the thread_id (your title post). **NEVER use `lastReceived`** — that is the Captain's message, branching off it creates a broken thread
4. Call `branch_to_thread(objective, thread_id)` with the `lastSent` event ID
5. Say "Branch dispatched." and STOP — do NOT dispatch more in the same turn

**Critical:** The thread root is YOUR title post, not the Captain's message. The bot owns the thread.

## Verification

1. **Branch creates thread** — Send a complex request.
   *Check:* Thread appears in current room with `🧵 Branch Brain: <title>`.

2. **Branch posts in thread** — Branch brain works on the task.
   *Check:* Progress appears inside the thread, not on main timeline.

3. **Main stays responsive** — While a branch is working, send another message.
   *Check:* Main brain responds immediately.

4. **Merge posts summary** — Branch brain completes.
   *Check:* Completion message in thread; `🧵 <title> — ✅ done` appears on main timeline after 30s.

5. **Thread reactivation** — Reply in a completed thread later.
   *Check:* New branch brain spawns with original objective + follow-up as context, answers in thread.

6. **Concurrency limit** — Trigger more than `MAX_BRANCH_BRAINS_PER_BOT` branches.
   *Check:* Excess rejected with warning.

7. **Lobe posts to quarters** — Bot delegates to a lobe.
   *Check:* Thread appears in quarters (not current room). Summary on quarters timeline when done.

8. **No nested branching** — Branch brain attempts to branch.
   *Check:* Rejected.
