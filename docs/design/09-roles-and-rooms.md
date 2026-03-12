# 09 — Roles and Rooms

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

### Quarters Trigger Rules

A bot in its quarters room is a **primary** — it owns the room. Trigger behavior is determined by `triggerType` (see [05-bot](05-bot.md)):

| Status | triggerType | Responds to |
|--------|------------|-------------|
| `quarters` (awake) | `always` | Anyone — every message triggers |
| `onduty` | `callout` | Explicit `<m>Name</m>`, participating thread, or CO |
| `sleep` | `never` | Nothing — but captain/operator mentions auto-wake |

When a sleeping bot receives a captain/operator mention, the relay auto-wakes it (transitions `sleep` → `quarters`, `triggerType` → `always`), delivers the message, then the bot stays awake until explicitly put back to sleep.

### Permissions

- **Captain** (`@wawiesel`) and **Operator** (`@operator`) are admin (power 100) in all ship rooms.
- **Bots** are regular members (power 0).
- **Intercom accounts** are never in ship rooms — they only operate in duty rooms.

## Bot Status

The pip reflects **operational status**, not which room the bot is in. A bot's room assignment is a separate axis.

### Status (pip)

| Pip | Status | Meaning |
|-----|--------|---------|
| 💤 | sleep | Container stopped |
| 🔄 | building | Transient — container image building |
| 🚀 | starting | Transient — container spawning |
| 🟡 | waiting | Transient — waiting for first output |
| 🟢 | online | Running, responding |
| ⭐ | CO | Commanding officer (special online) |

Display name format: `<name> <pip> (<ship>)`. CO is elected automatically — lowest-rank active bot in a duty room.

### Room assignment

A bot is **always** in its quarters room. It can be in at most one additional room:

| fleet.json status | Rooms | Brain | triggerType | Container |
|-------------------|-------|-------|-------------|-----------|
| `onduty` | Quarters + duty room | Full model | `callout` | Running |
| `quarters` | Quarters only | Full model | `always` | Running |
| `sleep` | Quarters only | — | `never` | Stopped |
| `transit` | — | — | `never` | Stopped |

Quarters and onduty are functionally identical environments — same brain, same lobes, same branch brains. The only differences are which rooms the bot is in and `triggerType`. A bot in quarters is transferrable to another ship without reboot.

Quarters is also a place for retrospective work — a bot can use its quarters room to collect learnings, write up session notes, and update `MEMORY.md` without cluttering the duty rooms.

A bot cannot be `onduty` on a decommissioned ship, but can be awake in `quarters`.

## Lifecycle Commands

Three clean axes: **lifecycle** (`!wake`/`!sleep`), **duty** (`!report`/`!dismiss`), **roaming** (`!go`).

```
!wake cid      → sleep → quarters (start container, triggerType=always)
!sleep cid     → any → sleep (stop container, triggerType=never)
!report cid    → quarters → onduty (join duty room, triggerType=callout)
!dismiss cid   → onduty → quarters (leave duty room, triggerType=always)
!go lounge cid → move to lounge (no attribute change)
!rejoin cid    → dismiss + report (full lifecycle reset)
!refresh cid   → same status (stop + rebuild + start, no attribute changes)
```

### !wake

1. Update fleet.json: `status=quarters`, `triggerType=always`
2. Build and start the bot process (in quarters, full brain)
3. Pip stages: 💤 → 🔄 → 🚀 → 🟡 → 🟢

### !sleep

1. Stop the bot process, kill containers
2. Login as bot, leave all rooms except quarters
3. Update fleet.json: `status=sleep`, `triggerType=never`, pip → 💤

### !report

Sends awake bot(s) to their duty room. Skips sleeping bots. **Instant** — no rebuild or restart.

From a duty room: pull bot(s) into THIS duty room.
From a non-duty room: send bot(s) to their RESPECTIVE duty rooms.

1. Leave any non-quarters room, join duty room
2. Update fleet.json: `status=onduty`, `triggerType=callout`
3. `📢 <Name> reporting for duty` or `📢 <Name> failed to report`

### !dismiss

**Instant** — bot keeps running in quarters with full capabilities.

1. Leave duty room
2. Update fleet.json: `status=quarters`, `triggerType=always`
3. `📢 <Name> dismissed`

### !go

Sends a bot to a non-quarters, non-duty room. With no args, lists available rooms.

1. `!go` — list available rooms (lounge, etc.)
2. `!go <room> <bot>` — move bot to the specified room (no status or brain change)

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

2. **Status transition** — `!dismiss cid` moves Cid from duty room to quarters.
   *Check:* Cid leaves Engineering. Pip stays 🟢 (still online). fleet.json status → `quarters`.

3. **triggerType on dismiss** — Dismissed bot switches to `always` trigger.
   *Check:* fleet.json shows `triggerType: "always"` after dismiss. Brain model unchanged.

4. **CO election** — Two bots in Engineering, lowest rank gets ⭐.
   *Check:* Lower-ranked bot's display name shows ⭐. Higher-ranked shows 🟢.

5. **Bot room memory** — Bot posts a learning to its quarters room.
   *Check:* Message appears in bot's private room, visible to Captain.

6. **Lifecycle round-trip** — `!dismiss cid` then `!report cid`.
   *Check:* Cid ends up back in Engineering. `triggerType` back to `callout`.

7. **Report skips sleeping** — `!report` with a sleeping bot.
   *Check:* Sleeping bot is skipped, awake bots report for duty.

8. **Go room** — `!go lounge cid` sends Cid to lounge.
   *Check:* Cid joins lounge room. Status and brain unchanged.
