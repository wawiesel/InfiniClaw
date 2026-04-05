# InfiniClaw Beacon

`beacon/` is the in-repo implementation seed for the future `infiniclaw-beacon` repo.

The beacon is the first InfiniClaw presence planted on a system. Its job is to connect that system to the fleet and bring the first relay online there.

## Phase-1 Purpose

This package exists to satisfy the current design requirements around:

- system bootstrap
- registration in `OGIC/public/systems.json`
- local beacon state
- preparing the first relay bring-up

The beacon is not the normal room control surface. Once bootstrap is complete, `@relay` owns the normal control path.

## Current Scope

The current code supports:

- validating bootstrap input
- registering or updating a system record in `systems.json`
- optionally recording a Matrix `spaceId`
- writing local beacon state
- emitting the relay start command the beacon would run

The current code does **not** yet:

- clone repos from remote itself
- talk to Matrix directly
- start PM2 or Podman
- supervise relay lifecycle after bootstrap

Those are the next layers once the repo split is real.

## Bootstrap Shape

```bash
node dist/cli.js bootstrap \
  --fleet OGIC \
  --system-id poseidon \
  --name Poseidon \
  --emoji 🌊 \
  --hostname mac139160 \
  --public-dir /path/to/OGIC-public \
  --secrets-dir /path/to/OGIC-secrets \
  --state-dir /path/to/local-beacon-state \
  --relay-repo /path/to/infiniclaw-relay \
  --relay-version v2.0.0 \
  --apply
```

The command prints a structured result containing:

- the normalized system record
- the files written
- the relay start command
- the bootstrap steps
