# 02 — Matrix

Matrix is the communication backbone. Every message, command, and status update flows through Matrix. InfiniClaw uses a self-hosted Conduwuit homeserver.

## Account Types

| Account | Purpose |
|---------|---------|
| Captain | Human. Admin in all rooms. Identity in `secrets/captain`. |
| Operator (`@operator`) | Operator's direct Matrix presence. Admin in all rooms. Used for direct messages, BehindTheCurtain, quarters room commands, and room management. Mentionable by bots to request operator assistance (see Special Mentions). |
| Loudspeaker (`@loudspeaker`) | Relay's reply voice. Member of all rooms. Delivers x-command responses prefixed `[SHIPNAME]`. Mentionable by on-duty bots for fleet status or broadcast (see Special Mentions). |
| Help (`@help`) | Help text and unknown command feedback. Member of all rooms. Captain-only visibility — bots ignore this account. |
| Bot accounts | One per bot. Joins rooms based on lifecycle status. Display names use `unifiedBotDisplay('short')` format: `shipEmoji locationEmoji Name roleIcon medal healthEmoji` (e.g. `🦁🏠 Cid ⚙️🥈💤`). Synced on relay startup via `syncBotDisplayNames()`. |
| Intercom accounts | Write-only broadcast channels, one per duty room. The relay polls these for incoming x-commands. Not present in ship rooms. |

Bots see loudspeaker and intercom messages in their context window (for situational awareness) but only ignore the help account via `IGNORE_SENDERS`. The trigger system controls whether bots respond — not whether they hear.

Account credentials are in `secrets/operator/`. See `operator/intercom.json` for intercom accounts.

## Room Structure

### Room Naming Convention

All rooms use a double-emoji prefix: `<location><room> Name`.

| Room type | Location emoji | Example |
|-----------|---------------|---------|
| Fleet (duty) rooms | `🌌` | `🌌⚙️ Engineering` |
| Ship-local rooms | Ship emoji | `🦁🏠 Cid's Room` |
| BehindTheCurtain | `🌑` | `🌑🎭 BehindTheCurtain` |

The relay sets room names on startup via `ensureRoomNames()`, which checks the current name before setting to avoid spam of `m.room.name` state events on restarts.

### Duty Rooms

Shared across all ships. Bots join/leave based on lifecycle status. Rooms and their IDs are in `operator/intercom.json`.

### BehindTheCurtain

Private room between Captain and operator. Room ID in `operator/operator-matrix.json`. Not in intercom — operator account polls it directly. Named `🌑🎭 BehindTheCurtain`.

### Ship Spaces

Each ship is a Matrix space containing its local rooms. Space names use `<shipEmoji> <shipName>` format. The rooms within a ship are not prescribed — each ship can have whatever rooms it needs. Example:

```
🦁 Herc (space)
  🦁🛋️ Lounge         — shared room for all ship bots
  🦁🏠 Quarters (space)
    🦁🏠 Norm's Room   — private quarters for one bot
```

Ship space and lounge IDs are in `ships.json`. Per-bot quarters room IDs are in `fleet.json`.

### Permissions

- **Captain** and **Operator** are admin (power 100) in all rooms.
- **Bots** are regular members (power 0).
- **Intercom accounts** are only in duty rooms — never in ship rooms.

## Room Setup

All rooms are created by the operator account. This example sets up a single ship with one bot. Assumes: Matrix server running, accounts already registered (see `docs/solutions/matrix.md`).

### Helper: invite and join

```bash
# Invite (operator must already be in the room)
curl -s -X POST "$HOMESERVER/_matrix/client/v3/rooms/$ROOM_ID/invite" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\": \"$USER_ID\"}"

# Accept (using the invited account's token)
curl -s -X POST "$HOMESERVER/_matrix/client/v3/rooms/$ROOM_ID/join" \
  -H "Authorization: Bearer $INVITED_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Room IDs must be URL-encoded in the path (`!` → `%21`, `:` → `%3A`).

### 1. Create ship space

```bash
SPACE_ID=$(curl -s -X POST "$HOMESERVER/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "SHIPNAME", "creation_content": {"type": "m.space"}, "visibility": "private"}' \
  | jq -r '.room_id')
```

### 2. Create Lounge (child of ship space)

```bash
LOUNGE_ID=$(curl -s -X POST "$HOMESERVER/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Lounge", "visibility": "private"}' | jq -r '.room_id')
```

Invite and join: captain, loudspeaker, all ship bots.

### 3. Create Quarters space (child of ship space)

```bash
QUARTERS_SPACE_ID=$(curl -s -X POST "$HOMESERVER/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Quarters", "creation_content": {"type": "m.space"}, "visibility": "private"}' \
  | jq -r '.room_id')
```

### 4. Create per-bot quarters room (child of Quarters space)

```bash
BOT_ROOM_ID=$(curl -s -X POST "$HOMESERVER/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Bot'\''s Room", "visibility": "private"}' | jq -r '.room_id')
```

Invite and join: bot account, captain, loudspeaker.

### 5. Add space hierarchy

Both directions are required for Element to display rooms inside spaces correctly. For each relationship, set `m.space.child` on the parent and `m.space.parent` on the child:

```bash
# Lounge ↔ ship space
curl -s -X PUT "$HOMESERVER/_matrix/client/v3/rooms/$SPACE_ID/state/m.space.child/$LOUNGE_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"via": ["a-gis.org"]}'
curl -s -X PUT "$HOMESERVER/_matrix/client/v3/rooms/$LOUNGE_ID/state/m.space.parent/$SPACE_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"via": ["a-gis.org"], "canonical": true}'

# Quarters space ↔ ship space
curl -s -X PUT "$HOMESERVER/_matrix/client/v3/rooms/$SPACE_ID/state/m.space.child/$QUARTERS_SPACE_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"via": ["a-gis.org"]}'
curl -s -X PUT "$HOMESERVER/_matrix/client/v3/rooms/$QUARTERS_SPACE_ID/state/m.space.parent/$SPACE_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"via": ["a-gis.org"], "canonical": true}'

# Bot's Room ↔ Quarters space
curl -s -X PUT "$HOMESERVER/_matrix/client/v3/rooms/$QUARTERS_SPACE_ID/state/m.space.child/$BOT_ROOM_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"via": ["a-gis.org"]}'
curl -s -X PUT "$HOMESERVER/_matrix/client/v3/rooms/$BOT_ROOM_ID/state/m.space.parent/$QUARTERS_SPACE_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"via": ["a-gis.org"], "canonical": true}'
```

### 6. Set power levels

Captain and operator get admin (power 100) in every room:

```bash
curl -s -X PUT "$HOMESERVER/_matrix/client/v3/rooms/$ROOM_ID/state/m.room.power_levels/" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"users\": {\"$CAPTAIN_USER_ID\": 100, \"$OPERATOR_USER_ID\": 100}}"
```

### 7. Save room IDs

Store ship space/lounge/quarters IDs in `ships.json`, and per-bot quarters room IDs in `fleet.json`. Commit and push secrets.

## Message Format

All messages use `org.matrix.custom.html` format with `formatted_body` for rich rendering:

- **Markdown** — headings, bold, italic, lists, code blocks, links, tables
- **Math** — LaTeX via `data-mx-maths` attribute (MSC2191): `$x^2$` for inline, `$$\sum_{i=1}^n$$` for display
- **Collapsible sections** — `<details>` blocks for tool call output

Bot outgoing messages are converted from Markdown to Matrix HTML before sending.

### Mention Pill Symmetry

`<m>Name</m>` is the canonical internal mention format. Conversions are symmetric:

- **Inbound (pill → marker):** Matrix mention pills (`<a href=".../@cid:...">Cid</a>` in `formatted_body`) appear as bare `Cid` in `body`. The host wraps them in `<m>Cid</m>` markers via `restoreMentionPrefixes` so the trigger pattern can match.
- **Inbound (raw @ → marker, Captain and operator only):** When the Captain or operator types `@Cid` without TAB-completing to a pill, the host converts it via `convertRawMentions` using `\b@name\b` (case-insensitive). Raw `@Name` from bots is NOT converted — it passes through as literal text.
- **Outbound (marker → pill):** Bots emit `<m>Cid</m>` to request a mention pill. The send pipeline converts it to `<a href="https://matrix.to/#/@cid:a-gis.org">Cid</a>` in `formatted_body` via `pillifyMentions`. Unknown names are stripped to plain text. Raw `@Name` in bot output is left as-is.

Full conversion rules are in [05-bot](05-bot.md#mentions-and-callouts).

> **Migration:** The `<m>Name</m>` syntax is being replaced by the Signals protocol `{{m Name}}` (see [22-signals](22-signals.md)). Double-brace syntax survives Matrix HTML rendering, unlike raw `<m>` tags. The relay will support both during transition.

## Reactions

> **Status:** All reactions are implemented. Status reactions (📡 👀 🔔) signal message processing pipeline. Scoring reactions (👍 👎 💯 ❌) are recorded by the relay for metrics.

Bots use emoji reactions to signal message processing status at a glance:

| Emoji | Meaning | When applied |
|-------|---------|--------------|
| 📡 | Relay received | Each relay that syncs the message reacts |
| 👀 | Delivered to context | Message stored in bot's conversation context |
| 🔔 | Triggered | Bot will respond to this message |

Reactions accumulate — a message that triggers a bot will have all three. A message the bot heard but didn't respond to will have 📡 and 👀 but no 🔔.

### Scoring Reactions

The Captain (or operator) scores bot output by reacting to bot messages:

| Emoji | Score | Meaning |
|-------|-------|---------|
| 👍️ | +1 | Good response |
| 👎️ | −1 | Bad response |
| 💯 | +3 | Excellent — exactly right |
| ❌️ | −3 | Wrong — significant failure |

Either the Captain or operator can score bot messages. Scores are tallied as points/day per bot and reported as 1-day and 7-day rolling averages alongside other metrics. Bots can read their own scores via the `get_metrics` MCP tool — a bot with a declining score should adjust its approach.

## Special Mentions

Certain `@` mentions trigger system-level behaviors handled by the relay, not by individual bots.

### @operator

Mentioning `@operator` requests operator assistance. Currently, only the Captain or operator can trigger tmux routing — by prefixing any message with `@` (e.g. `@some note`). Bots cannot use `<m>operator</m>` to trigger this; no relay scanning for that pattern exists yet.

> **Planned:** Bot-triggered operator routing — the relay will scan outgoing bot messages for `<m>operator</m>` and deliver the full message context (bot name, room, content) to the operator's tmux session, with ship-scoped routing so bots on HERACLES only wake the HERACLES operator.

### @loudspeaker

Two behaviors depending on message format:

| Pattern | Who can use | Behavior |
|---------|-------------|----------|
| `@loudspeaker` (mention only) | Any on-duty bot | Relay responds with fleet status in the room |
| `@loudspeaker: <message>` (callout + text) | Any on-duty bot | Relay broadcasts `<message>` to all duty rooms via the loudspeaker account, prefixed with the bot name and source room |

Off-duty bots (lounge, quarters, sleep) cannot use the loudspeaker. The relay silently ignores their mentions.

### @room intercom

> **Status:** Not yet implemented. The relay does not currently parse `@room` cross-room routing from bots.

On-duty bots can send messages across rooms by mentioning the target room name:

| Pattern | Example | Behavior |
|---------|---------|----------|
| `@engineering: <message>` | From Bridge | Relay sends `<message>` to Engineering via engineering-intercom |
| `@bridge: <message>` | From Engineering | Relay sends `<message>` to Bridge via bridge-intercom |
| `@astrometrics: <message>` | From Bridge | Relay sends `<message>` to Astrometrics via astrometrics-intercom |

Each on-duty room has access to the other two room intercoms. Messages appear as `<BotName> (<SourceRoom>): <message>` in the target room. See [13-intercom](13-intercom.md) for intercom account details.

## Bot MCP Tools

All bot MCP tools are provided by the InfiniClaw agent-runner under the `mcp__infiniclaw__*` namespace. The server namespace is `infiniclaw` — bots reference tools as `mcp__infiniclaw__tool_name`. Implementation lives in `bots/container/agent-runner/src/`.

### Communication

| Tool | Purpose | Status |
|------|---------|--------|
| `send_reaction` | React to a message with an emoji (call `get_last_event_id` first) | ✅ |
| `send_image` | Send an image file to the current room | ✅ |
| `send_file` | Send a file attachment to the current room | ✅ |
| `set_thread` | Set/clear the active Matrix thread for subsequent messages | ✅ |

**Note:** Bots send text by outputting to stdout — the relay routes it to Matrix automatically. There is no `send_message` tool. Cross-room messaging is handled by the `@loudspeaker: <message>` mention pattern (see Special Mentions above), not an MCP tool.

### Navigation

| Tool | Purpose | Status |
|------|---------|--------|
| `get_message` | Fetch a specific message by event ID | ✅ |
| `get_last_event_id` | Get the event ID of the most recent message in this room | ✅ |

Navigation tools access the bot's current room (quarters or duty room). Matrix history is permanent — the bot does not need to have been active when messages were sent.

### Fleet Awareness

| Tool | Purpose | Status |
|------|---------|--------|
| `crew_roster` | List bots in the fleet with roles, status, and Chief designation | ✅ |
| `check_health` | Query fleet health snapshot from relay (containers, queue, status) | ✅ |
| `get_metrics` | Read this bot's own metrics: response latency, scores, crashes | 🔲 not yet implemented |

### Self-Management

| Tool | Purpose | Status |
|------|---------|--------|
| `set_brain_mode` | Switch LLM model at runtime (requires restart to take effect) | ✅ |
| `get_brain_mode` | Query current brain mode and model | ✅ |
| `restart_self` | Request bot restart via the relay | ✅ |

### Work

| Tool | Purpose | Status |
|------|---------|--------|
| `{{branch}}` signal | Dispatch work to a Branch Brain in a new thread — bot outputs `{{branch title="X" objective="Y"}}` inline, relay spawns BB | ✅ |
| `delegate_to_lobe` | Spawn a sub-process worker (codex/gemini/claude/ollama); posts to quarters thread | ✅ infrastructure, 🔲 end-to-end not production-ready |
| `git_push` | Push commits to remote via relay (requires host git credentials) | ✅ |

### WBS (Work Breakdown Structure)

Chief-only write tools and crew read tools for the room WBS. See [12-co](12-co.md) for WBS design.

| Tool | Role access | Purpose | Status |
|------|-------------|---------|--------|
| `wbs_read` | All | Read WBS items for this room | 🔲 not yet implemented |
| `wbs_write` | Chief only | Add/update/remove WBS items | 🔲 not yet implemented |
| `wbs_assign` | Chief only | Assign a task to a bot | 🔲 not yet implemented |
| `wbs_complete` | Chief only | Mark a task done (unblocks dependents) | 🔲 not yet implemented |
| `wbs_get_assigned` | All | Get this bot's currently assigned tasks | 🔲 not yet implemented |

### Holodeck

| Tool | Purpose | Status |
|------|---------|--------|
| `holodeck_create` | Create an isolated test environment | ✅ |
| `holodeck_teardown` | Destroy a holodeck instance | ✅ |
| `holodeck_promote` | Merge holodeck feature branch into main | ✅ |
| `holodeck_send` | Send a test message to a holodeck bot | ✅ |
| `holodeck_read` | Read messages from a holodeck session | ✅ |
| `holodeck_status` | Check holodeck instance status | ✅ |

### Verification (P2P)

| Tool | Purpose | Status |
|------|---------|--------|
| `request_verification` | Request a challenge from another bot | ✅ |
| `submit_verification` | Submit a verification response | ✅ |
| `check_verification` | Check verification result | ✅ |
| `list_verifications` | List pending verifications | ✅ |

## Verification

1. **Server reachable** — `curl $HOMESERVER/_matrix/client/versions` → HTTP 200
2. **Tokens valid** — `GET /_matrix/client/v3/account/whoami` with each stored token → expected `user_id`
3. **Rooms exist** — `GET /_matrix/client/v3/joined_rooms` with operator token → includes all expected room IDs
4. **Memberships correct** — `GET /_matrix/client/v3/rooms/$ROOM_ID/members` → correct accounts in each room
5. **Space hierarchy** — Both directions required:
   - `GET /_matrix/client/v3/rooms/$SPACE_ID/state/m.space.child/$CHILD_ID` → `{"via": [...]}`
   - `GET /_matrix/client/v3/rooms/$CHILD_ID/state/m.space.parent/$SPACE_ID` → `{"via": [...], "canonical": true}`
6. **Power levels** — `GET /_matrix/client/v3/rooms/$ROOM_ID/state/m.room.power_levels/` → captain and operator at 100
7. **Message round-trip** — Operator posts to a room, reads back via `/messages` → posted message appears
8. **Inbound pill restoration** — Send a mention pill (`@BotName`) in Matrix. Bot log shows the message with `<m>Name</m>` markers in body.
   *Check:* Trigger pattern matches via `<m>Name</m>` markers.
9. **Outbound pill conversion** — Bot sends a message containing `<m>Name</m>` for a known room member. Matrix client shows it as a clickable mention pill.
   *Check:* `formatted_body` contains `<a href="https://matrix.to/#/@...">Name</a>`.
10. **@operator wakes operator** — Captain prefixes a message with `@` in any room. Operator tmux session receives the request with context.
    *Check:* Operator session shows the message; only the bot's ship's operator responds. Note: bot-triggered `<m>operator</m>` routing is not yet implemented (see Special Mentions).
11. **@loudspeaker fleet status** — On-duty bot mentions `@loudspeaker` in a room.
    *Check:* Relay responds with fleet status in the same room.
12. **@loudspeaker broadcast** — On-duty bot sends `@loudspeaker: test message` in Engineering.
    *Check:* Message appears in Bridge and Astrometrics via loudspeaker, prefixed with bot name and source room.
13. **@room intercom** — On-duty bot sends `@engineering: hello` from Bridge.
    *Check:* Message appears in Engineering via engineering-intercom with `BotName (Bridge):` prefix.
