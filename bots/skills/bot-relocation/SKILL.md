---
name: bot-relocation
description: Move a bot from one machine to another. Use when the Captain asks to move a bot or when load balancing requires it.
---

# Transporter

Move a bot between machines in the fleet. A bot runs on exactly one machine at a time.

## How it works

Moving a bot requires coordination between engineers on the source and destination machines via Matrix. The flow has two sides:

### Sending a bot (you are on the source machine)

1. Stop the bot: write an IPC task `{"type":"restart_bot","bot":"<name>"}` or run `npm run cli stop` if stopping all bots
2. Push state to S3: `cd $INFINICLAW_ROOT && npm run cli sync push`
3. Remove the bot from this machine's `~/.config/infiniclaw/machine.json` `bots` array
4. Message the engineer on the destination machine via Matrix:
   ```
   @<engineer> transporter: receiving <botname>. State pushed to S3. Pull and start.
   ```
5. Restart remaining bots on this machine: `cd $INFINICLAW_ROOT && npm run cli start`

### Receiving a bot (you are on the destination machine)

1. Add the bot to this machine's `~/.config/infiniclaw/machine.json` `bots` array
2. Verify the bot's env file exists at the secrets path: `~/.config/infiniclaw/secrets/<bot>/env`
3. Verify the bot has an entry in `~/.config/infiniclaw/allow-list.json` (add if missing)
4. Verify the container image exists: `podman images nanoclaw-<bot>:latest` (build if missing: `cd $INFINICLAW_ROOT && ./bots/container/build.sh <bot>`)
5. Pull state from S3: `cd $INFINICLAW_ROOT && npm run cli sync pull`
6. Start: `cd $INFINICLAW_ROOT && npm run cli start`
7. Confirm to the sending engineer via Matrix:
   ```
   @<engineer> transporter: <botname> received and running.
   ```

## Prerequisites

- S3 sync must be configured in `machine.json` on both machines
- The bot's secrets (env file) must exist on the destination machine
- The bot's container image must be built on the destination machine
- The bot's allow-list entries must exist on the destination machine

## Safety

- **Never run the same bot on two machines simultaneously.** Always stop on source before starting on destination.
- Verify the bot is actually stopped before pushing state — check `podman ps --filter name=nanoclaw-<bot>`.
- If S3 sync fails, do not proceed. Fix the sync issue first.
