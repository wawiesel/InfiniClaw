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
2. Agent-runner writes a relay task file: `_runtime/relay-tasks/thread-brain-*.json`
3. Relay picks up the file, calls `spawnThreadBrain()`
4. Relay posts announcement on main timeline: `🧵 Branch: {objective first line}`
5. Announcement event ID becomes the thread root
6. Relay spawns: `claude --print --verbose --output-format stream-json`
7. Branch brain streams output — each message posted into the Matrix thread
8. Captain can follow along or ignore

### Model Selection

The bot chooses which model to use from its configured branch models. For example, a bot with main=haiku and branch=[haiku, sonnet] might pick sonnet for a complex engineering task and haiku for a quick investigation. This is configured in the bot's persona and memory.

### Streaming Output

The relay parses `stream-json` format from the Claude CLI:
- `event.type === 'assistant'` with `event.message.content[].text` — posted as it arrives
- `event.type === 'result'` — fallback if no streaming output captured
- Messages posted individually (not batched)

### Concurrency Limit

`MAX_THREAD_BRAINS_PER_BOT` (default 3, configurable via env) caps concurrent branch brains per bot. Excess requests are rejected with a warning posted into the triggering thread.

### After Completion

When a branch brain exits:
1. 30-second debounce timer starts (reset if another branch exits)
2. After debounce: main bot wakes to pick up findings
3. Thread remains in Matrix history permanently

### Credentials

Branch brains receive credentials from the bot's env file:

| Bot env key | Branch brain env |
|-------------|-----------------|
| `BRAIN_OAUTH_TOKEN` | `CLAUDE_CODE_OAUTH_TOKEN` |
| `BRAIN_API_KEY` | `ANTHROPIC_API_KEY` |

Also inherits: `ANTHROPIC_BASE_URL`, `NODE_EXTRA_CA_CERTS`, `GH_TOKEN` (from `secrets/operator/github-bot.json` so PR reviews appear as the fleet bot account).

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
1. **Thread summary** — completion message in the thread
2. **Main timeline summary** — one-line result so the Captain sees the outcome without clicking into the thread
3. **Termination** — branch brain exits, thread remains in Matrix history

## Thread Reactivation

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
   *Check:* Thread appears in current room with `🧵 Branch: <title>`.

2. **Branch posts in thread** — Branch brain works on the task.
   *Check:* Progress appears inside the thread, not on main timeline.

3. **Main stays responsive** — While a branch is working, send another message.
   *Check:* Main brain responds immediately.

4. **Merge posts summary** — Branch brain completes.
   *Check:* One-line summary on main timeline. Completion message in thread.

5. **Thread reactivation** — Reply in a completed thread later.
   *Check:* New branch brain spawns with old context, answers the question.

6. **Concurrency limit** — Trigger more than `MAX_THREAD_BRAINS_PER_BOT` branches.
   *Check:* Excess rejected with warning.

7. **Lobe posts to quarters** — Bot delegates to a lobe.
   *Check:* Thread appears in quarters (not current room). Summary on quarters timeline when done.

8. **No nested branching** — Branch brain attempts to branch.
   *Check:* Rejected.
