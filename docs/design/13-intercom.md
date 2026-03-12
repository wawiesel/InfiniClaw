# 13 — Intercom

Cross-room communication uses **intercom relay accounts** — dedicated Matrix accounts, one per room. Intercom accounts are **write-only broadcast channels**: operators and bots send messages through them, relays listen on them. They are not user identities.

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

Operators on each ship use intercom to issue x-commands that all relays receive. Messages appear as the intercom account in the room. For direct communication, operators use their own `@operator` Matrix account.

### Bots → Other Rooms

Any on-duty bot can broadcast to all duty rooms via `@loudspeaker: <message>`. The relay detects this pattern, sends to all other duty rooms, and replies with confirmation. Messages appear as `BotName (SourceRoom): <message>`. Captain and operator messages are excluded from this path.

> **Status:** `@room:` targeting (sending to a specific room) is not yet implemented — `@loudspeaker:` broadcasts to all duty rooms only. See [02-matrix](02-matrix.md).

### Relays → Rooms

Relays reply to x-commands via the `@loudspeaker` account. All replies are prefixed with `[<emoji> <ShipName>]` (e.g. `[🦁 Herc]`).

## How Relays Receive Commands

The relay on each ship connects to Matrix as the intercom accounts (same credentials as `send`). X-commands (messages starting with `!`) are always processed, even from self. This is how operator-sent x-commands reach all relays:

1. Operator sends `!rejoin cid` via `bash operator/matrix send bridge "!rejoin cid"`
2. Message arrives in Bridge room from `bridge-intercom`
3. Every ship's relay polls Bridge as `bridge-intercom` (different device IDs)
4. All relays see the `!` message and process it
5. Each relay checks if the target bot is local — only the owning ship acts

Echo loops are impossible because the relay never sends `!`-prefixed messages itself.

## Operator Callout (`@ <text>`)

The Captain can address the operator from any room the relay watches by prefixing a message with `@ `. The text is sent as keystrokes to the `operator` tmux session on each ship with `[RoomName | roomId]` prepended. If no session exists, one is created with `claude` as the initial command. BehindTheCurtain messages forward automatically without the `@` prefix. Captain/operator only.

## Verification

1. **Operator sends command** — `bash operator/matrix send engineering "!fleet"`.
   *Check:* Message appears in Engineering from intercom account. Relay processes it.

2. **All relays receive** — Send `!fleet` via intercom.
   *Check:* Every ship's relay log shows the command received.

3. **Bot cross-room broadcast** — On-duty bot sends `@loudspeaker: <text>` in a duty room.
   *Check:* Message appears in all other duty rooms as `BotName (SourceRoom): <text>`.

4. **Captain/operator filtered** — Captain sends `@loudspeaker: <text>`.
   *Check:* Not broadcast (Captain/operator are excluded from the loudspeaker path).

5. **No echo loops** — Relay processes an x-command and replies.
   *Check:* Reply does not start with `!`, relay does not re-process its own reply.
