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
bash operator/send <room> "<message>"
```

Operators on each ship use intercom to issue x-commands that all relays receive. Messages appear as the intercom account in the room. For direct communication, operators use their own `@operator` Matrix account.

### Bots → Other Rooms

Any on-duty bot can send cross-room messages by mentioning the target room in their message (e.g., `@engineering: <message>`). The relay detects the pattern and sends via the target room's intercom account. Messages appear as `<BotName> (<SourceRoom>): <message>`. Each on-duty room has access to the other two room intercoms. See [02-matrix](02-matrix.md) for the full `@room:` mention spec.

### Relays → Rooms

Relays reply to x-commands via the `@loudspeaker` account. All replies are prefixed with `[SHIPNAME]`.

## How Relays Receive Commands

The relay on each ship connects to Matrix as the intercom accounts (same credentials as `send`). X-commands (messages starting with `!`) are always processed, even from self. This is how operator-sent x-commands reach all relays:

1. Operator sends `!rejoin cid` via `send bridge`
2. Message arrives in Bridge room from `bridge-intercom`
3. Every ship's relay polls Bridge as `bridge-intercom` (different device IDs)
4. All relays see the `!` message and process it
5. Each relay checks if the target bot is local — only the owning ship acts

Echo loops are impossible because the relay never sends `!`-prefixed messages itself.

## Operator Callout (`!relay`)

The Captain can send commands to an operator's tmux session from any Matrix room by typing `!relay <text>`. The text is sent as keystrokes to the `operator` tmux session on each ship. If no session exists, one is created with `claude` as the initial command. Captain/intercom only.

## Verification

1. **Operator sends command** — `bash operator/send engineering "!fleet"`.
   *Check:* Message appears in Engineering from intercom account. Relay processes it.

2. **All relays receive** — Send `!fleet` via intercom.
   *Check:* Every ship's relay log shows the command received.

3. **CO cross-room messaging** — CO bot sends via intercom to another room.
   *Check:* Message appears in target room with `BotName (SourceRoom):` prefix.

4. **Non-CO blocked** — Non-CO bot tries to use intercom.
   *Check:* Error returned, message not sent.

5. **No echo loops** — Relay processes an x-command and replies.
   *Check:* Reply does not start with `!`, relay does not re-process its own reply.
