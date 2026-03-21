# 08 — Threading

InfiniClaw uses a "Branch and Merge" model. The main brain stays responsive on the main timeline. Complex work happens in visible Matrix threads via branch brains and lobes (see [06-brain](06-brain.md) for the brain taxonomy).

## Branch and Merge Overview

```
Main Brain (persistent, in container)
  ├── Simple request → reply on main timeline
  ├── Complex request → branch_to_thread(objective)
  │     → Bot posts 🌿 thread title on main timeline
  │     → Bot spawns branch (forks session, streams output into thread)
  │     → Main timeline messages injected into branch while running
  │     → On finish: branch posts 🪾 merge marker, injects summary into main history
  └── Heavy/async work → invoke lobe MCP tool
        → Lobe works in a quarters thread (any provider)
        → On completion: summary posted to quarters main timeline
        → Bot picks up result naturally
```

## Branch Brains

Branch brains are spawned directly by the bot — the relay does not announce or spawn them. They are interactive `claude` processes (stdin open) that stream output into a Matrix thread in the bot's current room.

**Constraint:** A branch brain can be spawned anywhere a bot is active **except inside a thread**. Branching from within a thread is not allowed (no nested threads).

### Signature

```
branch_to_thread(title, objective)
```

| Param | Description |
|---|---|
| `title` | Short keyword label — used for the 🌿 post and 🪾 merge marker |
| `objective` | Full objective passed to the branch brain |

The tool posts the `🌿 title — objective` thread header automatically. Model is fixed (not a parameter) for prompt caching reasons. Room is implicit (the bot's current room). Timeout is fixed per-env (`BRANCH_BRAIN_TIMEOUT_MS`).

### How Branching Works

1. Bot calls `branch_to_thread(title, objective)`
2. Tool posts `🌿 <title> — <objective>` on the target room's main timeline
3. Branch is spawned, forks the bot's session (`--continue --fork-session`) to inherit full context
4. Branch streams output into the Matrix thread as it arrives
5. Captain can converse with the branch normally while it runs
6. Bot says "Branch dispatched." and stops inline work

**Ralph loop:** After every turn, the branch's purpose is re-injected into the branch context. This ensures the branch never loses track of its objective, regardless of how much other context accumulates during a long-running session.

### Model Selection

Model is fixed per bot for prompt caching — not selectable per branch call. Configured in the bot's persona/env.

### Main Timeline Injection

While a branch is running, all messages on the main timeline are injected into the branch's stdin so the branch stays aware of main context. This includes messages from the Captain, other bots, and the same Matrix bot — every message in the room identified by `room_id` is injected, without exception. The main brain does NOT receive thread context while the branch is running.

### Thread Conversation

Messages sent in the thread are added to the branch's conversation naturally, exactly as they would be in a normal Claude conversation. The branch sees thread replies as direct conversation turns — no special injection or formatting is applied.

### Merge and Thread Closure

When the branch finishes:
1. Branch posts `🪾 <keyword> — <full result description>` as the merge marker in the thread
2. Branch injects its final summary into main brain history — so the main brain has the result in context even though it came from the branch
3. Thread is now **closed** — no further posting allowed. Any new message in that thread receives a loudspeaker reply with title and thread ID (see Thread Closure below)
4. Main timeline summary posted: `🪾 <keyword> — ✅ merged` (or `⛔ failed`)

### Concurrency Limit

`MAX_BRANCH_BRAINS_PER_BOT` (default 3, configurable via env) caps concurrent branch brains per bot. Excess requests are rejected with a warning posted into the triggering thread.

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

Branch brains use `--input-format stream-json` so stdin stays open for context injection. When a message arrives on the main timeline from any sender (Captain, bots, main brain), the relay fans it out to all active branch brain stdin pipes as a stream-json `user_message`:

```json
{"type":"user_message","content":"You are branch brain <title>. Here is a message from main timeline: <msg>. It may not apply to you. If it does, modify your task accordingly."}
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
1. **Merge marker in thread** — BB posts `🪾 <keyword> — <full result description>` at the end of the thread. This closes the thread.
2. **Main timeline summary** — `🪾 <keyword> — ✅ merged` (or `⛔ failed`) posted on main timeline so the Captain sees the result without watching the thread.
3. **Assimilation** — the branch injects its final summary into main brain history via IPC, so the main brain has the result in context even though it came from the branch.
4. **No restart needed** — the main brain assimilates results naturally. A restart is never necessary.
5. **Termination** — branch brain fork exits, thread remains in Matrix history permanently.

## Thread Closure

After a branch merges, the thread is **dead**. No further productive posting is allowed.

When anyone sends a message in a completed BB thread, the relay responds via loudspeaker:

```
📢 Thread closed (<title>) [<thread_event_id>] — branch merged. Start a new branch for follow-up.
```

Example as seen on Engineering00:
```
loudspeaker00: 📢 Thread closed (BB-demo-captain) [$MDvDGuYiX3kVrO5mx-SCjTTPmSwk35f1i6JjiWE-TPQ] — branch merged. Start a new branch for follow-up.
```

Completed threads are tracked in `_runtime/data/branch-tasks.json` with a 4-hour TTL. The registry is pruned on every read.

## Correct branch_to_thread Protocol

One call — the tool handles the thread title post automatically:

1. Call `branch_to_thread(title, objective)`
2. Say "Branch dispatched." and STOP — do not dispatch more in the same turn
3. Cannot be called from inside a thread

The tool posts `🌿 <title> — <objective>` on the main timeline and uses that event as the thread root. No manual `get_last_event_id` or title posting needed.

## Signals Integration

Thread routing for non-branch messages uses the Signals protocol (see [22-signals](22-signals.md)). Bots use `{{send thread="$eventId"}}` to route a message to a specific thread, or rely on default echo-back routing (response goes to wherever the message came from). The `set_thread` MCP tool is deprecated in favor of Signals.

## Verification

1. **Branch creates thread** — Send a complex request.
   *Check:* Thread appears in current room with `🌿 <title> — <purpose>`.

2. **Branch posts in thread** — Branch brain works on the task.
   *Check:* Progress appears inside the thread, not on main timeline.

3. **Main stays responsive** — While a branch is working, send another message.
   *Check:* Main brain responds immediately.

4. **Context injection** — While a branch is running, post on main timeline.
   *Check:* Branch receives the message via stdin injection.

5. **Merge posts summary** — Branch brain completes.
   *Check:* `🪾 <keyword> — <result>` in thread; `🪾 <keyword> — ✅ merged` on main timeline.

6. **Thread closure** — Reply in a completed thread.
   *Check:* Loudspeaker responds `📢 Thread closed (<title>) [<thread_event_id>] — branch merged.`

7. **Concurrency limit** — Trigger more than `MAX_BRANCH_BRAINS_PER_BOT` branches.
   *Check:* Excess rejected with warning.

8. **Lobe posts to quarters** — Bot delegates to a lobe.
   *Check:* Thread appears in quarters (not current room). Summary on quarters timeline when done.

9. **No nested branching** — Branch brain attempts to branch.
   *Check:* Rejected.
