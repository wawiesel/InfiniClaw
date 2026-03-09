# 04 — Bot

A bot is a Matrix account backed by a container running on a ship. It listens to room messages, responds when triggered, and accumulates context from everything it hears.

## Trigger Pattern

The trigger pattern is `\b<bot>\b` (case-insensitive). A bot responds when its name appears as a whole word anywhere in a message.

### Response Rules

- **Main timeline + trigger match** → bot responds in a **new thread**.
- **In-thread + trigger match** → bot responds in that thread.
- **Any message without trigger** → bot does NOT respond, but the message IS added to context. The bot "hears" everything.
- **Bot's own messages** → ignored (echo prevention).

Filtering is about **what triggers a response**, not about **what enters context**. Everything enters context. The trigger just determines whether the bot takes a turn.

### Additional Filters

Before routing, messages pass through filtering (`message-filtering.ts`):
- **Self-echo:** bots ignore their own messages.
- **Pattern filtering:** messages matching `IGNORE_PATTERNS` (status messages) are skipped from context.

## Display Name

Bots set their Matrix display name to show status at a glance:

```
<name> <pip> [<ship>]
```

Examples: `Cid 🟢 [HERACLES]`, `Parker ⭐ [HERACLES]`, `Nora 💤 [Poseidon]`

See [08-roles-and-rooms](08-roles-and-rooms.md) for the full status/pip table.

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

## Message Routing

Bots see all room messages as context but only **respond** when it's their job.

**Response triggers:**
- **Main Timeline (CO Only):** The Commanding Officer responds to any unaddressed human message on the main timeline.
- **Callout:** Any message containing `\b<bot>\b` (case-insensitive) triggers that bot.
- **Participating thread:** Posting in a thread where a bot's Thread Brain is active (or previously participated) triggers a response in that thread.

**Bot-to-bot communication:** The CO delegates tasks by tagging other bots in a thread. This triggers the other bot's Main Brain to spawn its own Thread Brain for the task.

## Verification

1. **Account exists** — Bot's Matrix account can log in.
   *Check:* `POST /_matrix/client/v3/login` returns access token.

2. **Joined to room** — Bot appears in duty room member list.
   *Check:* Room members API includes the bot's user ID.

3. **Hears messages** — Send a message in the room, bot's log shows it received.
   *Check:* Log contains the message content.

4. **Trigger works** — Send `@Cid hello` in the room.
   *Check:* Bot processes the message and responds in a thread.

5. **Non-trigger adds context** — Send a message without the bot's name.
   *Check:* Bot does NOT respond, but the message appears in its conversation context.

6. **Self-echo prevented** — Bot does not process its own messages.
   *Check:* Bot's log shows its own messages filtered out.

7. **Display name correct** — Bot's display name shows `<name> <pip> [<ship>]`.
   *Check:* Matrix profile API returns the expected display name format.
