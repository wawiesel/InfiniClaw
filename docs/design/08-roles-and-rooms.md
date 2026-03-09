# 08 — Roles and Rooms

Roles define what a bot can do. Rooms define where a bot is and what state it's in. Together they organize the fleet.

## Roles

Roles are abstract capability sets. Personas are concrete bot identities assigned to a role. The mapping lives in `fleet.json` under each bot's entry. Bots are organized by role in `bots/{role}/{bot}/`.

Each role defines what a bot can do:

| Role | Rank | Capabilities | Restrictions |
|------|------|-------------|-------------|
| Normie | 0 | Basic conversation. No skills, no MCP, no duty rooms. Quarters and lounge only. | Cannot do anything beyond talking. |
| Navigator | 1 | Explore filesystem, execute tasks, report to Captain. Write access to knowledge vault. Email and calendar access. | Cannot modify other bots. |
| Engineer | 2 | Maintain and improve the codebase. Rebuild container images. Modify any bot's persona, skills, MCP. Write access to InfiniClaw. Can restart other bots. | Upstream nanoclaw owned by Architect. |
| Architect | 3 | Create new bots, major redesigns. Write access to InfiniClaw, NanoClaw, WKS, AEGIS. Can deploy and test on the Holodeck. | Must test on Holodeck before promoting. |

The normie role is the simplest bot — useful for early testing and verification of the bot runtime without any higher-level features. Default brain model: Haiku.

All bots share: read-only home directory access, ability to edit own persona CLAUDE.md/skills/MCP, ability to restart self.

## Rooms

Messages go to **rooms**, not to bots directly. Each room is a Matrix room mapped to a NanoClaw "group" (the upstream term from its WhatsApp origins). Multiple bots can share a room.

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

Duty rooms (Engineering, Bridge, Astrometrics) are fleet-wide — they are NOT children of ship spaces. A bot is either in its duty room or in the Lounge, never both.

### Threading by Room

Threads (Thread Brains, branch/merge) are only available in duty rooms. Quarters and lounge do not support threading — bots in those rooms respond directly on the room timeline. This keeps non-duty rooms simple and conversational.

### Permissions

- **Captain** (`@wawiesel`) and **Operator** (`@operator`) are admin (power 100) in all ship rooms.
- **Bots** are regular members (power 0).
- **Intercom accounts** are never in ship rooms — they only operate in duty rooms.

## Bot Status

| Status | Pip | Location | Brain | Lobes/Threads | Container |
|--------|-----|----------|-------|---------------|-----------|
| `onduty` | 🟢 | Duty room | Full model | Yes | Running |
| `co` | ⭐ | Duty room | Full model | Yes | Running |
| `lounge` | 🍸 | Lounge | Sonnet | No | Stopped |
| `quarters` | 🏠 | Quarters room | Sonnet | No | Running |
| `sleep` | 💤 | Quarters room | — | — | Stopped |
| `transit` | 🚀 | — | — | — | Stopped |

Display name format: `<name> <pip> [<ship>]`. CO is a status — the lowest-rank active bot in a room gets it automatically.

Bots only have access to lobes and threading capability when `onduty` or `co`.

A bot cannot be `onduty` on a decommissioned ship, but can be awake in `lounge` or `quarters`.

## Lifecycle Commands

```
!join cid      → lounge/quarters → onduty (restore brain, enable lobes, join duty room)
!dismiss cid   → onduty → lounge (downgrade to sonnet, disable lobes, join lounge)
!sleep cid     → any → sleep (stop container, leave all rooms except quarters)
!wake cid      → sleep → quarters (start container in quarters, sonnet brain)
!rejoin cid    → onduty → lounge → onduty (dismiss + join)
!refresh cid   → onduty → onduty (stop + rebuild + start, no brain/room changes)
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

## Verification

1. **Role determines mounts** — An engineer bot has rw access to InfiniClaw. A navigator has rw access to vault.
   *Check:* Container mounts match role definitions in fleet.json.

2. **Status transition** — `!dismiss cid` moves Cid from duty room to Lounge.
   *Check:* Cid leaves Engineering, joins Lounge. Pip changes from 🟢 to 🍸. fleet.json status updates.

3. **Brain downgrade on dismiss** — Dismissed bot runs on Sonnet, not Opus.
   *Check:* Bot's env shows `BRAIN_MODEL=claude-sonnet-4-6` after dismiss.

4. **CO election** — Two bots in Engineering, lowest rank gets ⭐.
   *Check:* Lower-ranked bot's display name shows ⭐. Higher-ranked shows 🟢.

5. **Bot room memory** — Bot posts a learning to its quarters room.
   *Check:* Message appears in bot's private room, visible to Captain.

6. **Lifecycle round-trip** — `!dismiss cid` then `!join cid`.
   *Check:* Cid ends up back in Engineering with original brain model restored.
