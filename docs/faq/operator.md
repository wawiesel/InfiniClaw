# Operator FAQ — Communication Architecture

## Overview

There are **3 layers** of communication, each serving a different purpose:

1. **Relay** — Matrix lifecycle commands (`!join`, `!dismiss`, `!restart`, `!fleet`, `!transport`, etc.)
2. **Intercom** — cross-room messaging (operator→bot and bot→bot)
3. **Operator** — Claude Code in a tmux session, the human-in-the-loop escape hatch

## 1. Relay

A Node.js process (`src/relay.ts`) that runs alongside bots on each machine via pm2 as `infiniclaw-relay`. It long-polls Matrix `/sync` on all three room intercom accounts simultaneously.

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
| `!promote <bot>` / `!demote <bot>` | Swap rank within role |
| `!fleet` / `!fleet room` | Fleet status with real state check |
| `!health` | Fleet health summary via S3 |
| `!activate` / `!deactivate` | Machine lifecycle |
| `!operator <text>` | Send text to tmux `operator` session |
| `!allow <bot> <path> [min]` / `!deny <bot> <path>` | Mount grants |

### Multi-machine awareness

When you say `!restart cid` in Engineering, *every* machine's relay sees it. Each checks if `cid` is assigned to this machine in fleet.json. Only the machine that owns `cid` acts — others silently ignore.

### Authorization

Only the Captain (`CAPTAIN_USER_ID` from bot env) and intercom accounts (`/-intercom:/` sender pattern) can issue commands.

### Replies

Relay replies via the same intercom account. All replies are prefixed with `HOSTNAME:`.

## 2. Intercom

Two systems using the same intercom Matrix accounts:

### a) Operator → Bot (shell script)

```bash
bash operator/intercom-send.sh <room> "<message>"
```

### b) Bot → Bot cross-room

Bots can `send_message()` with a recipient in another room. The host routes it through the intercom relay.

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
