# Health Monitoring FAQ

## Overview

InfiniClaw has a fleet-wide health monitoring system that tracks container health, memory usage, OOM kills, restart patterns, and session storage across all machines. The relay process handles periodic collection, S3 storage, and the `!health` command.

## Architecture

```
┌─────────────┐     ┌─────────────┐
│  mac139160   │     │  HERACLES   │
│  relay  │     │  relay  │
│      │       │     │      │       │
│  health-     │     │  health-     │
│  check.sh    │     │  check.sh    │
│      │       │     │      │       │
│  ┌───▼───┐   │     │  ┌───▼───┐   │
│  │ JSON  │───┼──┐  │  │ JSON  │───┼──┐
│  └───────┘   │  │  │  └───────┘   │  │
└─────────────┘  │  └─────────────┘  │
                 ▼                    ▼
           ┌──────────────────────────┐
           │    S3 (MinIO)            │
           │  health/<machine>.json   │
           └──────────────────────────┘
                      │
                      ▼
               !health command
            (reads all reports,
             formats fleet summary)
```

## Components

| Component | Path | Purpose |
|-----------|------|---------|
| `health-check.sh` | `scripts/health-check.sh` | Collects health metrics from local bot logs |
| `fleet-health.sh` | `scripts/fleet-health.sh` | Aggregates reports from multiple machines (standalone) |
| Supervisor health loop | `src/relay.ts` | Periodic collection + S3 upload |
| `!health` command | `src/relay.ts` | On-demand fleet health summary |

## What Gets Measured

Per bot (from `_runtime/logs/<bot>.error.log`):

| Metric | Description |
|--------|-------------|
| `status` | ACTIVE (<5 min log age), RECENT (<60 min), or STALE |
| `rss_mb` | Resident set size in MB |
| `heap_mb` | V8 heap usage in MB |
| `limit_mb` | Container memory limit in MB |
| `mem_pct` | Memory usage as percentage of limit |
| `spawns` | Total container spawns |
| `sigkills` | Total SIGKILL events |
| `sigterms` | Total SIGTERM events |
| `oom_kills` | Confirmed OOM kills (`isOomKill: true`) |
| `errors` | Total ERROR-level log lines |

Per machine:

| Metric | Description |
|--------|-------------|
| `session_total_mb` | Total session storage across all bots |
| Per-bot session sizes | Instance directory sizes in MB |

## How It Works

### Periodic Collection (automatic)

The relay runs `health-check.sh --json` every **30 minutes** and uploads the result to S3 at `health/<machine>.json`. Each machine overwrites its own report — there is one latest snapshot per machine, no history versioning (yet).

- First run: 60 seconds after relay startup
- Interval: 30 minutes
- S3 key: `health/<hostname>.json`
- Fails silently if S3 is not configured

### `!health` Command (on-demand)

Type `!health` in any room. Every machine's relay:

1. Runs `health-check.sh --json` locally
2. Uploads result to S3
3. Fetches **all** machine reports from S3 (`health/*.json`)
4. Formats and replies with a fleet-wide summary

The response includes: active bots per machine, memory usage, OOM counts, session storage, and fleet totals.

### Git Sync (automatic)

The relay also runs `git fetch origin && git rebase origin/main` every **10 minutes**. If new commits are pulled, it auto-rebuilds (`npm run build`). On failure:

- **Rebase conflict**: alerts all rooms — engineer must fix immediately
- **Build failure**: alerts all rooms with error output

## health-check.sh Usage

```bash
# Human-readable output (default)
bash scripts/health-check.sh

# JSON output for machine consumption
MACHINE_NAME=mac139160 bash scripts/health-check.sh --json

# Pipe to file
MACHINE_NAME=mac139160 bash scripts/health-check.sh --json > report.json
```

The `MACHINE_NAME` env var sets the machine identifier in the report. Falls back to `hostname` if unset.

### JSON Output Format

```json
{
  "ts": "2026-03-05T15:34:20.128018+00:00",
  "machine": "mac139160",
  "bots": {
    "parker": {
      "status": "ACTIVE",
      "log_age_min": 2,
      "error_log_kb": 3275,
      "main_log_kb": 165,
      "rss_mb": 99,
      "heap_mb": 28,
      "limit_mb": 1536,
      "mem_pct": 6,
      "spawns": 453,
      "sigkills": 278,
      "sigterms": 29,
      "oom_kills": 22,
      "errors": 202,
      "last_ts": "11:53:33.338"
    }
  },
  "sessions": {
    "parker": 257.4
  },
  "session_total_mb": 3402.3
}
```

## fleet-health.sh Usage (standalone aggregation)

For manual aggregation without S3:

```bash
# Collect reports from each machine into a directory
mkdir -p reports/
scp mac139160:InfiniClaw/report.json reports/mac139160.json
scp heracles:InfiniClaw/report.json reports/heracles.json

# Aggregate
bash scripts/fleet-health.sh reports/

# Or just run local
bash scripts/fleet-health.sh --local
```

## S3 Storage

Health reports are stored in the same MinIO bucket as bot state (`infiniclaw`), under the `health/` prefix:

```
infiniclaw/
  health/
    mac139160.json    ← latest snapshot from mac139160
    HERACLES.json     ← latest snapshot from HERACLES
```

S3 configuration comes from `~/.config/infiniclaw/machine.json` (same `s3` section used for bot backups). If S3 is not configured, health checks still run but results are only logged locally.

## Important Notes

- **OOM detection**: Only counts `isOomKill: true` from logs. Exit 137 (SIGKILL) is NOT automatically OOM — many SIGKILLs are stale container cleanup during respawns.
- **Log-based metrics**: All counts are cumulative since last log rotation. Not rates — to get rates, compare snapshots over time.
- **Session storage**: Follows symlinks=false, skips broken links. Measures actual file sizes in instance directories.
- **No history yet**: Each S3 upload overwrites the previous. Historical tracking is a planned future feature.
