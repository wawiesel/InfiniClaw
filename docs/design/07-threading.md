# 07 — Threading and Lobes

InfiniClaw uses a "Branch and Merge" threading model. The main brain stays responsive on the main timeline. Complex work happens in visible Matrix threads via Thread Brains and async lobes.

## Architecture Overview

```
Main Brain (persistent claude-code in container)
  ├── Simple request → reply directly on main timeline
  ├── Complex request → branch_to_thread(objective)
  │     → Relay spawns Thread Brain on HOST (claude --print)
  │     → Thread Brain works in visible Matrix thread
  │     → On exit: main brain restarts to pick up findings
  └── Heavy lifting → delegate to async lobe
        → Agent-runner spawns lobe subprocess on HOST
        → Lobe writes result to IPC input dir
        → Main brain picks up result on next turn
```

## The Main Brain (The Trunk)

A persistent, long-lived `claude-code` process inside the container. It stays running and receives new messages via IPC as conversation turns.

- **Responsibility:** Read new messages, reply to simple ones, branch complex ones.
- **Responsiveness:** A triage decision is a normal conversation turn — sub-second. The main brain never does heavy work itself.
- **Action:** For complex requests, calls `branch_to_thread(objective)`. This tells the host to create a visible thread and spawn a Thread Brain. The main brain immediately continues listening.

## Thread Brains (The Branches)

Thread Brains run on the **host machine** — not inside containers. They are one-shot `claude --print` processes that stream output into a Matrix thread.

### How Branching Works

1. Main brain decides to branch and calls `branch_to_thread(objective, thread_id)`
2. Agent-runner writes a relay task file: `_runtime/relay-tasks/thread-brain-*.json`
3. Relay polls the relay-tasks directory, finds the file, calls `spawnThreadBrain()`
4. Relay posts announcement on main timeline: `🧵 Thread Brain: {objective first line}`
5. Announcement event ID becomes the thread root
6. Relay spawns: `claude --print --verbose --output-format stream-json` with the objective
7. Thread Brain streams output — each assistant message is posted into the Matrix thread
8. Captain can follow along in the thread or ignore it

### Streaming Output

The relay parses `stream-json` format from the Claude CLI:
- `event.type === 'assistant'` with `event.message.content[].text` — streamed as it arrives
- `event.type === 'result'` — fallback if no streaming output was captured
- Messages are posted to the thread individually (not batched)

### Concurrency Limit

`MAX_THREAD_BRAINS_PER_BOT` (default 3, configurable via env) caps concurrent Thread Brains per bot. If a bot already has 3 running, new requests are rejected with a warning posted into the triggering thread so the bot knows to wait.

### Thread Brain Credentials

Thread Brains receive credentials from the bot's env file:

| Bot env key | Thread Brain env |
|-------------|-----------------|
| `BRAIN_OAUTH_TOKEN` | `CLAUDE_CODE_OAUTH_TOKEN` |
| `BRAIN_API_KEY` | `ANTHROPIC_API_KEY` |

Also inherits: `ANTHROPIC_BASE_URL`, `NODE_EXTRA_CA_CERTS`, `GH_TOKEN` (from `secrets/operator/github-bot.json` so PR reviews appear as the fleet bot account).

### After Completion

When a Thread Brain exits:
1. 30-second debounce timer starts (reset if another TB exits)
2. After debounce: main bot restarts to pick up findings
3. Thread remains in Matrix history permanently

The debounce ensures the bot restart only fires once when multiple Thread Brains finish in quick succession.

## The Merge

When a Thread Brain completes its task:

1. **Thread Summary:** Post a completion message in the thread.
2. **Main Timeline Summary:** Post a one-line summary to the main timeline so the Captain sees the outcome without clicking into the thread.
3. **Termination:** Thread Brain exits. The thread remains in Matrix history permanently.

## Thread Reactivation (Immortal Context)

Matrix thread history is permanent. Thread Brains are ephemeral — they exit after completing their task. But the thread context is immortal.

If the Captain asks a follow-up in a completed thread days later:
1. The host detects the thread and the bot's previous participation.
2. The host spawns a new Thread Brain, hydrated with the thread's history from SQLite.
3. The Thread Brain answers the question in the thread and exits.

## Async Lobes (The Workers)

Single-purpose worker processes for heavy lifting. Lobes are spawned by the agent-runner via the delegate system — they run on the host, not inside the main brain container.

### Available Providers

| Provider | Default model | Alternatives |
|----------|--------------|--------------|
| `codex` | `gpt-5.3-codex` | `o3`, `o4-mini` |
| `gemini` | `gemini-3.1-pro-preview` | `gemini-2.5-flash` |
| `claude` | `sonnet` | `opus`, `haiku` |
| `ollama` | `qwen3:14b` | `qwen3:30b`, `devstral-small-2:24b` |

### Delegation Flow

1. Bot posts summary on main timeline or active thread (💭 + reason)
2. Summary event ID becomes the delegate thread root
3. Objective posted into delegate thread
4. Lobe subprocess spawned (fire-and-forget, unref'd)
5. Previous work thread restored immediately — bot is not blocked
6. On lobe exit: result written to `IPC input dir` as `result-{lobeId}.json`
7. Main brain picks up result on next turn

### Lobe Timeouts

| Timeout | Default | Max |
|---------|---------|-----|
| Delegate timeout | 15 min | 60 min |

Lobes do NOT post to Matrix directly. The main brain is responsible for reporting lobe results.

## Correct branch_to_thread Protocol

Bots must follow this sequence:

1. Post a conversational reply FIRST ("Got it, dispatching...")
2. Call `get_last_event_id` to get the real Matrix event ID (`$...` format)
3. Call `branch_to_thread` with that event ID and the objective
4. Say "Thread Brain dispatched." and STOP — do NOT dispatch more in the same turn

## Verification

1. **Branch creates thread** — Send a complex request to the bot.
   *Check:* A new thread appears on the main timeline with `🧵 Thread Brain: <title>`.

2. **Thread Brain posts in thread** — Thread Brain works on the task.
   *Check:* All progress and results appear inside the thread, not on main timeline.

3. **Main timeline stays responsive** — While a Thread Brain is working, send another message.
   *Check:* Main Brain responds immediately without waiting for Thread Brain to finish.

4. **Merge posts summary** — Thread Brain completes.
   *Check:* One-line summary appears on main timeline. Thread has completion message.

5. **Thread reactivation** — Reply in a completed thread days later.
   *Check:* New Thread Brain spawns, hydrated with old context, answers the question.

6. **Concurrency limit** — Trigger more than `MAX_THREAD_BRAINS_PER_BOT` branches.
   *Check:* Excess requests rejected with warning in the triggering thread.

7. **Lobe delegation** — Bot delegates heavy work to a lobe.
   *Check:* Lobe runs asynchronously. Result appears in IPC input. Main brain reports findings.

8. **Thread Brain credentials** — Thread Brain makes API calls.
   *Check:* Uses bot's credentials (not host user). PR reviews appear as fleet bot account.
