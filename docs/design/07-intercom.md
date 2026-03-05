# 07 — Intercom

Cross-room communication uses **intercom relay accounts** — dedicated Matrix accounts, one per room. When a bot or operator sends a message to a different room, it goes through that room's intercom account.

## Accounts

| Room | Intercom Account |
|------|-----------------|
| Bridge | `bridge-intercom` |
| Engineering | `engineering-intercom` |
| Astrometrics | `astrometrics-intercom` |

Intercom credentials are stored in `operator/intercom.json` in the secrets repo. Accounts must be joined to their respective rooms on the Matrix homeserver.

## Operator Usage

```bash
bash operator/intercom-send.sh <room> "<message>"
```

Messages appear as `Operator (<hostname>): <message>`.

## Bot Usage (CO Only)

Only the CO can use the intercom. `send_message` checks `crew-status.json` at runtime — non-CO bots get an error. Messages appear as `<BotName> (<SourceRoom>): <message>`.

## Operator Callout (`!operator`)

The Captain can send commands to a human operator's tmux session from any Matrix room by typing `!operator <text>`. The text is sent as keystrokes to the `operator` tmux session on each machine. If no session exists, one is created with `claude` as the initial command. Captain/intercom only.

Operators also run `inbox-watch.sh` which polls git for cross-machine tasks — the fallback channel when Matrix is down.
