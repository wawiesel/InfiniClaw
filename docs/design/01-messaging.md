# 01 — Messaging

## Message Flow

```
User message → Matrix → main.ts message loop → SQLite → processGroupMessages()
  → Main Brain (Trunk) triage Turn (2s)
    → [IF COMPLEX] branch_to_thread() tool
      → Thread Brain (Branch) process spawned in container
        → Thread Brain performs work (with Async Lobes)
        → Thread Brain reviews with CO
        → Thread Brain merges to MEMORY.md
    → [IF SIMPLE] Main Brain replies directly
```

## Non-Blocking Architecture

The fundamental design of InfiniClaw messaging is **responsiveness**. 

1.  **The Trunk (Main Brain):** Every bot runs a primary `claude-code` process that is strictly for triage. It never performs long-running bash commands. If a turn takes more than 2 seconds, it is a design failure.
2.  **The Branch (Thread Brain):** Real work is performed by parallel `claude-code` processes spawned inside the same container, locked to specific Matrix threads.
3.  **No SIGTERM:** New messages from the Captain never trigger a `SIGTERM`. They are enqueued via IPC. The Main Brain (being non-blocking) fetches them within seconds natively.

## Message Routing

Bots see all room messages as context but only **respond** when it's their job. 

**Response triggers:**
- **Main Timeline (CO Only):** The Commanding Officer responds to any unaddressed human message on the main timeline.
- **Callout:** Any message (human or bot) containing `BotName` triggers that bot's Main Brain.
- **Participating thread:** Posting in a thread where a bot's Thread Brain is active (or previously participated) triggers a response in that thread.

**Bot-to-bot communication:** The CO delegates tasks by tagging other bots in a thread. This triggers the other bot's Main Brain to spawn its own Thread Brain for the task.

## Message Filtering

Before routing, messages pass through filtering (`message-filtering.ts`):
- **Self-echo:** bots ignore their own messages.
- **Pattern filtering:** messages matching `IGNORE_PATTERNS` (status messages) are skipped.
- **Status indicators:** `⏳ working` indicators from other bots are used for anti-echo-chamber coordination.

