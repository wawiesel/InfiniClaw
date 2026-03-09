# 01 — Matrix

Matrix is the communication backbone. Every message, command, and status update flows through Matrix. InfiniClaw uses a self-hosted Conduwuit homeserver.

## Account Types

| Account | Purpose |
|---------|---------|
| Captain (`@wawiesel:a-gis.org`) | Human operator. Admin in all rooms. |
| Operator (`@operator:a-gis.org`) | Automated operator. Admin in all rooms. Used for room management, invites, power levels. |
| Loudspeaker (`@loudspeaker:a-gis.org`) | Fleet-wide announcements from the relay. Member of all rooms. Delivers status information (repo versions, fleet health, lifecycle changes). |
| Bot accounts (`@cid-bot:a-gis.org`, etc.) | One per bot. Joins rooms based on status. |
| Intercom accounts (`@bridge-intercom:a-gis.org`, etc.) | Write-only broadcast channels, one per duty room. Used by operators and relays. |

## Room Structure

### Fleet-wide Rooms (Duty Rooms)

Duty rooms are shared across all ships. Bots join/leave based on lifecycle status.

- **Bridge** — Captain + navigators
- **Engineering** — Captain + engineers
- **Astrometrics** — Captain + architects

### Ship Spaces

Each ship is a Matrix space containing its local rooms:

```
HERACLES (space)
  Lounge          — all ship bots + captain + operator (always)
  Quarters (space)
    Cid's Room    — cid + captain + operator (always)
    Johnny5's Room
    Albert's Room
```

### Permissions

- **Captain** and **Operator** are admin (power 100) in all rooms.
- **Bots** are regular members (power 0).
- **Intercom accounts** are only in duty rooms — never in ship rooms.

## Message Format

Messages use Matrix's `org.matrix.custom.html` format with `formatted_body` for rich content (links, tables, collapsible sections).

## Verification

1. **Server reachable** — `curl https://matrix.a-gis.org/_matrix/client/versions` returns supported versions.
   *Check:* HTTP 200 with version list.

2. **Account login** — `POST /_matrix/client/v3/login` with bot credentials.
   *Check:* Response includes `access_token`, `user_id`, `device_id`.

3. **Room membership** — Bot account is joined to its duty room.
   *Check:* `GET /_matrix/client/v3/joined_rooms` includes the room ID.

4. **Message send/receive** — Post a message to a room, read it back.
   *Check:* Message appears in room timeline via `/messages` endpoint.
