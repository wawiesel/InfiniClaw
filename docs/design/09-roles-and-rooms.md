# 09 — Roles and Rooms

Roles define what a bot can do. Rooms define where a bot is and what state it's in. Together they organize the fleet.

## Roles

Roles are abstract capability sets. Personas are concrete bot identities assigned to a role. The mapping lives in fleet state under each bot's entry. Bots are organized by role in `bots/{role}/{bot}/`.

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
| 📝 | retrospective | Dismissed to quarters; reflecting on duty cycle |
| 💤 | dream | Container stopped; deferred code changes applying |
| ✅ | ready | Container started fresh; awaiting next `!report` |
| 🔄 | building | Transient — container image building |
| 🚀 | starting | Transient — container spawning |
| 🟡 | waiting | Transient — waiting for first output |
| 🟢 | online | Running, responding |
| ⭐ | Chief | Room lead — highest-rank active bot in duty room |

Display name format: `<pip> <name> <shipEmoji>` (e.g. `🟢 Cid 🦁`). Chief is elected automatically — lowest-rank-number active bot in a duty room (see [12-co](12-co.md)).

### Room assignment

A bot is **always** in its quarters room. It can be in at most one additional room:

| Status | Rooms | Brain | triggerType | Container |
|--------|-------|-------|-------------|-----------|
| `onduty` | Quarters + duty room | Full model | `callout` | Running |
| `quarters` | Quarters only | Full model | `always` | Running |
| `retrospective` | Quarters only | Full model | `always` | Running |
| `sleep` | Quarters only | — | `never` | Stopped |
| `dream` | Quarters only | — | `never` | Stopped |
| `ready` | Quarters only | Full model | `always` | Running |
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
!wake cid      → stop + kill + restart in quarters (picks up new code)
```

### !wake

1. Update fleet state: `status=quarters`, `triggerType=always`
2. Build and start the bot process (in quarters, full brain)
3. Pip stages: 💤 → 🔄 → 🚀 → 🟡 → 🟢

### !sleep

1. Stop the bot process, kill containers
2. Login as bot, leave all rooms except quarters
3. Update fleet state: `status=sleep`, `triggerType=never`, pip → 💤

### !report

Sends awake bot(s) to their duty room. Skips sleeping bots. **Instant** — no rebuild or restart.

From a duty room: pull bot(s) into THIS duty room.
From a non-duty room: send bot(s) to their RESPECTIVE duty rooms.

1. Leave any non-quarters room, join duty room
2. Update fleet state: `status=onduty`, `triggerType=callout`
3. `relay <Name> on duty` or `relay <Name> failed to report — <error>`

### !dismiss

**Instant** — bot keeps running in quarters with full capabilities.

1. Leave duty room
2. Update fleet state: `status=quarters`, `triggerType=always`
3. `relay <Name> dismissed`

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

## Duty Cycle

A bot's operational life is a repeating **duty cycle**. The relay manages transitions mechanically — no operator intervention needed for normal operation.

### Cycle Phases

```
quarters → report → ON DUTY → dismiss → retrospective → sleep → dream → compaction → wake
    ↑                                                                                    │
    └────────────────────────────────────────────────────────────────────────────────────────┘
```

| # | Phase | Where | What happens | Duration |
|---|-------|-------|-------------|----------|
| 0 | **On duty** | Duty room | Working WBS items, responding to callouts. `triggerType=callout`. **No code resyncs.** | `DUTY_CYCLE_MS` (configurable) |
| 1 | **Retrospective** | Quarters room | Loudspeaker asks structured questions (what went well, what went poorly, learnings). Bot reflects, updates MEMORY.md and CLAUDE.md. | Until complete or timeout |
| 2 | **Sleep** | Quarters room | Container stopped. Everything rebuilt to latest versions — git sync, `npm ci`, container image rebuild. Native modules recompiled. | Until rebuild complete |
| 3 | **Dream** | Quarters room | Trippy what-if scenarios thrown at the bot — creative, lateral-thinking prompts that push the bot outside its normal operating patterns. | Configurable |
| 4 | **Compaction** | Quarters room | Session gets compacted (standard Claude compaction). Context distilled to essentials. | Automatic |
| 5 | **Wake** | Quarters room → duty room | Bot starts fresh with latest code, compacted context, and updated persona. `triggerType=always` until `!report`. | Immediate → next cycle |

### No Resync While On Duty

**Critical rule:** The git sync loop must NOT restart a bot that is on duty. Code changes detected during a duty cycle are **queued** and applied during the Sleep phase. To interrupt a duty cycle, use `!dismiss` then `!sleep` manually.

Change classification:
- **Runtime** (`src/*.ts`, `package.json`, `Dockerfile`): queued until Sleep phase
- **Persona** (`bots/*/CLAUDE.md`, `skills/*`): queued until Sleep phase
- **No-op** (`README.md`, `docs/*`, test files): never trigger restarts

### Duty Timer

`ondutyAt` is tracked per bot in fleet state (set by `fleetUpdate` on `!report`, cleared on `!dismiss`). The `dutyCycleLoop` checks every 60s whether any onduty bot has exceeded `DUTY_CYCLE_MS`.

### Phase 1: Retrospective

On duty period expiry, the relay dismisses the bot to quarters and the loudspeaker sends structured retrospective questions:

1. **Dismiss to quarters** — Relay runs `!dismiss`, WBS items reabsorbed
2. **Retrospective questions** — Loudspeaker sends to the bot's quarters room:
   - "What went well since your last duty cycle?"
   - "What didn't go well? Any blockers or mistakes?"
   - "How could you do better next time?"
   - "Which parts of your CLAUDE.md helped you achieve your goals? Which parts didn't?"
   - "Update your CLAUDE.md and MEMORY.md now. Post 'Update complete.' when done."
3. Bot responds to each question in quarters (visible to Captain)

The retrospective prompt template lives as a skill: `skills/retrospective/SKILL.md`.

### Phase 2: Sleep

After retrospective completes:

1. Container stops
2. Git sync pulls latest code
3. `npm ci` installs fresh dependencies (including native module recompilation)
4. Container image rebuilt if Dockerfile or dependencies changed
5. All deferred code/persona changes land

This is the only phase where rebuilds happen — never during wake. This prevents native module ABI mismatches (e.g. better-sqlite3) that occur when rebuilding while a process is running.

### Phase 3: Dream

Creative phase — the relay sends the bot unusual, lateral-thinking prompts:
- "What if the fleet had no operator?"
- "What would happen if all bots shared one brain?"
- "Redesign the WBS system from scratch in 3 sentences."

Dream prompts push the bot to think outside its operational patterns. Responses are posted to quarters (visible to Captain). Dream scenarios are defined in `skills/dream/SKILL.md`.

### Phase 4: Compaction

Standard Claude session compaction. The bot's conversation context is distilled to its essential elements — key decisions, active work state, and critical learnings. This ensures the next duty cycle starts with a clean, focused context rather than a bloated history.

### Phase 5: Wake

1. Container starts with latest code and rebuilt image
2. Bot loads compacted context + updated persona
3. `status=quarters`, `triggerType=always`
4. Ready for `!report` to begin next duty cycle

## Implementation

### Room IDs

Quarters room IDs are stored in fleet state per bot (disk cache: `fleet.json`):

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
   *Check:* Container mounts match role definitions in fleet state.

2. **Status transition** — `!dismiss cid` moves Cid from duty room to quarters.
   *Check:* Cid leaves Engineering. Pip stays 🟢 (still online). Fleet state status → `quarters`.

3. **triggerType on dismiss** — Dismissed bot switches to `always` trigger.
   *Check:* Fleet state shows `triggerType: "always"` after dismiss. Brain model unchanged.

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
