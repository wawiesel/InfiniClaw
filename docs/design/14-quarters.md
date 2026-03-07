# 14 — Ship Spaces, Quarters & Memory

## Ship Spaces

Each ship is a Matrix space containing its local rooms. Structure:

```
HERACLES (space) — "The ship"
  Lounge          — all ship bots + captain + operator (always)
  Quarters (space)
    Cid's Room    — cid + captain + operator (always)
    Johnny5's Room
    Albert's Room
```

Duty rooms (Engineering, Bridge, Astrometrics) are fleet-wide — they are NOT children of ship spaces. A bot is either in its duty room or in the Lounge, never both.

### Permissions

- **Captain** (`@wawiesel`) and **Operator** (`@operator`) are admin (power 100) in all ship rooms.
- **Bots** are regular members (power 0).
- **Intercom accounts** are never in ship rooms — they only operate in duty rooms.

## Lifecycle

```
!join cid     → cid joins duty room, leaves Lounge
!dismiss cid  → cid leaves duty room, joins Lounge
```

The relay handles room join/leave using the bot's Matrix credentials (from `bots/{name}/env`). The bot's status in `fleet.json` tracks whether it's on duty.

Bots are **always** members of:
- Their private Room (Cid's Room, etc.)
- The ship's Quarters space

They move between:
- **Duty room** (Engineering, etc.) — when active/joined
- **Lounge** — when dismissed

## Bot Rooms as Memory

Each bot's Room is a permanent memory log. Instead of writing directly to `MEMORY.md`, bots post observations, learnings, and decisions as messages in their Room. The Room history is the raw experiential memory — permanent, searchable, visible to the Captain.

`MEMORY.md` becomes a curated summary. The bot periodically reads back its Room history and distills key patterns into `MEMORY.md`. This replaces the planned memex (SQLite FTS5) with something simpler — Matrix *is* the memory store.

### Memory flow

```
Bot learns something during work
  → Posts to its Room: "Learned: rollup corruption happens when containers run npm ci on shared node_modules"
  → Room history accumulates over days/weeks
  → Periodically: bot reads Room history, rewrites MEMORY.md with distilled patterns
```

The Captain can see what bots are remembering and correct them directly in the Room.

## What This Replaces

- `IGNORE_SENDERS` lists and filtering logic — bot not in room = can't see messages
- Memex (SQLite FTS5) backlog item — Matrix rooms are the memory store
- Direct `MEMORY.md` writes during work — post to Room instead, curate later

## Implementation

### Room IDs

Quarters room IDs are stored in `fleet.json` per bot:

```json
{
  "bots": {
    "cid": {
      "role": "engineer",
      "rank": 2,
      "ship": "HERACLES",
      "status": "active",
      "quartersRoom": "!wEA7CKIizG4Ez6o1Vn:a-gis.org"
    }
  },
  "ships": {
    "HERACLES": {
      "spaceId": "!07deyffURvB77fTyOM:a-gis.org",
      "loungeId": "!k7z5JU3UnKfWWlyWln:a-gis.org",
      "quartersSpaceId": "!nSg57aPMuHam4bhXTs:a-gis.org"
    }
  }
}
```

### Relay Changes

On `!dismiss`:
1. Stop the bot process
2. Login as bot via Matrix credentials from env file
3. Leave the duty room
4. Join the Lounge
5. Update fleet.json status

On `!join`:
1. Login as bot via Matrix credentials
2. Leave the Lounge
3. Join the duty room
4. Update fleet.json status
5. Start the bot process
