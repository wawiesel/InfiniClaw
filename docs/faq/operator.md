# Operator FAQ — Communication Architecture

## Overview

There are **4 layers** of communication, each serving a different purpose:

1. **Relay** — Matrix lifecycle commands (`!join`, `!dismiss`, `!rejoin`, `!refresh`, `!fleet`, `!transport`, etc.)
2. **Loudspeaker** — relay's reply voice in fleet rooms
3. **Operator account** — operator's direct Matrix presence (BehindTheCurtain + fleet rooms)
4. **Intercom** — write-only broadcast channels the relay polls for incoming commands

## 1. Relay

A Node.js process (`src/relay.ts`) that runs on **every ship** via pm2 as `infiniclaw-relay`. It long-polls Matrix `/sync` on all three room intercom accounts simultaneously. The relay runs at all times, even on decommissioned ships — decommissioning stops bots but keeps the relay listening.

### How it works

- Reads `intercom.json` from secrets — gets credentials for each room's intercom account
- Logs into Matrix as each intercom account, creates a sync filter (only `m.room.message` events)
- Does an initial sync to skip old messages, then enters a long-poll loop (`/sync?timeout=30000`)
- Each room runs its own `dialtone()` loop in parallel with exponential backoff on errors
- Also connects as `@loudspeaker` (for replies) and `@operator` (for BehindTheCurtain)

### Bot Commands

| Command | Action |
|---------|--------|
| `!wake [bot]` | Start container in quarters (full brain) |
| `!sleep [bot]` | Stop container, leave all rooms except quarters |
| `!report [bot]` | Send awake bot(s) to duty room |
| `!dismiss [bot]` | Back to quarters (bot keeps running), update fleet.json |
| `!rejoin [bot]` | Dismiss + report (full lifecycle reset) |
| `!refresh [bot]` | Rebuild + restart (pick up new code, no brain/room changes) |
| `!transport <bot> <ship>` | Beam bot to another ship |
| `!promote <target>` / `!demote <target>` | Swap rank (bot within role, or ship) |
| `!allow <bot> <path> [min]` / `!deny <bot> <path>` | Mount grants |

### Ship Commands

| Command | Action |
|---------|--------|
| `!commission [ship]` / `!decommission [ship]` | Ship lifecycle (no arg = all) |
| `!pull [ship]` | Full overhaul: pull repos, rebuild, restart bots |

### Fleet Commands

| Command | Action |
|---------|--------|
| `!fleet` / `!fleet room` | Fleet status — each ship reports local bots |
| `!health` | Fleet health summary via S3 (speaker replies) |
| `!operator [on\|off] [ship]` | Show or toggle operator relay on ship(s) |

### Multi-ship fan-out

Every `!` command is broadcast to all ships. When you say `!rejoin cid` in Engineering, every ship's relay sees it. Each checks if `cid` is local (via fleet.json). Only the owning ship acts — the rest silently ignore.

### Speaker election

Ships are ranked in `ships.json`. The lowest-rank active ship is the "speaker" for aggregate commands like `!health`. This avoids duplicate replies.

### Authorization

The Captain (`CAPTAIN_USER_ID` from `secrets/captain`) and intercom accounts (`/-intercom:/` sender pattern) can issue `!` commands. Operators issue commands via `bash operator/send`, which posts through intercom — so operator commands are inherently authorized.

### Replies

Relay replies via `@loudspeaker`, prefixed with `[HOSTNAME]`. Bots should have loudspeaker in `IGNORE_SENDERS` so they don't react to command output.

## 2. Loudspeaker

`@loudspeaker` is the relay's outbound voice. All `!` command responses go through this account. Credentials in `secrets/operator/loudspeaker-matrix.json`.

- Joined to all fleet rooms
- Prefixes every reply with `[SHIPNAME]` so origin is always clear
- Bots should ignore it (add to `IGNORE_SENDERS` in env)

## 3. Operator account

`@operator` is the operator's direct Matrix identity. Credentials in `secrets/operator/operator-matrix.json`.

- Used for BehindTheCurtain (private Captain↔operator channel)
- Can be used to address bots directly in fleet rooms
- Messages from operator arrive in tmux prefixed with room name and ID
- Operator replies back to Matrix via `bash operator/reply "<text>"`

### BehindTheCurtain

The private room between Captain and operator. Captain messages arrive in tmux as:
```
[BehindTheCurtain | !<roomId>] <message>
```
`!` commands sent there execute automatically. Conversational responses require `bash operator/reply`.

## 4. Intercom

Intercom accounts are **write-only broadcast channels** — not user identities. The relay polls them for incoming commands.

### a) Operator → fleet (commands)

```bash
bash operator/send <room> "!<command>"
bash operator/send <room> "@<bot> <message>"
```

### b) Bot → Bot cross-room (CO only)

Bots can `send_message()` with a recipient in another room. The host routes it through the intercom relay.

## Key files

| File | Purpose |
|------|---------|
| `src/relay.ts` | Relay process — Matrix sync + command handling |
| `src/intercom-relay.ts` | Host-side intercom HTTP relay for cross-room messages |
| `src/ipc-watcher.ts` | IPC file watcher — routes messages, detects cross-room |
| `src/ipc-commands.ts` | IPC command handlers (restart, health, fleet, etc.) |
| `src/service.ts` | Bot lifecycle — deploy, start, stop, pm2 management |
| `operator/intercom.json` | Intercom account credentials (in secrets repo) |
| `operator/loudspeaker-matrix.json` | Loudspeaker credentials (in secrets repo) |
| `operator/operator-matrix.json` | Operator account credentials (in secrets repo) |
| `operator/send` | Shell script for operator→fleet messaging |
