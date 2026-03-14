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
| `onduty` | `callout` | Explicit `<m>Name</m>`, participating thread, or Chief fallback |
| `sleep` | `never` | Nothing — but captain/operator mentions auto-wake |

When a sleeping bot receives a captain/operator mention, the relay auto-wakes it (transitions `sleep` → `quarters`, `triggerType` → `always`), delivers the message, then the bot stays awake until explicitly put back to sleep.

### Permissions

- **Captain** (`@wawiesel`) and **Operator** (`@operator`) are admin (power 100) in all ship rooms.
- **Bots** are regular members (power 0).
- **Intercom accounts** are never in ship rooms — they only operate in duty rooms.

## Command Hierarchy

The fleet has a clear chain of command:

```
Captain
  └── Operator (Co until fleet is fully crewed)
        └── XO (Chief Navigator — highest rank on Bridge)
              └── Chiefs (highest-rank active bot per duty room)
                    └── Crew
```

**Chief** — The highest-rank active bot in a duty room is that room's Chief. The Chief leads the room: sets direction, delegates work, reviews results.

| Duty Room | Title |
|-----------|-------|
| Bridge | **XO** (Executive Officer — special title for Chief Navigator) |
| Engineering | **Chief Engineer** |
| Astrometrics | **Chief of Astrometrics** |

When fully crewed, Captain's commands go to the Bridge. The XO (Chief Navigator) distributes them across the fleet via the Chiefs.

The Operator currently acts as Co until a dedicated XO is in place.

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
| ⭐ | Chief | Room lead — highest-rank active bot in duty room |

Display name format: `<pip> <name> <shipEmoji>` (e.g. `🟢 Cid 🦁`). Chief is elected automatically — lowest-rank-number active bot in a duty room (see [12-co](12-co.md)).

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
!wake cid      → sleep→quarters (start, triggerType=always) | awake→restart (preserves status)
!sleep cid     → any → sleep (stop container, triggerType=never)
!report cid    → quarters → onduty (join duty room, triggerType=callout, lightweight restart)
!dismiss cid   → onduty → quarters (leave duty room, triggerType=always, lightweight restart)
!go lounge cid → move to lounge (no attribute change)
```

### !wake

If waking from sleep: update fleet.json: `status=quarters`, `triggerType=always`.
If already awake (restart): fleet.json status preserved — no change to `status` or `triggerType`.

1. Stop process, kill stale containers
2. Rebuild image if needed and start the bot process (lightweight — no rebuild for restart)
3. Pip stages: 💤 → 🔄 → 🚀 → 🟡 → 🟢

### !sleep

1. Stop the bot process, kill containers
2. Login as bot, leave all rooms except quarters
3. Update fleet.json: `status=sleep`, `triggerType=never`, pip → 💤

### !report

Sends awake bot(s) to their duty room. Skips sleeping bots and already-onduty bots. Lightweight restart — no rebuild.

From a duty room: pull bot(s) into THIS duty room.
From a non-duty room: send bot(s) to their RESPECTIVE duty rooms.

1. Leave any non-quarters room, join duty room
2. Update fleet.json: `status=onduty`, `triggerType=callout`
3. Lightweight restart so bot monitors duty room
4. `✅ <Name> on duty` or `⛔ <Name> report failed — <error>`

### !dismiss

Lightweight restart — no rebuild. Bot resumes in quarters monitoring its quarters room.

1. Leave duty room (and lounge if present)
2. Update fleet.json: `status=quarters`, `triggerType=always`
3. Lightweight restart so bot monitors quarters
4. `✅ <Name> dismissed`

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

## Retrospective Cycle

> **Status:** Not yet implemented.

After a configurable duty period, the relay forces a bot to quarters for a structured retrospective. This keeps context manageable, surfaces learnings, and keeps `MEMORY.md` current.

### Duty Timer

`ondutyAt` is tracked per bot in `_runtime/data/ipc/{bot}/status.json`. On each branch brain completion or heartbeat, the relay checks if `DUTY_CYCLE_MS` (default: 3600000ms / 1 hour) has elapsed.

### Retrospective Sequence

On duty period expiry:

1. **Force to quarters** — Relay runs `!dismiss → quarters` with `RETROSPECTIVE=1` in the IPC message
2. **Retrospective questions** — Relay sends these questions to the bot's quarters room as INTERCOM, waiting for a reply before sending the next:
   - "What went well since your last duty cycle?"
   - "What didn't go well? Any blockers or mistakes?"
   - "How could you do better next time?"
   - "Which parts of your CLAUDE.md helped you achieve your goals? Which parts didn't?"
   - "Update your CLAUDE.md and MEMORY.md now. Post 'Update complete.' when done."
3. **Auto-rejoin** — When bot posts "Update complete." (or on timeout `RETROSPECTIVE_TIMEOUT_MS`), relay commits/pushes the bot's memory files, then runs `!report`

The retrospective prompt template lives as a skill: `skills/retrospective/SKILL.md`.

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

4. **Chief election** — Two bots in Engineering, lowest rank number gets ⭐.
   *Check:* Lower-ranked bot's display name shows ⭐. Higher-ranked shows 🟢.

5. **Bot room memory** — Bot posts a learning to its quarters room.
   *Check:* Message appears in bot's private room, visible to Captain.

6. **Lifecycle round-trip** — `!dismiss cid` then `!report cid`.
   *Check:* Cid ends up back in Engineering. `triggerType` back to `callout`.

7. **Report skips sleeping** — `!report` with a sleeping bot.
   *Check:* Sleeping bot is skipped, awake bots report for duty.

8. **Go room** — `!go lounge cid` sends Cid to lounge.
   *Check:* Cid joins lounge room. Status and brain unchanged.
