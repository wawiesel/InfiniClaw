# 01 — Matrix

Matrix is the communication backbone. Every message, command, and status update flows through Matrix. InfiniClaw uses a self-hosted Conduwuit homeserver.

## Account Types

| Account | Purpose |
|---------|---------|
| Captain (`@wawiesel:a-gis.org`) | Human operator. Admin in all rooms. |
| Operator (`@operator:a-gis.org`) | Automated operator. Admin in all rooms. Used for room management, invites, power levels. |
| Loudspeaker (`@loudspeaker:a-gis.org`) | Fleet-wide announcements from the relay. Member of all rooms. Delivers status information (repo versions, fleet health, lifecycle changes). |
| Bot accounts (`@cid-bot:a-gis.org`, etc.) | One per bot. Joins rooms based on status. |
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
    Cid's Room    — cid + captain + operator + loudspeaker (always)
    Johnny5's Room
    Albert's Room
```

### Permissions

- **Captain** and **Operator** are admin (power 100) in all rooms.
- **Bots** are regular members (power 0).
- **Intercom accounts** are only in duty rooms — never in ship rooms.

## Room Setup

All rooms are created by the operator account. Assumes: Matrix server running, captain/operator/loudspeaker accounts registered, one ship identified by hostname.

### 1. Create fleet-wide duty rooms

```bash
# For each duty room (Bridge, Engineering, Astrometrics):
ROOM_ID=$(curl -s -X POST "$HOMESERVER/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Engineering", "visibility": "private"}' | jq -r '.room_id')
```

Invite and join: captain, loudspeaker, and the room's intercom account.

### 2. Create ship space

```bash
SPACE_ID=$(curl -s -X POST "$HOMESERVER/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "HERACLES", "creation_content": {"type": "m.space"}, "visibility": "private"}' \
  | jq -r '.room_id')
```

### 3. Create Lounge (child of ship space)

```bash
LOUNGE_ID=$(curl -s -X POST "$HOMESERVER/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Lounge", "visibility": "private"}' | jq -r '.room_id')
```

Add as child of ship space. Invite: captain, loudspeaker.

### 4. Create Quarters space (child of ship space)

```bash
QUARTERS_SPACE_ID=$(curl -s -X POST "$HOMESERVER/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Quarters", "creation_content": {"type": "m.space"}, "visibility": "private"}' \
  | jq -r '.room_id')
```

### 5. Create per-bot quarters rooms (children of Quarters space)

For each bot:

```bash
BOT_ROOM_ID=$(curl -s -X POST "$HOMESERVER/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Cid'\''s Room", "visibility": "private"}' | jq -r '.room_id')
```

Invite: the bot, captain, loudspeaker.

### 6. Add space children

Link rooms to their parent spaces via `m.space.child` state events:

```bash
# URL-encode the child room ID (! → %21, : → %3A)
curl -s -X PUT "$HOMESERVER/_matrix/client/v3/rooms/$SPACE_ID/state/m.space.child/$CHILD_ROOM_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"via": ["a-gis.org"]}'
```

### 7. Set power levels

Captain and operator get admin (power 100) in every room:

```bash
curl -s -X PUT "$HOMESERVER/_matrix/client/v3/rooms/$ROOM_ID/state/m.room.power_levels/" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"users": {"@wawiesel:a-gis.org": 100, "@operator:a-gis.org": 100}}'
```

### 8. Save room IDs

Store duty room IDs in `operator/intercom.json`, ship space/lounge/quarters IDs in `ships.json`, and per-bot quarters room IDs in `fleet.json`. Commit and push secrets.

## Message Format

Messages use Matrix's `org.matrix.custom.html` format with `formatted_body` for rich content (links, tables, collapsible sections).

## Verification

1. **Server reachable** — `curl https://matrix.a-gis.org/_matrix/client/versions` returns supported versions.
   *Check:* HTTP 200 with version list.

2. **Accounts login** — `POST /_matrix/client/v3/login` with operator, loudspeaker, and intercom credentials.
   *Check:* Each returns `access_token`, `user_id`, `device_id`.

3. **Rooms exist** — Duty rooms, ship space, lounge, quarters space, and per-bot rooms all created.
   *Check:* Operator's `GET /_matrix/client/v3/joined_rooms` includes all expected room IDs.

4. **Space hierarchy** — Lounge and quarters space are children of ship space.
   *Check:* `GET /_matrix/client/v3/rooms/$SPACE_ID/state/m.space.child/$CHILD_ID` returns `{"via": ["a-gis.org"]}`.

5. **Power levels** — Captain and operator are admin in every room.
   *Check:* `GET /_matrix/client/v3/rooms/$ROOM_ID/state/m.room.power_levels/` shows both at power 100.

6. **Message round-trip** — Operator posts a message, reads it back.
   *Check:* `POST /_matrix/client/v3/rooms/$ROOM_ID/send/m.room.message` succeeds, message appears via `/messages` endpoint.
