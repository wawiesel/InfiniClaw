# Operator FAQ — Communication Architecture

## Overview

There are **3 layers** of communication, each serving a different purpose:

1. **Supervisor** — Matrix lifecycle commands (`!join`, `!dismiss`, `!restart`, `!operator`, `!roster`)
2. **Intercom Relay** — cross-room messaging (operator→bot and bot→bot)
3. **Operator** — Claude Code in a tmux session, the human-in-the-loop escape hatch

## 1. Supervisor

A Node.js process (`src/supervisor.ts`) that runs alongside bots on each machine via pm2. It long-polls Matrix `/sync` on all three room intercom accounts simultaneously.

### How it works

- Reads `intercom.json` from secrets — gets credentials for `bridge-intercom`, `engineering-intercom`, `astrometrics-intercom`
- Logs into Matrix as each intercom account, creates a sync filter (only `m.room.message` events)
- Does an initial sync to skip old messages, then enters a long-poll loop (`/sync?timeout=30000`)
- Each room runs its own `dialtone()` loop in parallel with exponential backoff on errors

### Commands

| Command | Action |
|---------|--------|
| `!join <bot>` | `deployBot()` + start via pm2 |
| `!dismiss <bot>` | Stop pm2 + kill containers |
| `!restart <bot>` | Stop + deploy + start (full redeploy) |
| `!operator <text>` | Send text to tmux `operator` session (starts one if none exists) |
| `!roster` | Reports which bots are on this machine + their pm2 status |

### Multi-machine awareness

When you say `!restart cid` in Engineering, *every* machine's supervisor sees it. Each checks if `cid` is in its `machine.json` bots list. Only the machine that owns `cid` (e.g. HERACLES) acts — others silently ignore.

Untargeted commands (bare `!restart`) scope to bots whose `MAIN_GROUP_NAME` matches the room the command arrived in.

### Authorization

Only the Captain (`CAPTAIN_USER_ID` from bot env) and intercom accounts (`/-intercom:/` sender pattern) can issue commands. Everyone else is logged and ignored.

### Replies

Supervisor replies via the same intercom account it received the command on. All replies are prefixed with `HOSTNAME:` so you know which machine responded.

## 2. Intercom Relay

Two separate systems that use the same intercom Matrix accounts:

### a) Operator → Bot (shell script)

```bash
bash operator/intercom-send.sh <room> "<message>"
```

Logs in as the room's intercom account, sends the message, logs out. Used by the Operator (Claude Code in tmux) to nudge bots. Sends message body as-is (no prefix), so you can put `@BotName` at the start to trigger a bot.

### b) Bot → Bot cross-room

When a bot calls `send_message(text: "hey", recipient: "Cid")`:

1. Container resolves "Cid" → Engineering room JID via `bot_directory.json`
2. Writes IPC file with `crossRoom: true` and `senderName: "Albert"`
3. Host IPC watcher picks it up, sees `crossRoom` flag
4. `src/intercom-relay.ts` loads `intercom.json`, finds the intercom account for Engineering's room ID
5. Logs in as `engineering-intercom`, sends `"Albert: hey"`, logs out
6. Cid sees it in Engineering as a message from `engineering-intercom`

### Why intercom accounts?

Bots can only post to their own room via their Matrix connection. To reach another room, you need a Matrix account that's joined to that room. The intercom accounts are joined to all rooms and serve as neutral relay points.

### Intercom credentials

Three accounts, one per room, shared across all machines via the secrets repo (`operator/intercom.json`):

| Account | Room | Purpose |
|---------|------|---------|
| `bridge-intercom` | Bridge | Relay to/from Bridge |
| `engineering-intercom` | Engineering | Relay to/from Engineering |
| `astrometrics-intercom` | Astrometrics | Relay to/from Astrometrics |

Each does login/send/logout per message (stateless). The supervisor keeps persistent connections for sync but uses the same credentials.

## 3. Operator (tmux session)

You (or the `!operator` command) running Claude Code in a tmux session on each machine. The Operator is the human-in-the-loop escape hatch.

### How it's reached

- `!operator <text>` in any Matrix room → supervisor catches it → sends keystrokes to tmux session named `operator`
- If no session exists, supervisor creates one (`tmux new-session -d -s operator -c <secretsPath> claude`)
- Uses `tmux send-keys -l` for literal text, then separate `Enter` key

### What it can do

- Read `operator/inbox.md` for cross-machine tasks
- Run `bash operator/intercom-send.sh <room> "<message>"` to talk to bots
- Run `npm run cli stop/start/restart` as fallback if supervisor commands don't work
- Edit config, rebuild images, anything a shell can do

## How they all connect

```
Captain (you in Matrix)
    │
    ├── "!restart cid" ──→ Supervisor (each machine) ──→ only HERACLES acts
    ├── "!operator check logs" ──→ Supervisor ──→ tmux session ──→ Claude Code
    │
Operator (Claude Code in tmux)
    │
    ├── intercom-send.sh bridge "@Johnny5 status?" ──→ Matrix ──→ Johnny5
    ├── inbox.md ──→ git push ──→ other machines' operators pick up
    │
Bot (inside container)
    │
    ├── send_message(text: "done") ──→ IPC ──→ host ──→ own room (bot's Matrix account)
    ├── send_message(text: "hey", recipient: "Cid") ──→ IPC ──→ intercom relay ──→ Engineering
```

## Key files

| File | Purpose |
|------|---------|
| `src/supervisor.ts` | Supervisor process — Matrix sync + command handling |
| `src/intercom-relay.ts` | Host-side intercom HTTP relay for cross-room messages |
| `src/ipc-watcher.ts` | IPC file watcher — routes messages, detects cross-room |
| `src/service.ts` | Bot lifecycle — deploy, start, stop, pm2 management |
| `operator/intercom.json` | Intercom account credentials (in secrets repo) |
| `operator/intercom-send.sh` | Shell script for operator→bot messaging |
| `operator/inbox.md` | Cross-machine coordination (in secrets repo) |
| `external/nanoclaw/container/agent-runner/src/ipc-mcp-stdio.ts` | Container-side `send_message` tool |
| `external/nanoclaw/container/agent-runner/src/bot-messaging.ts` | Bot directory lookup + recipient resolution |
