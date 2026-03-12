# 20 — Metrics

Metrics answer: **"How is the fleet doing?"** Every metric has a rolling time window or is explicitly labeled as a snapshot. A good metric tells you immediately whether the value is healthy or not.

## Time Windows

| Abbreviation | Meaning |
|---|---|
| **1d** | Rolling last 24 hours |
| **7d** | Rolling last 7 days |
| *(no suffix)* | Snapshot — point-in-time value, not averaged |

All rates are per-day. `3/day (1d)` = 3 events in the last 24 hours.

## !metrics Output Reference

`!metrics` shows a fleet tree matching `!fleet` structure, with metrics inline.

### Ship Line

```
{emoji}{pip} {name} · 🏅{rank} · {uptime} up · ↻{X/Y} · {sync-status}
```

| Field | Type | Meaning | Good | Bad |
|-------|------|---------|------|-----|
| pip | snapshot | ◉ commissioned, 💤 decommissioned, ⭐ speaker | ◉ or ⭐ | 💤 |
| uptime | snapshot | Time since relay last started | Days | Seconds (crash-looping) |
| ↻X/Y | rolling 1d/7d | Relay restarts per day | 0/0 | > 2/day |
| sync OK | rolling 1d | Zero sync or build failures today | sync OK | ⚠️N sync/day |

### Bot Line

```
  {├/└} {pip} {name} · {role} · 🏅{rank} · mem {rss}/{limit}MB · SK+{X} OOM+{Y} (1d)
```

| Field | Type | Meaning | Good | Bad |
|-------|------|---------|------|-----|
| pip | snapshot | ◉ process running, 💤 sleep, 🔴 process down, 🚀 transit | ◉ | 🔴 |
| mem X/YMB | snapshot | Current RSS memory / container limit. X is what the bot is using right now; Y is the hard cap. | X < 50% of Y | X > 80% of Y → OOM risk |
| SK+X (1d) | rolling 1d | Sigkills in last 24h — process was forcibly terminated (operator killed it, relay killed it, or it was restarted) | 0 | > 5/day |
| OOM+X (1d) | rolling 1d | Out-of-memory kills in last 24h — container hit its memory limit and was killed by the OS | 0 | Any OOM is bad |

### Fleet Footer

```
Fleet · {N} ships · avail {X}% · autonomy {X}% (1d) · OOM+{X} (24h) · {X}MB sessions
Operator · interventions {X}/day (1d) · x-cmds {X}/day (1d)
```

| Field | Type | Meaning | Good | Bad |
|-------|------|---------|------|-----|
| avail X% | rolling | % of **active** bots (non-sleep, non-transit) with running processes. 100% means every bot that *should* be running *is* running. | 100% | < 90% |
| autonomy X% (1d) | rolling 1d | Composite score: `100 − (interventions × 10) − (crashes × 5)`, clamped 0–100. Measures how self-sufficient the fleet was today. 100 = no operator intervention, no crashes. | 100% | < 70% |
| OOM+X (24h) | rolling 1d | Total OOM kills across all ships in last 24h | 0 | Any |
| X MB sessions | snapshot | Total Claude API session memory across all active bot sessions. A session is ~200K tokens × 4 bytes × compression; typical session = 1–5MB. **> 500MB per bot** suggests context bloat. | < 100MB | > 1000MB |
| interventions X/day | rolling 1d | `@operator` messages sent to any room except BehindTheCurtain. Each one means a bot couldn't handle something on its own. | 0 | > 2/day |
| x-cmds X/day | rolling 1d | X-commands issued by operator (not Captain). Lifecycle commands (`!wake`, `!sleep`, etc.) that operators shouldn't need to issue in a mature fleet. | 0 | > 5/day |

## Full Metric Definitions

### Operator Metrics

| Metric | Window | Source | Good | Bad |
|--------|--------|--------|------|-----|
| **Interventions** | rolling 1d/7d | `@operator` messages outside BehindTheCurtain | 0/day | > 2/day |
| **X-commands issued** | rolling 1d/7d | `!`-prefixed messages from `@operator` (not Captain) | 0/day | > 5/day |

Interventions are the primary autonomy signal. A day with zero interventions outside BehindTheCurtain means the fleet operated on its own.

### Ship Metrics

| Metric | Window | Source | Good | Bad |
|--------|--------|--------|------|-----|
| **Relay uptime** | snapshot | pm2 process start time | Days | < 1h (frequent restarts) |
| **Relay restarts** | rolling 1d/7d | pm2 `restart_time` (approx: counts all restarts if relay started within window) | 0/0 | > 2/day |
| **Sync failures** | rolling 1d/7d | Every call to `reportFailure('secrets sync', ...)`, `reportFailure('code sync', ...)`, `reportFailure('code build', ...)` | 0/0 | > 1/day |

Sync failures include: secrets repo pull failures, InfiniClaw git pull failures, and TypeScript build failures. Every `⚠️ code build down` alert counted.

### Bot Metrics

| Metric | Window | Source | Good | Bad |
|--------|--------|--------|------|-----|
| **Score** | rolling 1d/7d | Captain/operator reactions on bot messages: 👍+1, 👎−1, 💯+3, ❌−3. Per day. | Positive | Negative |
| **Crashes** | rolling 1d/7d | pm2 `restart_time` (same approximation as relay restarts) | 0/0 | > 3/day |
| **Branch brain success** | rolling 1d/7d | % of branch brain completions that posted output vs errored/timed out | 100% | < 80% |
| **Memory (RSS)** | snapshot | Cgroup RSS from health check — what the container is using right now | < 50% of limit | > 80% of limit |
| **Sigkills (1d)** | rolling 1d | Process SIGKILL events recorded in health check rolling window | 0 | > 5/day |
| **OOM kills (1d)** | rolling 1d | Out-of-memory kills recorded in health check rolling window | 0 | Any |

### Fleet Metrics

| Metric | Window | Source | Good | Bad |
|--------|--------|--------|------|-----|
| **Availability** | rolling (live) | `running bots / active bots × 100%`. Active = non-sleep, non-transit. | 100% | < 90% |
| **Autonomy score** | rolling 1d/7d | `100 − (interventions × 10) − (bot crashes × 5)`, clamped 0–100. | 100 | < 70 |
| **OOM kills** | rolling 1d | Sum of OOM kills across all ships from health reports | 0 | Any |
| **Session memory** | snapshot | Sum of `session_total_mb` from each ship's health report | < 500MB | > 2000MB |

## Data Sources and Freshness

| Source | Data | Updated |
|--------|------|---------|
| pm2 jlist | Process status, restarts, uptime | Per `!metrics` call (live) |
| Matrix history | Operator events, score reactions | Accumulated in memory; seeded from history on startup |
| S3 `metrics/{ship}.json` | Ship/bot/fleet/operator metrics | Published on each `!metrics` call |
| S3 `health/{ship}.json` | Memory, SK, OOM | Published on each `!metrics` or `!health` call |
| fleet.json | Bot statuses, roles, ranks | Synced every ~3 minutes via git |

Health data (mem, SK, OOM) may lag by up to the time since the last `!metrics` call on that ship.

## Metric Accuracy Notes

- **Restart approximation**: pm2 only tracks cumulative restarts, not per-event timestamps. Rolling restart counts use an approximation: if the process started within the window, all restarts are counted as in-window. If the process has been running longer than the window, restarts show as 0. This means a long-running relay with historic restarts shows 0 until it next restarts.
- **Sync failures**: Counted on every `reportFailure` call, including repeat alerts for the same ongoing failure. One build that fails 3× in a day = 3 events.
- **Session memory**: Reported by the NanoClaw runtime as cumulative bytes allocated across all tool calls in the current context window. Resets on each bot restart.

## Symbols Reference

| Symbol | Meaning |
|--------|---------|
| ◉ | Online / commissioned (fisheye pip) |
| 💤 | Offline / decommissioned / sleeping |
| ⭐ | Speaker ship (lowest-rank commissioned ship) |
| 🔴 | Process down (should be running but isn't) |
| 🚀 | In transit (moving between ships) |
| ↻X/Y | Relay restarts: X = last 24h, Y = last 7d average/day |
| SK | Sigkill — process forcibly terminated |
| OOM | Out-of-memory kill — container killed by OS |
| RSS | Resident Set Size — current physical memory in use |
| mem X/YMB | X = current RSS, Y = container memory limit |
