# 01 — Messaging

## Message Flow

```
User message → Matrix → host message loop → SQLite → IPC to container
  → Main Brain reads new message as part of ongoing conversation
    → [IF COMPLEX] Main Brain calls branch_to_thread(objective)
      → Host creates visible thread on main timeline: "🧵 Working on: X"
      → Host spawns Thread Brain container wired to post into that thread
      → Thread Brain works, posts progress/results into thread (visible)
      → Thread Brain completes, posts summary to main timeline
      → Main Brain continues listening — never blocked
    → [IF SIMPLE] Main Brain replies directly on main timeline
```

## The Main Brain Is a Long-Lived Process

The main brain is a persistent `claude-code` process inside a running container. It does NOT exit after each message. New messages arrive via IPC into the same conversation — just like a human reading new messages in a chat. The main brain responds as part of its ongoing session.

This means:
- **No container spawn per message.** The container starts once and stays running.
- **Triage is instant.** Reading a new IPC message and deciding "branch or reply" is a normal conversation turn — sub-second, not 8 seconds.
- **Context accumulates.** The main brain remembers prior messages in its session. It doesn't start cold each time.

The host's job is to deliver messages to the running container via IPC, not to spawn new containers.

## Branching Is Visible

When the main brain decides to branch, the Captain must be able to see and follow the work:

1. Main brain calls `branch_to_thread` with an objective
2. The **host** creates a new thread on the main timeline with a clear subject (e.g. "🧵 Working on: V8 heap limits")
3. The host spawns a Thread Brain — a separate container whose `send_message` output is wired to post **into that thread**
4. Everything the Thread Brain does is visible in the thread: tool calls, progress updates, questions, results
5. The Captain can click into the thread at any time to follow along or reply
6. When the Thread Brain finishes, it posts a summary to both the thread and the main timeline

A thread brain that runs invisibly in the background is broken. The whole point of threads is visibility — the Captain can ignore them if busy, or dive in if interested.

## Message Routing

Bots see all room messages as context but only **respond** when it's their job.

**Response triggers:**
- **Main Timeline (CO Only):** The Commanding Officer responds to any unaddressed human message on the main timeline.
- **Callout:** Any message (human or bot) containing `BotName` triggers that bot.
- **Participating thread:** Posting in a thread where a bot's Thread Brain is active (or previously participated) triggers a response in that thread.

**Bot-to-bot communication:** The CO delegates tasks by tagging other bots in a thread. This triggers the other bot's Main Brain to spawn its own Thread Brain for the task.

## Message Filtering

Before routing, messages pass through filtering (`message-filtering.ts`):
- **Self-echo:** bots ignore their own messages.
- **Pattern filtering:** messages matching `IGNORE_PATTERNS` (status messages) are skipped.
