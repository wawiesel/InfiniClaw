# 13 — Intercom

Cross-room communication uses **intercom relay accounts** — dedicated Matrix accounts, one per room. Intercom accounts are used by the **relay** to listen on each duty room and issue replies. They are not used for sending operator commands.

## Accounts

| Room | Intercom Account |
|------|-----------------|
| Bridge | `bridge-intercom` |
| Engineering | `engineering-intercom` |
| Astrometrics | `astrometrics-intercom` |

Intercom credentials are stored in `operator/intercom.json` in the secrets repo. Accounts must be joined to their respective rooms on the Matrix homeserver.

## Who Uses Intercom

### Operators → Bots and Relays

```bash
bash operator/matrix send <room> "<message>"
```

Operators send commands using their own `@operator` Matrix account — not through intercom accounts. The `operator/matrix send` script sends as `@operator`. The relay authorizes any `!` command from the captain or operator regardless of which account sent it.

### Bots → Other Rooms

Any on-duty bot can broadcast to all duty rooms via `@loudspeaker: <message>`. The relay detects this pattern, sends to all other duty rooms, and replies with confirmation. Messages appear as `BotName (SourceRoom): <message>`. Captain and operator messages are excluded from this path.

`@loudspeaker` alone (no colon or message) requests fleet status in the current room — equivalent to `!fleet` but callable by bots.

> **Status:** `@room:` text-prefix targeting is not implemented. Bot-to-room messaging uses `send_message(recipient="BotName")` MCP tool instead — see [02-matrix](02-matrix.md). `@loudspeaker:` broadcasts to all duty rooms only.

### Relays → Rooms

Relays reply to x-commands via the `@loudspeaker` account (falls back to the room's intercom account if loudspeaker is unavailable). All replies are prefixed with `[<emoji><pip> <ShipName>]` (e.g. `[🦁◉ Poseidon]`).

## How Relays Receive Commands

The relay on each ship logs in as each intercom account and polls the corresponding room. This is how operator-sent x-commands reach all relays:

1. Operator sends `!wake cid` via `bash operator/matrix send bridge "!wake cid"`
2. Message arrives in Bridge room from the `@operator` account
3. Every ship's relay polls Bridge as `bridge-intercom` (different device IDs)
4. All relays see the `!` message and process it (relay authorizes captain and operator senders)
5. Each relay checks if the target bot is local — only the owning ship acts

Echo loops are impossible because the relay never sends `!`-prefixed messages itself.

## Operator Callout (`@ <text>`)

The Captain can address the operator from any room the relay watches by prefixing a message with `@ `. The text is sent as keystrokes to the `operator` tmux session on each ship with `[RoomName | roomId]` prepended. If no session exists, one is created with `claude` as the initial command. BehindTheCurtain messages forward automatically without the `@` prefix. Captain only.

## Verification

1. **Operator sends command** — `bash operator/matrix send engineering "!fleet"`.
   *Check:* Message appears in Engineering from `@operator` account. Relay processes it and replies via loudspeaker.

2. **All relays receive** — Send `!fleet` via `operator/matrix send bridge`.
   *Check:* Every ship's relay log shows the command received.

3. **Bot cross-room broadcast** — On-duty bot sends `@loudspeaker: <text>` in a duty room.
   *Check:* Message appears in all other duty rooms as `BotName (SourceRoom): <text>`.

4. **Captain/operator filtered** — Captain sends `@loudspeaker: <text>`.
   *Check:* Not broadcast (Captain/operator are excluded from the loudspeaker path).

5. **No echo loops** — Relay processes an x-command and replies.
   *Check:* Reply does not start with `!`, relay does not re-process its own reply.
