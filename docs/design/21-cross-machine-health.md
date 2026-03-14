# 21 — Cross-Machine Health Protocol

> **Status:** Implemented (2026-03-14, `feat/wbs-relay` branch). All 6 steps complete: 5-min beacon flush, `HealthReport` extended fields (`relay_uptime_s`, `secrets_sync`, `git_sync`), `classifyBeaconAge()` (LIVE/STALE/OFFLINE), `fetchAllHealthReports()` fleet aggregation, `beaconFlushLoop()` with `fleet-health.json` cache, and `check_health(scope=fleet)` in agent-runner.
> **Motivation:** A secrets sync failure on one machine (NAS, 2026-03-14) went undetected because `check_health` only shows local containers and the health loop uploads to S3 every 30 minutes — too slow for failure detection.

---

## Problem

The fleet runs bots across multiple machines (e.g., mac139160, NAS). Current health tooling is machine-scoped:

| Gap | Impact |
|-----|--------|
| `check_health` MCP reads local `status.json` only | Bots have no visibility into peer machines |
| Health S3 upload interval: 30 min | Machine failure visible only after ≥30 min lag |
| No secrets/git sync status in health report | Sync failures cause silent degradation |
| No staleness detection | Stale S3 reports treated as current |
| No alerting on machine failure | Operator intervention required to notice |

---

## Design

### A. Health Beacon — Faster, Richer Reporting

Each relay publishes a **beacon** to S3 every **5 minutes** (down from 30 min) at:

```
health/{shipName}.json
```

The beacon adds three new fields to the existing `HealthReport`:

```typescript
interface HealthReport {
  // existing
  ts: string;
  machine: string;
  bots: Record<string, BotHealthEntry>;
  tokens: Record<string, TokenUsage>;
  sessions: Record<string, number>;
  session_total_mb: number;
  rolling: Record<string, unknown>;

  // NEW
  relay_uptime_s: number;          // seconds since relay process started
  secrets_sync: SyncStatus;        // last secrets pull result
  git_sync: SyncStatus;            // last git pull result
}

interface SyncStatus {
  status: 'ok' | 'err' | 'unknown';
  last_ok_ts: string | null;       // ISO timestamp of last success
  last_err_ts: string | null;      // ISO timestamp of last failure
  last_err_msg: string | null;     // error message (truncated to 200 chars)
}
```

The relay already tracks sync failures via `reportFailure()` — wire that into the beacon.

**Interval split:** Keep the 30-min full health collection (log parsing, session walks) on its current timer. Add a separate 5-min **beacon flush** that re-uploads the last collected `HealthReport` enriched with real-time `relay_uptime_s`, `secrets_sync`, and `git_sync`.

### B. Staleness Detection

When reading S3 health reports, classify each machine:

| `beacon.ts` age | Machine status |
|-----------------|----------------|
| < 10 min        | `LIVE` |
| 10–20 min       | `STALE` — likely slow upload or minor disruption |
| > 20 min        | `OFFLINE` — machine is down or S3 unreachable |

Similarly for sync statuses:

| `last_ok_ts` age | Sync status |
|------------------|-------------|
| < 30 min         | `ok` |
| 30 min – 2h      | `stale` |
| > 2h             | `degraded` |

### C. Fleet Health Aggregation — Pull Model

No central aggregator process. Instead:

1. Each relay writes its own beacon (push).
2. Any bot or operator can query fleet health by reading all `health/*.json` from S3 (pull).

This matches the existing `!fleet` two-phase pattern and the existing `fetchAllHealthReports()` implementation.

**Aggregated view includes:**
```
Fleet Health — 2026-03-14T09:32:00Z
  HERACLES  LIVE   relay↑14h  secrets OK  git OK  · cid ACTIVE  parker ACTIVE
  POSEIDON  STALE  relay↑2m   secrets ERR (2h ago: "connection refused")  · nora RECENT
```

### D. `check_health` MCP Tool Upgrade

Extend the existing `check_health` tool to accept an optional `scope` parameter:

```typescript
server.tool(
  'check_health',
  'Check health. scope="local" (default): reads local status.json. scope="fleet": fetches all machines from S3.',
  { scope: z.enum(['local', 'fleet']).optional().default('local') },
  async ({ scope }) => { ... }
)
```

- `local` (default) — existing behavior, reads `status.json`
- `fleet` — fetches all `health/*.json` from S3, applies staleness classification, returns structured JSON with per-machine summary

The fleet response format:

```json
{
  "as_of": "2026-03-14T09:32:00Z",
  "machines": {
    "HERACLES": {
      "status": "LIVE",
      "relay_uptime_s": 50400,
      "secrets_sync": { "status": "ok", "last_ok_ts": "..." },
      "git_sync": { "status": "ok", "last_ok_ts": "..." },
      "bots": { "cid": { "status": "ACTIVE", ... } }
    },
    "POSEIDON": {
      "status": "STALE",
      "beacon_age_min": 17,
      "secrets_sync": { "status": "err", "last_err_msg": "connection refused", ... },
      ...
    }
  },
  "offline_machines": ["NAS"],
  "alerts": [
    "POSEIDON: secrets_sync degraded for 2h",
    "NAS: OFFLINE — no beacon in 45 min"
  ]
}
```

### E. Alerting

The relay posts a Matrix alert to the operator room when machine health transitions:

| Event | Trigger | Alert |
|-------|---------|-------|
| Machine goes OFFLINE | No beacon for 20 min | `⚠️ POSEIDON OFFLINE — no health beacon for 20min` |
| Machine returns | Beacon seen after OFFLINE | `✅ POSEIDON back LIVE` |
| Secrets sync degraded | `last_ok_ts` > 2h | `⚠️ HERACLES secrets sync degraded (last OK: 2h ago)` |
| Secrets sync recovered | Status back to ok | `✅ HERACLES secrets sync recovered` |

**Implementation:** After each beacon flush in the relay, compare current machine statuses against the previous check. Post alerts only on state transitions (not every check) to prevent spam.

State is kept in memory (`Map<ship, MachineHealthStatus>`). On relay restart, treat all machines as unknown — alert only after first two consecutive checks confirm the new state.

---

## Implementation Plan

| Step | Component | Change |
|------|-----------|--------|
| 1 | Health module (`HealthReport` interface) | Add `relay_uptime_s`, `secrets_sync`, `git_sync` fields |
| 2 | Relay health loop | Track sync status via existing failure-reporting path; populate new fields |
| 3 | Relay health loop | Add 5-min beacon flush alongside 30-min full health collection |
| 4 | Fleet health reader | Add staleness classification when reading S3 reports |
| 5 | Relay alert loop | Check for machine status transitions, post Matrix alerts on change |
| 6 | `check_health` MCP tool (agent-runner) | Add optional `scope` param; add fleet fetch and aggregation logic |

---

## Non-Goals

- Central aggregator process (adds complexity, single point of failure)
- Push-based alerting to bots (bots can pull fleet status on demand)
- Historical fleet health trends (per-machine rolling is sufficient for now)
- Sub-minute beacon frequency (5 min is fine; S3 is not a real-time bus)

---

## Verification

1. **Beacon frequency** — S3 `health/*.json` objects update every 5 min.
   *Check:* `aws s3 ls s3://bucket/health/` shows recent modification times.

2. **Sync status captured** — Simulate a git pull failure; verify `git_sync.status=err` appears in next beacon.
   *Check:* Block git pull, wait 5 min, read S3 beacon.

3. **Staleness detection** — Stop one relay; after 20 min other ships classify it OFFLINE.
   *Check:* `check_health` with `scope=fleet` shows machine as OFFLINE with correct `beacon_age_min`.

4. **Alert on transition** — Machine goes OFFLINE; operator room receives alert.
   *Check:* Alert posted once (not every 5 min).

5. **Recovery alert** — Machine comes back LIVE; recovery message posted.
   *Check:* `✅` message appears in operator room.

6. **Bot visibility** — From inside a container, call `check_health` with `scope=fleet`.
   *Check:* Returns structured JSON with all machines, including ones on other physical hosts.
