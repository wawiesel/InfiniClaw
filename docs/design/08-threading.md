# 08 — Threading

InfiniClaw uses a "Branch and Merge" model. The main brain stays responsive on the main timeline. Complex work happens in visible Matrix threads via branch brains and lobes (see [06-brain](06-brain.md) for the brain taxonomy).

## Branch and Merge Overview

```
Main Brain (persistent, in container)
  ├── Simple request → reply on main timeline
  ├── Complex request → branch_to_thread(objective)
  │     → Relay spawns Branch Brain on HOST (claude --print)
  │     → Branch Brain streams into visible Matrix thread
  │     → On exit: bot wakes to pick up findings
  └── Heavy/async work → invoke lobe MCP tool
        → Lobe works in a quarters thread (any provider)
        → On completion: summary posted to quarters main timeline
        → Bot picks up result naturally
```

## Branch Brains

Branch brains run on the **host machine** — not inside containers. They are one-shot `claude --print` processes that stream output into a Matrix thread in the bot's current room.

### How Branching Works

1. Main brain calls `branch_to_thread(objective, thread_id)`
2. Agent-runner writes a relay task file: `_runtime/relay-tasks/branch-brain-*.json`
3. Relay picks up the file, calls `spawnBranchBrain()`
4. Relay posts announcement on main timeline: `🧵 Branch Brain: {objective first line}`
5. Announcement event ID becomes the thread root
6. Relay spawns: `claude --print --verbose --dangerously-skip-permissions --output-format stream-json --add-dir {resolveRoot()}`
7. Branch brain streams output — each message posted into the Matrix thread
8. Captain can follow along or ignore

### Model Selection

> **Status:** Per-task model selection is **not yet implemented**. Branch brains use whichever Claude model is configured as the default in the host CLI environment. The design intent is for the bot's persona/memory to specify per-task model selection (e.g., sonnet for complex engineering, haiku for quick lookups), but no model selection logic currently exists in `spawnBranchBrain`.

### Streaming Output

The relay parses `stream-json` format from the Claude CLI:
- `event.type === 'assistant'` with `event.message.content[].text` — posted as it arrives
- `event.type === 'result'` — fallback if no streaming output captured
- Messages posted individually (not batched)

### Concurrency Limit

`MAX_BRANCH_BRAINS_PER_BOT` (default 3, configurable via env) caps concurrent branch brains per bot. Excess requests are rejected with a warning posted into the triggering thread.

### After Completion

When a branch brain exits:
1. 30-second debounce timer starts (reset if another branch exits within the window)
2. After debounce: relay posts main-timeline summary: `🧵 {title} — ✅ done` or `🧵 {title} — ⛔ failed`
3. Relay restarts the main bot so it picks up branch brain findings
4. Thread remains in Matrix history permanently

### Notes File

Each branch brain receives a system prompt that includes a notes file path:
```
_runtime/data/thread-notes/{announcementEventId}.md
```
If the branch brain discovers persistent findings worth saving (architectural decisions, inventory results, etc.), it writes them as Markdown to this file. The relay may inject this content as context on the next bot restart. Branch brains that have nothing persistent to record skip the file.

### Credentials

Branch brains receive credentials from the bot's env file. The relay checks keys in this priority order:

| Check order | Source key | Branch brain env |
|-------------|------------|-----------------|
| 1st | `CLAUDE_CODE_OAUTH_TOKEN` | `CLAUDE_CODE_OAUTH_TOKEN` |
| 2nd (fallback) | `BRAIN_OAUTH_TOKEN` | `CLAUDE_CODE_OAUTH_TOKEN` |
| 1st | `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` |
| 2nd (fallback) | `BRAIN_API_KEY` | `ANTHROPIC_API_KEY` |

Also inherits: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `NODE_EXTRA_CA_CERTS`, `GH_TOKEN` (from `secrets/operator/github-bot.json` so PR reviews appear as the fleet bot account).

`CLAUDECODE` env var is deleted before spawning to prevent nested Claude Code rejection.

### Branch Brain Upgrade: Full Interactive Session

> **Status:** Not yet implemented. Current implementation uses one-shot `claude --print`.

The planned upgrade replaces one-shot `claude --print` with a full nanoclaw group container session. Upgraded branch brains:

- **Resumable** — session ID stored in todo entry for context recovery on relay restart
- **Interactive** — receives new messages from the relay via IPC (same mechanism as main brain)
- **Time-limited** — 10-minute countdown (`BRANCH_BRAIN_TIMEOUT_MS`); relay sends interrupt when expired, branch brain gets ~30s to finalize
- **Titled** — thread title derived from the todo item content

### Context Injection

> **Status:** Not yet implemented.

When a message arrives on the main timeline, the relay fans it out to all active branch brain IPC queues with:

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
1. **Thread summary** — completion message in the thread (or "completed with no output" if nothing was posted)
2. **Main-timeline summary** — after 30s debounce: `🧵 {title} — ✅ done` / `⛔ failed` posted on main timeline
3. **Bot restart** — main bot restarts to pick up findings
4. **Termination** — branch brain exits, thread remains in Matrix history

## Thread Reactivation

> **Status:** Thread reactivation is not yet implemented. Currently, completed threads cannot spawn new branch brains from follow-up messages.

Matrix threads are permanent. Branch brains are ephemeral. But the thread context is immortal.

If the Captain asks a follow-up in a completed thread:
1. The host detects the thread and the bot's previous participation
2. A new branch brain spawns, hydrated with the thread's history
3. The branch brain answers in the thread and exits

## Correct branch_to_thread Protocol

Bots must follow this sequence:

1. Post a conversational reply FIRST ("Got it, dispatching...")
2. Call `get_last_event_id` to get the real Matrix event ID (`$...` format)
3. Call `branch_to_thread` with that event ID and the objective
4. Say "Branch dispatched." and STOP — do NOT dispatch more in the same turn

## Verification

1. **Branch creates thread** — Send a complex request.
   *Check:* Thread appears in current room with `🧵 Branch Brain: <title>`.

2. **Branch posts in thread** — Branch brain works on the task.
   *Check:* Progress appears inside the thread, not on main timeline.

3. **Main stays responsive** — While a branch is working, send another message.
   *Check:* Main brain responds immediately.

4. **Merge posts summary** — Branch brain completes.
   *Check:* Completion message in thread. After 30s debounce: `🧵 <title> — ✅ done` on main timeline.

5. **Thread reactivation** — Reply in a completed thread later. *(Not yet implemented.)*
   *Check:* New branch brain spawns with old context, answers the question.

6. **Concurrency limit** — Trigger more than `MAX_BRANCH_BRAINS_PER_BOT` branches.
   *Check:* Excess rejected with warning.

7. **Lobe posts to quarters** — Bot delegates to a lobe.
   *Check:* Thread appears in quarters (not current room). Summary on quarters timeline when done.

8. **No nested branching** — Branch brain attempts to branch.
   *Check:* Rejected.
