# 10 — Fleet

The fleet is the aggregate of all ships and bots, coordinated via `fleet.json` as the single source of truth.

## Fleet Configuration

Fleet-wide bot availability is tracked in `fleet.json` and synced via git. The relay on each ship maintains an in-memory copy (`liveFleet`) as the runtime source of truth.

```json
{
  "s3": { "endpoint": "...", "bucket": "...", "accessKey": "...", "secretKey": "..." },
  "roles": {
    "engineer": { "rw": ["infiniclaw", "aegis"] },
    "navigator": { "rw": ["vault", "infiniclaw"] },
    "architect": { "rw": ["infiniclaw", "aegis"] }
  },
  "bots": {
    "cid": { "role": "engineer", "rank": 2, "ship": "HERACLES", "status": "onduty" }
  }
}
```

## Transport

`!transport <bot> <ship>` moves a bot between ships via a two-phase git protocol:

1. **Dematerialize** — source ship stops the bot, writes `ship: targetShip, status: "transit"` to fleet.json, and pushes.
2. **Materialize** — target ship's 30s secrets sync sees the inactive bot assigned to it, activates it, starts it, and pushes the updated state.

Transport uses git (not Matrix) because it must survive relay restarts and network blips. If the target ship's relay missed a Matrix message, the bot would be lost. The git protocol guarantees delivery.

## Fleet Command Protocol

`!fleet` uses a two-phase S3 protocol so the speaker can assemble data from all ships:

1. **Every ship** publishes its local fleet data to `fleet-report/<ship>.json` — relay version, per-bot status (including live process checks), names, and git versions.
2. **The speaker** polls S3 for up to 5s, waiting for all active ships to report. Reports older than 10s are ignored (stale from a previous invocation).
3. **Assembly**: The speaker merges all ship reports with its in-memory `liveFleet` as fallback for any ship that didn't report in time, then emits a single formatted response.

This guarantees exactly one reply per `!fleet` command, with live process data from every reachable ship.

## Verification

1. **fleet.json valid** — File parses, all bots have required fields (role, rank, ship, status).
   *Check:* Pre-commit hook validates rank integrity and required fields.

2. **Transport works** — `!transport cid poseidon` moves Cid to Poseidon.
   *Check:* Cid dematerializes on source ship (status → transit), materializes on target ship (status → onduty). fleet.json updated and pushed.

3. **Fleet command aggregates** — `!fleet` in any room.
   *Check:* Single response from speaker, includes data from all active ships.

4. **S3 coordination** — Health data uploaded on interval.
   *Check:* S3 bucket contains `relay/<ship>.json` and `fleet-report/<ship>.json`.
