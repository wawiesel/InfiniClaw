# 01 — Messaging

## Message Flow

```
User message → Matrix → main.ts message loop → SQLite → processGroupMessages()
  → container-spawn.ts → podman container runs agent-runner
    → agent-runner calls Claude SDK → streams output markers to stdout
  → main.ts parses stdout → forwards to Matrix (progress + results)
  → working indicator: ⏳ working... → ⏳ working (Xm) → ⏳ worked (Xm)

Scheduled task → task-scheduler.ts poll → group-queue.ts
  → same container spawn path → output forwarded to Matrix

IPC command → container writes JSON to /workspace/ipc/output/
  → ipc-watcher.ts polls directory → processes command → writes response
```

## Message Routing

Bots see all room messages as context but only **respond** when it's their job. The host collects all bot Matrix user IDs at startup (`collectBotMatrixUserIds`) and uses them to distinguish human from bot messages.

**Response triggers:**
- **Callout** — a message (human or bot) contains `BotName` (case-insensitive word boundary match: `\bBotName\b`)
- **Participating thread** — someone posts in a thread the bot previously sent a message in
- **CO main timeline** — the commanding officer responds to any unaddressed human message on the main timeline

**Bot-to-bot communication:** Bots can trigger each other by including the target bot's name in the message. This enables natural collaboration — e.g. Cid says "Parker, what's the status?" and Parker's container spawns to respond. Bot messages without a callout are included as context but don't trigger a response.

**Thread participation** — a bot "participates" in a thread if it has previously sent a message there (`is_from_me = 1`). Messages from threads the bot doesn't participate in are excluded from context.

## Message Filtering

Before routing, messages pass through filtering (`message-filtering.ts`):
- **Self-echo** — bots ignore their own messages (`is_from_me` flag + content prefix).
- **Pattern filtering** — messages matching `IGNORE_PATTERNS` (system noise, status messages) are skipped.
- **Sender filtering** — messages from `IGNORE_SENDERS` are hidden entirely (optional, for edge cases).

## Message Queue

FIFO per room. One container at a time. `group-queue.ts` enforces this with overflow queueing and retry backoff.
