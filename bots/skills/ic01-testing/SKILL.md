---
name: ic01-testing
description: Deploy and test branches on the IC01 staging fleet. Use when Captain says to test on IC01, deploy a branch to test fleet, or validate a PR before merge.
---

# IC01 Test Fleet

IC01 is a parallel fleet running alongside production (IC00) for testing PRs and features. Same host, same Matrix homeserver, isolated by configuration.

## Quick Reference

| IC00 (production) | IC01 (test) |
|---|---|
| `/workspace/extra/InfiniClaw/` | `/workspace/extra/InfiniClaw01/` |
| `fleet.json` | `fleet01.json` |
| `intercom.json` | `intercom01.json` |
| `loudspeaker-matrix.json` | `loudspeaker01.json` |
| `infiniclaw-relay` (pm2) | `infiniclaw01-relay` (pm2) |
| Port 3001 | Port 3002 |
| `nanoclaw-` containers | `nanoclaw-ic01-` containers |
| Matrix rooms: 🌌 prefix | Matrix rooms: 🧪 prefix |

## Deploy a Branch to IC01

### 1. Clone or update IC01 source

```bash
# First time:
cd /workspace/extra && git clone --branch <branch> /workspace/extra/InfiniClaw InfiniClaw01

# Update existing:
cd /workspace/extra/InfiniClaw01 && git fetch origin && git checkout <branch> && git pull
```

### 2. Build

```bash
cd /workspace/extra/InfiniClaw01 && npm install --silent && npm run build
```

### 3. Start IC01 relay

The relay needs IC01 env vars. Create a pm2 ecosystem or set env vars:

```bash
INFINICLAW_ROOT=/workspace/extra/InfiniClaw01 \
INFINICLAW_FLEET=fleet01.json \
INFINICLAW_INTERCOM=intercom01.json \
INFINICLAW_LOUDSPEAKER=loudspeaker01.json \
INFINICLAW_PM2_NAME=infiniclaw01-relay \
INFINICLAW_PM2_PREFIX=infiniclaw01 \
CREDENTIAL_PROXY_PORT=3002 \
node /workspace/extra/InfiniClaw01/dist/relay.js
```

Or via pm2:
```bash
pm2 start /workspace/extra/InfiniClaw01/dist/relay.js \
  --name infiniclaw01-relay \
  --env INFINICLAW_ROOT=/workspace/extra/InfiniClaw01 \
  --env INFINICLAW_FLEET=fleet01.json \
  --env INFINICLAW_INTERCOM=intercom01.json \
  --env INFINICLAW_LOUDSPEAKER=loudspeaker01.json \
  --env INFINICLAW_PM2_NAME=infiniclaw01-relay \
  --env INFINICLAW_PM2_PREFIX=infiniclaw01 \
  --env CREDENTIAL_PROXY_PORT=3002
```

### 4. Verify

Check IC01 relay is running and connected to 🧪 Matrix rooms. Use `podman_exec` to check containers:
```
podman_exec: ["ps", "--filter", "name=nanoclaw-ic01"]
```

## Captain-Dependent Steps

These require browser/OAuth — do all prep first, give Captain exact commands:

- Create Matrix space `🧪 InfiniClaw01` with rooms (Engineering, Bridge, bot quarters)
- Create loudspeaker account → `loudspeaker01.json`
- Create intercom account → `intercom01.json`
- Add IC01 entry to `ships.json` with `fleet: "infiniclaw01"`
- Create `fleet01.json` with test bot entries

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
# Clean up containers:
podman_exec: ["ps", "--filter", "name=nanoclaw-ic01", "-q"]
# Then stop each
```

## Troubleshooting

- **Port 3002 EADDRINUSE**: Another IC01 relay is running. `pm2 stop infiniclaw01-relay` first.
- **No bot response**: Check `fleet01.json` has the test bot entry and `intercom01.json` exists.
- **Container not found**: Ensure `INFINICLAW_ROOT` points to IC01 dir, not IC00.

## Design Reference

Full spec: `docs/design/24-test-fleet.md`
