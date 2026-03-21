---
name: ic01-testing
description: Deploy and test branches on the IC01 staging fleet. Use when Captain says to test on IC01, deploy a branch to test fleet, or validate a PR before merge.
---

# IC01 Test Fleet

IC01 is a parallel fleet running alongside production (IC00) for testing PRs and features. Same host, same Matrix homeserver, same source directory — isolated only by env vars and config files.

## Quick Reference

| Component | IC00 (production) | IC01 (test) |
|---|---|---|
| Source dir | `/workspace/extra/InfiniClaw/` | Same (or separate clone for branch testing) |
| Fleet config | `fleet.json` | `fleet01.json` |
| Intercom config | `intercom.json` | `intercom01.json` |
| Loudspeaker config | `loudspeaker-matrix.json` | `loudspeaker01-matrix.json` |
| PM2 process | `infiniclaw-relay` | `infiniclaw01-relay` |
| PM2 bot prefix | `infiniclaw` | `infiniclaw01` |
| Matrix rooms | 🌌 prefix | 🧪 prefix |

Config files (`fleet01.json`, `intercom01.json`, `loudspeaker01-matrix.json`) already exist in the secrets repo.

## Start IC01 (same branch as production)

IC01 uses the **same** InfiniClaw directory as IC00. Only env vars differ:

```bash
INFINICLAW_FLEET=fleet01.json \
INFINICLAW_INTERCOM=intercom01.json \
INFINICLAW_LOUDSPEAKER=loudspeaker01-matrix.json \
INFINICLAW_PM2_NAME=infiniclaw01-relay \
INFINICLAW_PM2_PREFIX=infiniclaw01 \
node dist/relay.js
```

Or via pm2 (how it's currently managed):
```bash
pm2 start dist/relay.js \
  --name infiniclaw01-relay \
  --env INFINICLAW_FLEET=fleet01.json \
  --env INFINICLAW_INTERCOM=intercom01.json \
  --env INFINICLAW_LOUDSPEAKER=loudspeaker01-matrix.json \
  --env INFINICLAW_PM2_NAME=infiniclaw01-relay \
  --env INFINICLAW_PM2_PREFIX=infiniclaw01
```

**Future:** `!ic01 start` / `!ic01 stop` x-commands in the relay for self-serve (not yet implemented).

## Test a Different Branch on IC01

Only needed when IC01 must run code from a feature branch:

### 1. Clone to a separate directory

```bash
cd /workspace/extra && git clone --branch <branch> InfiniClaw InfiniClaw01
cd InfiniClaw01 && npm install --silent && npm run build
```

### 2. Start with INFINICLAW_ROOT override

```bash
INFINICLAW_ROOT=/workspace/extra/InfiniClaw01 \
INFINICLAW_FLEET=fleet01.json \
INFINICLAW_INTERCOM=intercom01.json \
INFINICLAW_LOUDSPEAKER=loudspeaker01-matrix.json \
INFINICLAW_PM2_NAME=infiniclaw01-relay \
INFINICLAW_PM2_PREFIX=infiniclaw01 \
node /workspace/extra/InfiniClaw01/dist/relay.js
```

### 3. Update existing clone

```bash
cd /workspace/extra/InfiniClaw01 && git fetch origin && git checkout <branch> && git pull
npm install --silent && npm run build
pm2 restart infiniclaw01-relay
```

## Verify

Check IC01 relay is running and connected to 🧪 Matrix rooms:
```
podman_exec: ["ps", "--filter", "name=nanoclaw-ic01"]
```

## Run Tests

Send messages in 🧪 Engineering to trigger bot behavior. Observe:
- Bot responds correctly
- Branch brains spawn and merge
- Thread lifecycle works
- Merge notices come from loudspeaker

## Teardown

```bash
pm2 stop infiniclaw01-relay
pm2 delete infiniclaw01-relay
# Clean up IC01 containers:
podman_exec: ["ps", "--filter", "name=nanoclaw-ic01", "-q"]
# Then stop each
```

## Captain-Dependent Steps (already done)

These required browser/OAuth and are already set up:
- Matrix space `🧪 InfiniClaw01` with rooms
- Loudspeaker account → `loudspeaker01-matrix.json`
- Intercom account → `intercom01.json`
- IC01 entry in `ships.json` with `fleet: "infiniclaw01"`
- `fleet01.json` with test bot entries

## Troubleshooting

- **Port conflict**: Another IC01 relay is running. `pm2 stop infiniclaw01-relay` first.
- **No bot response**: Check `fleet01.json` has the test bot entry and `intercom01.json` exists in secrets.
- **Container not found**: If testing a branch, ensure `INFINICLAW_ROOT` points to the clone dir.
- **Testbot crash loop**: Testbot belongs only in `fleet01.json`, not in IC00's `fleet.json`.

## Design Reference

Full spec: `docs/design/24-test-fleet.md`
