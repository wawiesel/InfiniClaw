# 01 — Matrix

Matrix is the communication backbone. Every message, command, and status update flows through Matrix. InfiniClaw uses a self-hosted Conduwuit homeserver.

## Account Types

| Account | Purpose |
|---------|---------|
| Captain (`@wawiesel:a-gis.org`) | Human operator. Admin in all rooms. |
| Operator (`@operator:a-gis.org`) | Automated operator. Admin in all rooms. Used for room management, invites, power levels. |
| Loudspeaker (`@loudspeaker:a-gis.org`) | Fleet-wide announcements from the relay. Member of all rooms. Delivers status information (repo versions, fleet health, lifecycle changes). |
| Bot accounts (e.g. `@norm-bot:a-gis.org`) | One per bot. Joins rooms based on status. |
| Intercom (`@engineering-intercom:a-gis.org`) | Write-only broadcast channel for Engineering. Used by operators and relays. Additional intercom accounts (bridge, astrometrics) added as rooms are introduced. |

## Room Structure

### Fleet-wide Rooms (Duty Rooms)

Duty rooms are shared across all ships. Bots join/leave based on lifecycle status.

- **Engineering** — Captain + engineers + loudspeaker + intercom

Additional duty rooms (Bridge, Astrometrics) are added as roles are introduced.

### Ship Spaces

Each ship is a Matrix space containing its local rooms:

```
HERACLES (space)
  Lounge          — all ship bots + captain + operator + loudspeaker (always)
  Quarters (space)
    Norm's Room   — norm + captain + operator + loudspeaker (always)
```

### Permissions

- **Captain** and **Operator** are admin (power 100) in all rooms.
- **Bots** are regular members (power 0).
- **Intercom accounts** are only in duty rooms — never in ship rooms.

## Room Setup

All rooms are created by the operator account. This example sets up a single ship (HERACLES) with one normie bot (Norm).

Assumes: Matrix server running, these accounts registered: captain, operator, loudspeaker, norm-bot.

### Helper: invite and join

After inviting an account to a room, accept the invite on their behalf:

```bash
# Invite
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

### 1. Create ship space

```bash
SPACE_ID=$(curl -s -X POST "$HOMESERVER/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "HERACLES", "creation_content": {"type": "m.space"}, "visibility": "private"}' \
  | jq -r '.room_id')
```

### 2. Create Lounge (child of ship space)

```bash
LOUNGE_ID=$(curl -s -X POST "$HOMESERVER/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Lounge", "visibility": "private"}' | jq -r '.room_id')
```

Invite and join: captain, loudspeaker, norm-bot.

### 3. Create Quarters space (child of ship space)

```bash
QUARTERS_SPACE_ID=$(curl -s -X POST "$HOMESERVER/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Quarters", "creation_content": {"type": "m.space"}, "visibility": "private"}' \
  | jq -r '.room_id')
```

### 4. Create Norm's quarters room (child of Quarters space)

```bash
NORM_ROOM_ID=$(curl -s -X POST "$HOMESERVER/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Norm'\''s Room", "visibility": "private"}' | jq -r '.room_id')
```

Invite and join: norm-bot, captain, loudspeaker.

### 5. Add space children

Link rooms to their parent spaces via `m.space.child` state events:

```bash
# URL-encode the child room ID (! → %21, : → %3A)
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

# Norm's Room → Quarters space
curl -s -X PUT "$HOMESERVER/_matrix/client/v3/rooms/$QUARTERS_SPACE_ID/state/m.space.child/$NORM_ROOM_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"via": ["a-gis.org"]}'
```

### 6. Set power levels

Captain and operator get admin (power 100) in every room (Lounge, Norm's Room):

```bash
curl -s -X PUT "$HOMESERVER/_matrix/client/v3/rooms/$ROOM_ID/state/m.room.power_levels/" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"users": {"@wawiesel:a-gis.org": 100, "@operator:a-gis.org": 100}}'
```

### 7. Save room IDs

Store ship space/lounge/quarters IDs in `ships.json`, and per-bot quarters room IDs in `fleet.json`. Commit and push secrets.

## Message Format

Messages use Matrix's `org.matrix.custom.html` format with `formatted_body` for rich content (links, tables, collapsible sections).

## Verification

The room setup procedure also verifies credentials — each step exercises an account's token, so a failure pinpoints which secret is wrong.

All checks use stored tokens from the secrets repo. No login needed if accounts are already set up.

1. **Server reachable** — `curl https://matrix.a-gis.org/_matrix/client/versions`
   *Check:* HTTP 200 with version list.

2. **Tokens valid** — `GET /_matrix/client/v3/account/whoami` with each stored token (operator, loudspeaker, norm-bot).
   *Check:* Each returns the expected `user_id`.

3. **Rooms exist** — `GET /_matrix/client/v3/joined_rooms` with operator token.
   *Check:* Response includes ship space, lounge, quarters space, and Norm's Room IDs.

4. **Memberships correct** — `GET /_matrix/client/v3/rooms/$ROOM_ID/members` for Lounge and Norm's Room.
   *Check:* Each room includes norm-bot, captain, operator, loudspeaker.

5. **Space hierarchy** — `GET /_matrix/client/v3/rooms/$SPACE_ID/state/m.space.child/$CHILD_ID` for each parent→child link.
   *Check:* Returns `{"via": ["a-gis.org"]}`.

6. **Power levels** — `GET /_matrix/client/v3/rooms/$ROOM_ID/state/m.room.power_levels/` for each room.
   *Check:* Captain and operator at power 100.

7. **Message round-trip** — Operator posts to Lounge, reads back via `/messages`.
   *Check:* Posted message appears in timeline.
