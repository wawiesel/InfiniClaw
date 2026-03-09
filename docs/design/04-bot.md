# 04 — Bot

A bot is a Matrix account backed by a container running on a ship. It listens to room messages, responds when triggered, and accumulates context from everything it hears.

## Identity

Each bot has a secrets env file (`secrets/bots/{name}/env`) and a persona directory (`bots/{role}/{name}/`).

**Required env keys:**
- `ASSISTANT_NAME` — Display name, used in trigger pattern
- `MATRIX_HOMESERVER`, `MATRIX_USERNAME`, `MATRIX_PASSWORD` — Matrix auth (or `MATRIX_ACCESS_TOKEN`)
- `BRAIN_OAUTH_TOKEN` or `BRAIN_API_KEY` — LLM credentials

**Optional env keys:**
- `ASSISTANT_ROLE` — Role category for persona lookup
- `MAIN_GROUP_NAME` — Primary duty room name
- `BRAIN_MODEL` — Override LLM model
- `IGNORE_TRIGGERS` — Comma-separated bot names to skip
- `IGNORE_SENDERS` — Comma-separated sender IDs to skip

**Persona directory:**
```
bots/{role}/{name}/
  CLAUDE.md              # System prompt (personality, instructions)
  Dockerfile             # Custom container image (optional)
  container-config.json  # MCP server config (optional)
  skills/                # Custom skills (optional)
```

Role is resolved from the fleet state held in memory by the relay (persisted to `fleet.json` on disk). A base `bots/CLAUDE.md` provides shared instructions across all bots.

## Trigger Pattern

The trigger pattern is `<m>name</m>` (case-insensitive, matches anywhere in the message). The `<m>` marker is the canonical mention format — bots read and write it.

**Matrix mention pill handling:** When a user mentions a bot in Matrix (via a mention pill), the host converts it to `<m>Name</m>` in the plaintext body before storing or trigger-testing. See [01-matrix](01-matrix.md) for details on mention pill symmetry.

In **resume context** (bot restart), `<m>Name</m>` markers are replaced with `[callout]` to prevent the resume message from falsely re-triggering the bot.

## Response Rules

Four conditions trigger a bot response:

| Condition | Description |
|-----------|-------------|
| **Callout** | Message contains `<m>name</m>` (the trigger pattern) |
| **Participating thread** | Message is in a thread where the bot previously responded |
| **CO main timeline** | Bot is Commanding Officer and message is unaddressed (no bot mentioned) on main timeline |
| **Quarters** | Any message in the bot's quarters room |

If none of these conditions are met, the bot does NOT respond — but the message IS added to context. The bot "hears" everything. Filtering is about what triggers a response, not what enters context.

### Additional Filters

Before routing, messages pass through filtering:
- **Self-echo:** Bots ignore their own messages (tracked via `botMatrixUserIds` set)
- **Pattern filtering:** Messages matching `IGNORE_PATTERNS` (from `IGNORE_TRIGGERS` env) are skipped
- **Operator callouts:** Messages starting with `@` from the Captain are filtered (operator-to-bot addressing)

## Display Name

Bots set their Matrix display name to show status at a glance:

```
<name> <pip> (<ship>)
```

Examples: `Cid 🟢 (HERACLES)`, `Parker ⭐ (HERACLES)`, `Nora 💤 (POSEIDON)`

The pip reflects **operational status**, not which room the bot is in. See [08-roles-and-rooms](08-roles-and-rooms.md) for the full status model.

| Pip | Status |
|-----|--------|
| 💤 | Sleep — container stopped |
| 🔄 | Building — transient boot stage |
| 🚀 | Starting — transient boot stage |
| 🟡 | Waiting — transient boot stage |
| 🟢 | Online — running, responding |
| ⭐ | CO — commanding officer |

During boot, the pip changes through 🔄 → 🚀 → 🟡 → 🟢 so the current stage is visible at a glance.

### Boot Progress Messages

`!wake` posts a thread with staged progress. The ship name appears once in the summary, not on every step:

```
☀️ Norm waking
├ [3s] 🔄 building
├ [8s] 🚀 starting
├ [15s] 🟡 waiting for first output
└ [18s] 🟢 online · normie[1] · haiku · HERACLES · v1a2b3c (2m)
☀️ Norm awake (quarters)
```

Each step updates the bot's display name pip to match the current stage.

`!report` and `!dismiss` are **instant** — just room moves on a running bot:

```
📢 Cid reporting for duty
📢 Cid dismissed
```

## Message Flow

```
User message → Matrix → host message loop → SQLite → trigger check
  → [TRIGGERED] container spawns → Main Brain processes conversation
    → [IF COMPLEX] Main Brain calls branch_to_thread(objective)
      → Host creates thread: "🧵 Thread Brain: <title>"
      → Host spawns Thread Brain (claude --print on host, not container)
      → Thread Brain works, posts progress into thread
      → Main Brain continues listening — never blocked
    → [IF SIMPLE] Main Brain replies directly
  → [NOT TRIGGERED] message stored as context, no response
```

## Mention-Wake

A sleeping bot can be woken by an explicit `<m>name</m>` callout in any room where the bot has membership. The relay monitors for trigger-pattern matches against sleeping bots and auto-wakes them — equivalent to `!wake <bot>` but driven by a mention instead of an operator command. The bot resumes in the room where the callout occurred.

## Resume Behavior

When a bot restarts (crash, deploy, or manual restart):

1. Synthetic resume message injected into SQLite with last 10 messages as context
2. Active todos included if available
3. Trigger patterns stripped from context to prevent false activation
4. Container spawns to process the resume message
5. Bot picks up where it left off with full conversation context

Configurable delay via `RESUME_DELAY_SECONDS` (default 0).

## Crash Recovery

- pm2 auto-restarts on crash (2s delay, max 100 restarts)
- Exit code 137 (SIGKILL/OOM) triggers backoff cooldown (60s, after 3 consecutive crashes)
- Session state persisted in SQLite survives restarts

## Verification

1. **Account exists** — Bot's Matrix account can log in.
   *Check:* `POST /_matrix/client/v3/login` returns access token.

2. **Joined to room** — Bot appears in duty room member list.
   *Check:* Room members API includes the bot's user ID.

3. **Hears messages** — Send a message in the room, bot's log shows it received.
   *Check:* Log contains the message content.

4. **Trigger works** — Send `<m>Cid</m> hello` (via mention pill) in the room.
   *Check:* Bot processes the message and responds.

5. **Non-trigger adds context** — Send a message without the bot's name.
   *Check:* Bot does NOT respond, but the message appears in its conversation context.

6. **Self-echo prevented** — Bot does not process its own messages.
   *Check:* Bot's log shows its own messages filtered out.

7. **Display name correct** — Bot's display name shows `<name> <pip> (<ship>)`.
   *Check:* Matrix profile API returns the expected display name format.

8. **Resume works** — Restart the bot, verify it injects context and responds.
   *Check:* Log shows "Injected resume message with context" with recent message count.

9. **Reaction: context delivery** — Send a message the bot hears.
   *Check:* Bot reacts with 👀 (message entered context window).

10. **Reaction: trigger** — Send a `<m>Name</m>` callout.
    *Check:* Bot reacts with both 👀 and 🔔 (triggered response).

11. **No reactions when asleep** — `!sleep` the bot, send messages.
    *Check:* No 👀 or 🔔 reactions appear on messages sent while sleeping.

12. **Mention-wake** — With bot sleeping, send `<m>Name</m>` callout.
    *Check:* Bot wakes, 👀 propagates retroactively to missed messages, 🔔 on the callout message.
