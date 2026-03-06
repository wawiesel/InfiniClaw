# Operator FAQ — Communication Architecture

## Overview

There are **3 layers** of communication, each serving a different purpose:

1. **Relay** — Matrix lifecycle commands (`!join`, `!dismiss`, `!restart`, `!fleet`, `!transport`, etc.)
2. **Intercom** — cross-room messaging (operator→bot and bot→bot)
3. **Operator** — Claude Code in a tmux session, the human-in-the-loop escape hatch

## 1. Relay

A Node.js process (`src/relay.ts`) that runs on **every machine** via pm2 as `infiniclaw-relay`. It long-polls Matrix `/sync` on all three room intercom accounts simultaneously. The relay runs at all times, even on deactivated machines — deactivation stops bots but keeps the relay listening.

### How it works

- Reads `intercom.json` from secrets — gets credentials for `bridge-intercom`, `engineering-intercom`, `astrometrics-intercom`
- Logs into Matrix as each intercom account, creates a sync filter (only `m.room.message` events)
- Does an initial sync to skip old messages, then enters a long-poll loop (`/sync?timeout=30000`)
- Each room runs its own `dialtone()` loop in parallel with exponential backoff on errors

### Commands

| Command | Action |
|---------|--------|
| `!join <bot>` | Start bot, update fleet.json |
| `!dismiss <bot>` | Stop bot, update fleet.json |
| `!restart <bot>` | Stop + deploy + start (full redeploy) |
| `!transport <bot> <machine>` | Two-phase bot migration |
| `!promote <target>` / `!demote <target>` | Swap rank (bot within role, or machine) |
| `!fleet` / `!fleet room` | Fleet status with real state check |
| `!health` | Fleet health summary via S3 |
| `!activate [machine]` / `!deactivate [machine]` | Machine lifecycle (no arg = all) |
| `!sync [target]` | Sync repos (secrets, infiniclaw, or any paths.json name) |
| `!operator <text>` | Send text to tmux `operator` session |
| `!allow <bot> <path> [min]` / `!deny <bot> <path>` | Mount grants |

### Multi-machine fan-out

Every `!` command is broadcast to all machines. When you say `!restart cid` in Engineering, every machine's relay sees it. Each checks if `cid` is local (via fleet.json). Only the owning machine acts — the rest silently ignore. This works because all relays connect to the same intercom accounts.

### Authorization

Only the Captain (`CAPTAIN_USER_ID` from bot env) and intercom accounts (`/-intercom:/` sender pattern) can issue commands. Operators send commands via `intercom-send.sh`, which uses the same intercom accounts the relays poll — so operator commands are inherently authorized.

### Replies

Relay replies via the same intercom account. All replies are prefixed with `HOSTNAME:`.

## 2. Intercom

Intercom accounts are **write-only broadcast channels** — not user identities. Three uses:

### a) Operator → Bots and Relays

```bash
bash operator/intercom-send.sh <room> "<message>"
```

This is how operators on each machine communicate with bots and issue `!` commands across the fleet. Operators do not have their own Matrix accounts — they operate exclusively through intercom.

### b) Bot → Bot cross-room (CO only)

Bots can `send_message()` with a recipient in another room. The host routes it through the intercom relay.

### c) Relay → Room (replies)

Relays respond to commands via the same intercom account, prefixed with `HOSTNAME:`.

## 3. Operator (tmux session)

Claude Code in a tmux session. The escape hatch for when bots can't handle something themselves.

### How it's reached

- `!operator <text>` in any Matrix room → relay sends keystrokes to tmux session named `operator`
- If no session exists, relay creates one

## Key files

| File | Purpose |
|------|---------|
| `src/relay.ts` | Relay process — Matrix sync + command handling |
| `src/intercom-relay.ts` | Host-side intercom HTTP relay for cross-room messages |
| `src/ipc-watcher.ts` | IPC file watcher — routes messages, detects cross-room |
| `src/ipc-commands.ts` | IPC command handlers (restart, health, fleet, etc.) |
| `src/service.ts` | Bot lifecycle — deploy, start, stop, pm2 management |
| `operator/intercom.json` | Intercom account credentials (in secrets repo) |
| `operator/intercom-send.sh` | Shell script for operator→bot messaging |
