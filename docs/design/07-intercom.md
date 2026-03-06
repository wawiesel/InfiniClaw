# 07 — Intercom

Cross-room communication uses **intercom relay accounts** — dedicated Matrix accounts, one per room. Intercom accounts are **write-only broadcast channels**: operators and bots send messages through them, relays listen on them. They are not user identities.

## Accounts

| Room | Intercom Account |
|------|-----------------|
| Bridge | `bridge-intercom` |
| Engineering | `engineering-intercom` |
| Astrometrics | `astrometrics-intercom` |

Intercom credentials are stored in `operator/intercom.json` in the secrets repo. Accounts must be joined to their respective rooms on the Matrix homeserver.

## Who uses intercom

### Operators → Bots and Relays

```bash
bash operator/intercom-send.sh <room> "<message>"
```

Operators on each machine use intercom to communicate with bots and to issue `!` commands that all relays receive. Messages appear as the intercom account in the room. This is the primary way operators coordinate across machines — they do not have their own Matrix accounts.

### Bots → Bots (CO Only)

Only the CO can use the intercom. `send_message` checks `crew-status.json` at runtime — non-CO bots get an error. Messages appear as `<BotName> (<SourceRoom>): <message>`.

### Relays → Rooms

Relays reply to commands via the same intercom account they poll on. All replies are prefixed with `HOSTNAME:`.

## How relays receive commands

The relay on each machine connects to Matrix as the intercom accounts (same credentials as `intercom-send.sh`). Messages starting with `!` are always processed, even from self. This is how operator-sent `!` commands reach all relays:

1. Operator sends `!restart cid` via `intercom-send.sh bridge`
2. Message arrives in Bridge room from `bridge-intercom`
3. Every machine's relay polls Bridge as `bridge-intercom` (different device IDs)
4. All relays see the `!` message and process it
5. Each relay checks if the target bot is local — only the owning machine acts

Echo loops are impossible because the relay never sends `!`-prefixed messages itself.

## Operator callout (`!operator`)

The Captain can send commands to an operator's tmux session from any Matrix room by typing `!operator <text>`. The text is sent as keystrokes to the `operator` tmux session on each machine. If no session exists, one is created with `claude` as the initial command. Captain/intercom only.

Operators also run `inbox-watch.sh` which polls git for cross-machine tasks — the fallback channel when Matrix is down.
