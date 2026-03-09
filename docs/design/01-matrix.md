# 01 — Matrix

Matrix is the communication backbone. Every message, command, and status update flows through Matrix. InfiniClaw uses a self-hosted Conduwuit homeserver.

## Account Types

| Account | Purpose |
|---------|---------|
| Captain | Human. Admin in all rooms. Identity in `secrets/captain`. |
| Operator (`@operator`) | Operator's direct Matrix presence. Admin in all rooms. Used for direct messages, BehindTheCurtain, and room management. |
| Loudspeaker (`@loudspeaker`) | Relay's reply voice. Member of all rooms. Delivers `!` command responses prefixed `[SHIPNAME]`. Bots should ignore it. |
| Bot accounts | One per bot. Joins rooms based on lifecycle status. |
| Intercom accounts | Write-only broadcast channels, one per duty room. The relay polls these for incoming `!` commands. Not present in ship rooms. |

Account credentials are in `secrets/operator/`. See `operator/intercom.json` for intercom accounts.

## Room Structure

### Duty Rooms

Shared across all ships. Bots join/leave based on lifecycle status. Rooms and their IDs are in `operator/intercom.json`.

### BehindTheCurtain

Private room between Captain and operator. Room ID in `operator/operator-matrix.json`. Not in intercom — operator account polls it directly.

### Ship Spaces

Each ship is a Matrix space containing its local rooms:

```
HERACLES (space)
  Lounge          — all ship bots + captain + operator + loudspeaker (always)
  Quarters (space)
    Norm's Room   — norm + captain + operator + loudspeaker (always)
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

### 5. Add space children

Link rooms to their parent spaces via `m.space.child` state events:

```bash
# Lounge → ship space
curl -s -X PUT "$HOMESERVER/_matrix/client/v3/rooms/$SPACE_ID/state/m.space.child/$LOUNGE_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"via": ["a-gis.org"]}'

# Quarters space → ship space
curl -s -X PUT "$HOMESERVER/_matrix/client/v3/rooms/$SPACE_ID/state/m.space.child/$QUARTERS_SPACE_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"via": ["a-gis.org"]}'

# Bot's Room → Quarters space
curl -s -X PUT "$HOMESERVER/_matrix/client/v3/rooms/$QUARTERS_SPACE_ID/state/m.space.child/$BOT_ROOM_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"via": ["a-gis.org"]}'
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

## Verification

1. **Server reachable** — `curl $HOMESERVER/_matrix/client/versions` → HTTP 200
2. **Tokens valid** — `GET /_matrix/client/v3/account/whoami` with each stored token → expected `user_id`
3. **Rooms exist** — `GET /_matrix/client/v3/joined_rooms` with operator token → includes all expected room IDs
4. **Memberships correct** — `GET /_matrix/client/v3/rooms/$ROOM_ID/members` → correct accounts in each room
5. **Space hierarchy** — `GET /_matrix/client/v3/rooms/$SPACE_ID/state/m.space.child/$CHILD_ID` → `{"via": [...]}`
6. **Power levels** — `GET /_matrix/client/v3/rooms/$ROOM_ID/state/m.room.power_levels/` → captain and operator at 100
7. **Message round-trip** — Operator posts to a room, reads back via `/messages` → posted message appears
