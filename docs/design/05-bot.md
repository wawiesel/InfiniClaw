# 05 — Bot

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
- `IGNORE_TRIGGERS` — Comma-separated name patterns; messages whose content matches are skipped (word-boundary, case-insensitive)
- `IGNORE_SENDERS` — Comma-separated sender IDs to skip

**Persona directory:**
```
bots/{role}/{name}/
  CLAUDE.md              # System prompt (personality, instructions)
  Dockerfile             # Custom container image (optional)
  container-config.json  # MCP server config (optional)
  skills/                # Custom skills (optional)
```

Role is resolved from the fleet state held in memory by the relay (persisted to S3 and disk cache). A base `bots/CLAUDE.md` provides shared instructions across all bots.

## Bot Attributes

Every bot has runtime attributes that determine its behavior. Commands and events toggle these attributes — the bot itself doesn't need to know why, it just reads its current state.

| Attribute | Type | Set by | Stored in |
|-----------|------|--------|-----------|
| `status` | `onduty` · `quarters` · `sleep` · `transit` · `retrospective` · `dream` · `ready` | Relay commands | S3 fleet state |
| `triggerType` | `always` · `callout` · `never` | Relay on room moves | S3 fleet state |
| `rank` | number | `!promote` / `!demote` | S3 fleet state |
| `ship` | hostname | `!transport` | S3 fleet state |
| `activeBrainModel` | model ID | runtime model switch | S3 fleet state |

### triggerType

Controls when the bot responds to messages:

| Value | Behavior |
|-------|----------|
| `always` | Every message triggers a response (no callout needed) |
| `callout` | Requires explicit `<m>name</m>` mention, participating thread, or Chief fallback on main timeline |
| `never` | Bot is stopped — no responses |

The relay sets `triggerType` on status transitions:

| Event | triggerType becomes |
|-------|---------------------|
| `!wake` | `always` (bot starts in quarters, responds to everything) |
| `!report` | `callout` (bot joins shared duty room, needs explicit addressing) |
| `!dismiss` | `always` (bot returns to quarters, sole occupant) |
| `!sleep` | `never` (bot stopped) |
| `!go <room>` | unchanged |

### Attribute events

Commands only toggle attributes — they don't encode room-specific logic:

```
!wake    → status=quarters,      triggerType=always,   container=start
!sleep   → status=sleep,         triggerType=never,    container=stop
!report  → status=onduty,        triggerType=callout,  rooms=+duty
!dismiss → status=quarters,      triggerType=always,   rooms=-duty
!go room → rooms=+room,          (no attribute change)

# Duty cycle (automatic, driven by dutyCycleLoop):
duty expired  → status=retrospective, triggerType=always,   rooms=-duty (dismissed to quarters)
retrospective → status=dream,         triggerType=never,    container=stop (git sync applies)
dream done    → status=ready,         triggerType=always,   container=start (woken to quarters)
```

The bot reads `triggerType` from fleet state at startup and re-reads it periodically. This replaces hardcoded room-ID checks.

### Duty Cycle Status Flow

The `dutyCycleLoop` runs every 60s and triggers a retrospective sequence when a bot's on-duty time exceeds `DUTY_CYCLE_MS` (default 4h). Pip progression through the cycle:

| Status | Pip | triggerType | Description |
|--------|-----|-------------|-------------|
| `onduty` | 🟢 | callout | Bot is active in duty room |
| `retrospective` | 📝 | always | Dismissed to quarters; relay sends reflection questions |
| `dream` | 💤 | never | Container stopped; git sync applies new code |
| `ready` | ✅ | always | Bot woken to quarters, ready for next `!report` |

After `ready`, the Captain issues `!report` to send the bot back on duty, resetting `ondutyAt`.

## Mentions and Callouts

`<m>Name</m>` is the canonical mention format inside the system. Bots read and write it. The trigger pattern matches `<m>name</m>` case-insensitively anywhere in the message.

### How mentions flow

```
Matrix user types @Cid (TAB-completes to a mention pill)
  → Matrix sends: body="Cid", formatted_body="<a href='.../@cid:...'>Cid</a>"
  → Host parses formatted_body, wraps bare name in body → "<m>Cid</m>"
  → Bot sees: "<m>Cid</m> can you look at this?"
  → Trigger pattern matches → bot responds

Bot emits: "<m>Norm</m> what do you think?"
  → Host converts <m>Norm</m> → Matrix mention pill in formatted_body
  → Host strips <m> markers from plaintext body → "Norm what do you think?"
  → Matrix client shows: clickable "Norm" pill

Captain types raw @cid (no pill, no TAB)
  → Host detects @cid via \b@name\b (case-insensitive)
  → Converts in-place to <m>Cid</m>
  → Bot sees it the same as a pill mention

Bot emits: @someone (raw, no <m> markers)
  → NOT converted — passes through as literal text
  → Use <m>Name</m> to create a pill
```

### Conversion rules

| Source | Input | Conversion | Output |
|--------|-------|------------|--------|
| Matrix pill (any user) | `<a href=".../@cid:...">Cid</a>` | `restoreMentionPrefixes` | `<m>Cid</m>` |
| Raw `@Name` (Captain/operator) | `@Cid` in body | `convertRawMentions` | `<m>Cid</m>` |
| Raw `@Name` (bot or other) | `@Cid` in body | no conversion | `@Cid` (literal) |
| Bot output `<m>Name</m>` | `<m>Cid</m>` | `pillifyMentions` | Matrix mention pill |
| Bot output `@Name` | `@Cid` | no conversion | `@Cid` (literal) |

`convertRawMentions` uses `\b@name\b` (case-insensitive) against all known display names. It skips text already inside `<m>` markers. It only runs on Captain and operator messages — bots that emit raw `@Name` (e.g. in code output) should not have it rewritten.

### Resume context

In **resume context** (bot restart), `<m>Name</m>` markers are replaced with `[callout]` to prevent the resume message from falsely re-triggering the bot.

## Response Rules

When `triggerType` is `callout`, three conditions can trigger a response:

| Condition | Description |
|-----------|-------------|
| **Callout** | Message contains `<m>name</m>` (the trigger pattern) |
| **Participating thread** | Message is in a thread where the bot previously responded |
| **Chief fallback** | Bot is Chief (lowest-rank-number active in room) and message doesn't mention any known bot (checked via `\b<name>\b` word-boundary against roster) |

When `triggerType` is `always`, every message triggers a response — no conditions needed.

If none of the conditions are met, the bot does NOT respond — but the message IS added to context. The bot "hears" everything. Filtering is about what triggers a response, not what enters context.

### Reaction acks

| Emoji | Meaning |
|-------|---------|
| 🔔 | Message triggered a bot response |
| 👀 | Message entered bot's context window |

Both fire together on triggering messages. Non-triggering messages get 👀 only.

### Additional Filters

Before routing, messages pass through filtering:
- **Self-echo:** Bots ignore their own messages (tracked via `botMatrixUserIds` set)
- **Pattern filtering:** Messages matching `IGNORE_PATTERNS` (from `IGNORE_TRIGGERS` env, uses `\b<name>\b` word-boundary) are skipped
- **Operator callout:** Captain messages starting with `@` are operator-directed — bots ignore them
- **Operator pill:** Captain messages starting with `📞` are operator-directed — bots ignore them
- **Help account:** Bots ignore messages from `@help` (`IGNORE_SENDERS` env) — help text is Captain-only feedback

## Unified Display Format

Two verbosity levels — **short** and **long** — applied uniformly to ships and bots.

### Ship Display

```
Long:  🦁 Herc 🛳️cruiser·⭐[1]·🟢[A]·🔥[32 tok/d]
Short: 🦁 Herc 🛳️⭐🟢🔥
```

### Bot Display

```
Long:  🦁🏠 Tali ⚙️engineer·🥈[2]·🟢[A]·🔥[16 tok/d]
Short: 🦁🏠 Tali ⚙️🥈🟢🔥
```

### Field Order

Both ships and bots follow the same structure:

```
<prefix> <Name> <type/role><rank>·<health>·<activity>
```

| Field | Ship | Bot |
|-------|------|-----|
| **prefix** | `<shipEmoji> ` | `<shipEmoji><locEmoji> ` |
| **Name** | Ship name | Bot name (capitalized) |
| **type/role** | Ship type emoji+name (`🛳️cruiser`) | Role emoji+name (`⚙️engineer`) |
| **rank** | Medal `⭐[1]` | Medal `🥈[2]` |
| **health** | Grade emoji `🟢[A]` | Grade emoji `🟢[A]` |
| **activity** | Throughput `🔥[32 tok/d]` | Throughput `🔥[16 tok/d]` |

In **long** format, each field shows `<emoji>[<value>]` separated by `·` (interpunct).
In **short** format, only emojis — no values or labels.

### Where Each Level Is Used

- **Short** — Matrix display names (bot names)
- **Long** — `!fleet` output, `!metrics`, health reports, status displays

### Health Grades

Computed from bot metrics (crashes, OOM kills, memory, response latency):

| Grade | Emoji | Criteria |
|-------|-------|----------|
| A | 🟢 | Healthy — 0 crashes/day, 0 OOM, mem < 70%, p95 latency < 60s |
| B | 🟡 | Minor issues — 1–2 crashes/day, or mem 70–85%, or p95 60–120s |
| C | 🟠 | Significant — 3+ crashes/day, or OOM > 0, or mem > 85%, or p95 > 120s |
| F | 🔴 | Down — should be running (onduty/quarters) but process not found |

**Special health states** override the health emoji, but the grade label is always shown:

| State | Emoji | Grade label | When |
|-------|-------|-------------|------|
| sleep/dream | 💤 | Actual grade (default A if no data) | Bot is asleep or dreaming |
| building | 🔄 | `?` | Container image being built |
| starting | 🚀 | `?` | Container starting up |
| transit | 🚀 | `?` | Bot moving between ships |
| waiting | 🟡 | `?` | Waiting for first output after start |

Example: a sleeping bot with no recent metrics shows `💤[A]` — the 💤 signals sleep status, `A` is the default grade (sleeping = healthy by definition). Health is vitals, not status.

Fleet-level health grade = worst grade among all non-sleeping bots.

### Activity Levels

Based on rolling token throughput (tokens per day):

| Level | Emoji | Threshold |
|-------|-------|-----------|
| idle | · | 0 tok/day |
| low | 🔹 | 5K–50K tok/day |
| moderate | ⚡ | 50K–500K tok/day |
| high | 🔥 | 500K+ tok/day |

In **long** format, the actual throughput is shown: `🔥[32K tok/d]`, `⚡[120K tok/d]`, `·[0 tok/d]`.
In **short** format, only the emoji tier is shown. Idle bots show `·` (middle dot).

Activity is shown for all bot statuses, including sleep/dream/transit — it represents the rolling 24-hour throughput, not current state.

### Rank Medals

| Medal | Meaning |
|-------|---------|
| ⭐ | Chief — lowest-rank awake bot in its role (onduty or quarters) |
| 🥇 | Rank 1 (not chief) |
| 🥈 | Rank 2 |
| 🥉 | Rank 3+ |

Ships use ⭐ for speaker (lowest-rank commissioned), ◉ for non-speaker, 💤 for decommissioned.

### Ship Types

Ships have a `type` field in `ships.json` with associated emoji:

| Type | Emoji |
|------|-------|
| cruiser | 🛳️ |

> **Status:** Ship types are not yet implemented in `ships.json`. Currently all ships are implicitly cruisers.

### Location Emojis

| Location | Emoji | When |
|----------|-------|------|
| Engineering | ⚙️ | Bot onduty in engineering room |
| Bridge | 🌉 | Bot onduty in bridge room |
| Astrometrics | 🔭 | Bot onduty in astrometrics room |
| Quarters | 🏠 | Bot in quarters, sleeping, or any non-onduty status |

Location is derived from bot status: onduty → duty room (from `ROLE_ROOMS`), everything else → quarters.

### Matrix Display Name

The bot's Matrix display name uses `unifiedBotDisplay(params, 'short')`:

```
<shipEmoji><locationEmoji> <Name> <roleIcon><medal><healthEmoji><actEmoji>
```

Examples: `🦁🏠 Cid ⚙️🥈🟢🔥`, `🔱⚙️ Parker ⚙️⭐🟢⚡`, `🦁🏠 Nora 🧭🥈💤`

At relay startup, `syncBotDisplayNames()` sets display names for all local bots (including sleeping). Health and tokPerDay default to `''`/`0` at sync time since metrics aren't available yet.

> **Status:** Dynamic pip transitions (🔄 → 🚀 → 🟡 → 🟢) during boot are not yet implemented. `setStatusPip()` is currently a no-op in `channels/matrix.ts`. The relay sets pips at lifecycle boundaries (💤 on sleep, 🟢 on wake completion, ⭐ on Chief) but not during boot stages. See [#27](https://gitea.a-gis.org/wawiesel/infiniclaw/issues/27).

### Boot Progress Messages

`!wake` posts a threaded sequence with numbered steps. The thread root and final summary go to the main timeline with the loudspeaker `[shipTag]` prefix. Thread steps omit the tag — the root already identifies the ship:

```
[🦁 Herc] relay waking Norm ...          ← main timeline + thread root
[1/4 0s] 🔄 building                     ← thread step (no ship tag)
[2/4 1s] 🚀 starting                     ← thread step
[3/4 1m] 🟡 waiting for first output     ← thread step
[4/4 1m] 🟢 online · Normie[1] · claude-haiku-4-5 · 📦 abc1234 (2m) ↑0  ← thread step
[🦁 Herc] relay Norm awake!              ← thread + main timeline
```

Each step updates the bot's display name pip to match the current stage. `!wake` on an already-awake bot restarts it (says `restarting`/`restarted`).

`!report` and `!dismiss` are **instant** — just room moves on a running bot:

```
[🦁 Herc] relay Cid on duty
[🦁 Herc] relay Cid dismissed
```

## Message Flow

```
User message → Matrix → host message loop → SQLite → trigger check
  → [TRIGGERED] IPC inject if container active; else container spawns → main brain processes conversation
    → [IF COMPLEX] main brain outputs {{branch title="X" objective="Y"}}
      → Relay strips signal, posts text as 🌿 thread root
      → Relay spawns branch brain (podman container; host `claude --print` fallback when BRANCH_BRAIN_IMAGE unset)
      → Branch brain works, posts progress into thread
      → Main brain continues listening — never blocked
    → [IF SIMPLE] main brain replies directly
  → [NOT TRIGGERED] message stored as context, no response
```

## Mention-Wake

A sleeping bot can be woken by an explicit `<m>name</m>` callout in any room where the bot has membership. The relay monitors for trigger-pattern matches against sleeping bots and auto-wakes them — equivalent to `!wake <bot>` but driven by a mention instead of an x-command. The bot resumes in the room where the callout occurred.

## Resume Behavior

When a bot restarts (crash, deploy, or manual restart):

1. Synthetic resume message injected into SQLite with last 5 messages as context
2. Active todos included if available
3. Trigger patterns stripped from context to prevent false activation
4. Container spawns to process the resume message
5. Bot picks up where it left off with full conversation context

Configurable delay via `RESUME_DELAY_SECONDS` (default 0).

## Crash Recovery

- pm2 auto-restarts on crash (2s delay, max 100 restarts)
- Exit code 137 (SIGKILL/OOM) triggers backoff cooldown (60s, after 3 consecutive crashes)
- Session state persisted in SQLite survives restarts

## Metrics

| Metric | What it measures | Target | Window |
|--------|-----------------|--------|--------|
| **Response latency** | Time from trigger (🔔) to first message posted | < 30s | 1-day, 7-day rolling |
| **Branch brain success** | Branch brains that posted a result vs timed out/errored | > 90% | 1-day, 7-day rolling |
| **Crashes** | pm2 restarts (especially exit code 137 OOM) | 0/day | 1-day, 7-day rolling |
| **Self-healing ratio** | Bot-initiated restarts/rebuilds vs operator-triggered | Ratio → 1 | 7-day rolling |
| **Turn timeout rate** | Container turns killed by timeout vs completed normally | < 5% | 1-day, 7-day rolling |
| **Score** | Net points/day from 👍️(+1) 👎️(−1) 💯(+3) ❌️(−3) reactions (Captain or operator) | Positive | 1-day, 7-day rolling |

Response latency is the primary bot metric — it measures whether the main brain is instantly responsive per core principle. Track from 🔔 reaction timestamp to first bot message in the room. Branch brain success is measurable because each branch has a clear lifecycle: spawned → posted result or timed out/errored.

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

7. **Display name correct** — Bot's display name uses `unifiedBotDisplay('short')`: `<shipEmoji><locEmoji> <Name> <roleIcon><medal><healthEmoji><actEmoji>`.
   *Check:* Matrix profile API returns the expected display name format.

8. **Resume works** — Wake the bot (via `!wake`), verify it injects context and responds.
   *Check:* Log shows "Injected resume message with context" with recent message count.

9. **Reaction: context delivery** — Send a message the bot hears.
   *Check:* Bot reacts with 👀 (message entered context window).

10. **Reaction: trigger** — Send a `<m>Name</m>` callout.
    *Check:* Bot reacts with both 👀 and 🔔 (triggered response).

11. **No reactions when asleep** — `!sleep` the bot, send messages.
    *Check:* No 👀 or 🔔 reactions appear on messages sent while sleeping.

12. **Mention-wake** — With bot sleeping, send `<m>Name</m>` callout.
    *Check:* Bot wakes, 👀 propagates retroactively to missed messages, 🔔 on the callout message.
