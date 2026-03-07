# 14 — Quarters

Dismissed bots leave their duty room and move to a private quarters room. This replaces `IGNORE_SENDERS` filtering and room-level ignore logic with a simple physical separation: in the room = on duty, in quarters = standing by.

## How It Works

Each bot has a private quarters room — a 1:1 room with the Captain. When a bot is dismissed, it leaves the duty room and joins its quarters. When joined back, it leaves quarters and joins the duty room.

### Lifecycle

```
!join cid     → cid leaves quarters, joins Engineering room
!dismiss cid  → cid leaves Engineering room, joins quarters
```

The relay handles room join/leave as part of the `!join`/`!dismiss` command processing. The bot's `active` state in `fleet.json` continues to track whether the bot is on duty.

### Quarters Rooms

- One quarters room per bot, created once during bot provisioning
- Room name: `{bot}-quarters` (e.g. `cid-quarters`)
- Members: the bot + the Captain
- The bot can still receive direct orders from the Captain while in quarters
- No other bots are in the quarters room — no filtering needed

### What This Replaces

Currently, dismissed bots stay in their duty room and rely on:
- `IGNORE_SENDERS` lists to avoid reacting to each other
- Filtering logic to skip messages from inactive bots
- The bot's host process deciding not to process messages

All of this goes away. A dismissed bot doesn't see duty room messages because it's not in the room.

## Rejoin Latency

On a private homeserver with small rooms, Matrix room joins take 2-5 seconds. This is fast enough for `!join` to feel responsive. No need for a "mute but stay" optimization.

## Why

Simpler than ignore rules. A bot that isn't in a room can't react to messages in that room — no filtering code, no edge cases, no `IGNORE_SENDERS` maintenance. The Captain can still reach any bot privately in its quarters for direct orders.
