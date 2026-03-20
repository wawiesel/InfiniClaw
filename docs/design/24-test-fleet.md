# 23 — Test Fleet (InfiniClaw01)

## Overview

A parallel fleet running alongside production (InfiniClaw00) for testing PRs and features before they ship. Same system, same Matrix homeserver, same S3 bucket, same GitHub repo — isolated by configuration. IC01 runs its own relay process (`infiniclaw01-relay`) on the same system as IC00, allowing relay code changes to be tested without affecting production.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Matrix homeserver (a-gis.org)              │
│  ┌──────────────┐  ┌──────────────────────┐ │
│  │ 🌌 IC00      │  │ 🧪 IC01             │ │
│  │ Engineering  │  │ Engineering (test)   │ │
│  │ Bridge       │  │ Bridge (test)        │ │
│  │ Bot rooms    │  │ Bot rooms (test)     │ │
│  └──────────────┘  └──────────────────────┘ │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│  S3 (s3.a-gis.org/infiniclaw/)              │
│  ├── 00/  (production state)                │
│  └── 01/  (test state)                      │
└─────────────────────────────────────────────┘
```

## What Differs

| Component | IC00 (production) | IC01 (test) |
|---|---|---|
| Relay pm2 process | `infiniclaw-relay` | `infiniclaw01-relay` |
| `ships.json` → `fleet` | `infiniclaw00` | `infiniclaw01` |
| `ships.json` → `branch` | `main` | feature branch under test |
| Fleet state file | `fleet.json` | `fleet01.json` |
| S3 prefix | `fleet-state/infiniclaw00/` | `fleet-state/infiniclaw01/` |
| Loudspeaker account | `intercom.json` | `intercom01.json` |
| Matrix rooms | 🌌 prefixed | 🧪 prefixed |
| Credential proxy port | 3001 | 3002 |
| Container prefix | `nanoclaw-` | `nanoclaw-ic01-` |
| Instance dirs | `_runtime/instances/` | `_runtime/ic01/instances/` |
| Source dir | `/workspace/extra/InfiniClaw/` | `/workspace/extra/InfiniClaw01/` |

## Workflow

1. **Tali leaves Engineering** — removed from IC00 roster temporarily
2. **Becomes IC01 operator** — can observe all test rooms
3. **Deploys branch** — checks out PR branch, builds, starts test relay + bot(s)
4. **Tests feature** — exercises functionality, observes all rooms
5. **Records findings** — writes results in quarters
6. **Returns to Engineering** — reports pass/fail on IC00 main timeline

## Directory Layout (same host)

```
/workspace/extra/
├── InfiniClaw/           # IC00 source (production)
└── InfiniClaw01/         # IC01 source (cloned, checked out to test branch)
    ├── _runtime/
    │   ├── ic01/
    │   │   ├── instances/
    │   │   └── logs/
    │   └── data/
    └── .env              # INFINICLAW_ROOT, CREDENTIAL_PROXY_PORT=3002
```

## Captain-Dependent Steps

These require browser OAuth or macOS-only tools:

1. Create Matrix space `🧪 InfiniClaw01` with rooms (Engineering, Bridge, bot quarters)
2. Create loudspeaker account for IC01 → `intercom01.json`
3. Add IC01 entry to `ships.json` with `fleet: "infiniclaw01"`
4. Invite Captain to IC01 rooms

## Tali Self-Serve

Everything else:

- Clone repo, checkout test branch, build
- Configure env vars (`CREDENTIAL_PROXY_PORT=3002`, `INFINICLAW_ROOT`)
- Start test relay via pm2 (`infiniclaw01-relay`)
- Run tests, observe rooms, report findings
- Tear down when done

## Minimal Viable Test

For the signals PR test:

1. Captain creates one test Matrix room + loudspeaker account
2. Tali clones repo to `InfiniClaw01/`, checks out `tali/implement-signals`
3. Starts relay on port 3002 with one test bot
4. Sends messages with `{{m TestBot}}` and `{{send room="..."}}` syntax
5. Verifies signals are parsed, routed, and stripped correctly
6. Reports results to Engineering
