# 14 — Ship Spaces, Quarters & Memory

## Ship Spaces

Each ship is a Matrix space containing its local rooms. Structure:

```
HERACLES (space)
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

## Bot Status

| Status | Icon | Location | Brain | Lobes/Threads | Container |
|--------|------|----------|-------|---------------|-----------|
| `onduty` | `🟢` | Duty room | Full model | Yes | Running |
| `lounge` | `🍸` | Lounge | Sonnet | No | Stopped |
| `quarters` | `🏠` | Quarters room | Sonnet | No | Running |
| `sleep` | `💤` | Quarters room | — | — | Stopped |
| `transit` | `🚀` | — | — | — | Stopped |

Bots only have access to lobes and threading capability when `onduty`.

A bot cannot be `onduty` on a decommissioned ship, but can be awake in `lounge` or `quarters`.

## Lifecycle Commands

```
!join cid      → lounge/quarters → onduty (restore brain, enable lobes, join duty room)
!dismiss cid   → onduty → lounge (downgrade to sonnet, disable lobes, join lounge)
!sleep cid     → any → sleep (stop container, leave all rooms except quarters)
!wake cid      → sleep → quarters (start container in quarters, sonnet brain)
!restart cid   → onduty → onduty (rebuild + restart)
```

### !dismiss

1. Stop the bot process
2. Save current `BRAIN_MODEL` to `activeBrainModel` in fleet.json
3. Set `BRAIN_MODEL=claude-sonnet-4-6`, set `LOBES_DISABLED=1`
4. Login as bot, leave duty room, join Lounge
5. Update fleet.json status to `lounge`

### !join

1. Restore `BRAIN_MODEL` from `activeBrainModel`, clear `LOBES_DISABLED`
2. Update fleet.json status to `onduty`
3. Login as bot, leave Lounge, join duty room
4. Build and start the bot process

### !sleep

1. Stop the bot process, kill containers
2. Login as bot, leave duty room and Lounge (stays in quarters only)
3. Update fleet.json status to `sleep`

### !wake

1. Update fleet.json status to `quarters`
2. Build and start the bot process (in quarters, sonnet brain)

## Bot Rooms as Memory

Bots are **always** members of their private Room (Cid's Room, etc.) and the ship's Quarters space.

Each bot's Room is a permanent memory log. Instead of writing directly to `MEMORY.md`, bots post observations, learnings, and decisions as messages in their Room. The Room history is the raw experiential memory — permanent, searchable, visible to the Captain.

`MEMORY.md` becomes a curated summary. The bot periodically reads back its Room history and distills key patterns into `MEMORY.md`. This replaces the planned memex (SQLite FTS5) with something simpler — Matrix *is* the memory store.

### Memory flow

```
Bot learns something during work
  -> Posts to its Room: "Learned: rollup corruption happens when containers run npm ci on shared node_modules"
  -> Room history accumulates over days/weeks
  -> Periodically: bot reads Room history, rewrites MEMORY.md with distilled patterns
```

The Captain can see what bots are remembering and correct them directly in the Room.

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
      "status": "onduty",
      "quartersRoom": "!wEA7CKIizG4Ez6o1Vn:a-gis.org",
      "activeBrainModel": "claude-opus-4-6"
    }
  }
}
```

Ship space IDs in `ships.json`:

```json
{
  "HERACLES": {
    "spaceId": "!07deyffURvB77fTyOM:a-gis.org",
    "loungeId": "!k7z5JU3UnKfWWlyWln:a-gis.org",
    "quartersSpaceId": "!nSg57aPMuHam4bhXTs:a-gis.org"
  }
}
```
