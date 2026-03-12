# 20 — Metrics

All metrics use rolling time windows. Cumulative totals are not displayed — without a time frame, a number has no meaning. A metric with no rolling activity shows `0 (1d)` — that is informative. `185 (total)` is not.

All windows are:
- **1d** — last 24 hours (current behavior, is it trending up or down today?)
- **7d** — last 7 days (baseline trend — is the fleet getting better or worse?)

The 1d number answers "how is today going?" The 7d answers "is this a new problem or an ongoing one?"

## Operator Metrics

These measure how much human effort the fleet requires. A mature fleet approaches zero.

| Metric | Formula | Target | Alarm |
|--------|---------|--------|-------|
| **Interventions** | `@operator` messages sent outside BehindTheCurtain (per day) | 0 | > 3/day |
| **X-commands issued** | `!`-commands sent by operators (per day) | Decreasing | — |

**Interventions** is the single most important metric in the system. Every intervention is evidence that a bot failed to handle something autonomously. Target is zero. An intervention-free day means the fleet ran itself.

X-commands (like `!metrics`, `!fleet`, `!wake`) are management queries and maintenance, not emergency responses. They are tracked but not penalized.

## Bot Metrics

Measured per bot, rolled up to ship level.

| Metric | Formula | Good | Alarm |
|--------|---------|------|-------|
| **Score** | Net reaction points from Captain (👍=+1, 💯=+3, 👎=-1, ❌=-3) per day | > 0 | < −2/day |
| **Crashes** | PM2 restart count per day | 0 | > 2/day |
| **Branch brain success** | % of branch brain sessions that produced a merged result | > 80% | < 50% |
| **OOM kills** | Container memory-limit evictions per day | 0 | > 1/day |
| **SIGKILL** | Forced process kills per day (container/PM2 stop) | 0 | > 0 |
| **RSS / limit** | Current resident memory vs container memory limit | < 80% | > 90% |
| **Session data** | Total JSONL conversation data size for this bot | < 200MB | > 500MB |

**OOM kills** happen when a container hits its memory limit. Each kill terminates the bot mid-thought. Zero is the target. If a bot OOMs repeatedly, increase its memory limit or reduce its context load.

**SIGKILL** is a forced process termination — not a graceful stop. Zero is the target. SIGKILLs that aren't operator-initiated suggest a container is being killed externally (OOM at the host level, podman issue, or a bot requesting self-restart).

**RSS / limit** is a snapshot of current memory usage. It is not rolling — it reflects right now. If a bot is at > 80% of its limit, it is at risk of an OOM kill on the next large context operation.

**Session data** is the total size of all JSONL conversation files for this bot. A typical active bot generates 20–100MB per day. 5GB across a 4-bot fleet over several months is normal. The metric is useful for spotting runaway log growth or an unusually active bot, not as a daily health signal.

## Ship Metrics

Measured per ship (relay process + infrastructure).

| Metric | Formula | Good | Alarm |
|--------|---------|------|-------|
| **Relay uptime** | Time since relay last started | > 24h | < 1h |
| **Relay restarts** | PM2 restart count per day (1d / 7d) | 0 | > 3/day |
| **Sync failures** | Failed git sync or build steps per day | 0 | > 2/day |

**Relay restarts** happen when the relay PM2 process crashes and PM2 restarts it automatically, or when `!pull` restarts it after a build. Git-sync-triggered restarts (via `!pull`) are expected — a relay restart count of 2–5/day on an active ship is normal during active development. Counts > 10/day suggest a recurring crash.

**Sync failures** cover both git pull failures and TypeScript build failures. Each failed sync means the ship may be running stale code. Zero is the target; 1–2/day during a period of bad commits is tolerable. Persistent failures indicate an environment problem (network, node_modules, disk space).

## Fleet Metrics

Aggregated across all ships and bots.

| Metric | Formula | Good | Alarm |
|--------|---------|------|-------|
| **Availability** | % of assigned (non-sleeping) bots whose PM2 process is currently running | 100% | < 90% |
| **Autonomy score** | 100 − (interventions × 10) − (bot crashes × 5), clamped 0–100 | 100 | < 50 |

**Availability** answers "how many bots are working right now?" An assigned bot that is not running is a problem. Sleeping bots are excluded — they are intentionally offline. A bot in `onduty` or `quarters` status with no running process is a dead bot.

**Autonomy score** is a composite penalty:
- Each intervention costs 10 points (heavy — every intervention is a failure of autonomy)
- Each bot crash costs 5 points (medium — crashes are infrastructure failures, not necessarily operator failures)

A score of 100 means the fleet ran without operator intervention and without crashes. A score of 80 means 2 crashes occurred (normal during active development). A score of 50 means 5 interventions or 10 crashes — investigate. A score below 20 means the fleet is in crisis.

**Caveat:** During intensive operator sessions (setup, debugging, feature work), the autonomy score will be low because every operator message is counted as an intervention. This is expected during development. The 7d window smooths over burst operator activity.

## Infrastructure Events

These feed the **sync failures** metric. Every event is recorded with a timestamp so the 1d/7d rolling counts are accurate.

| Event | Trigger |
|-------|---------|
| `git-sync` failure | Git pull returned non-zero or threw an exception |
| `build` failure | TypeScript compilation (`npm run build`) failed |
| `relay-restart` | Relay PM2 process crashed (not an operator-triggered `!pull`) |

Build failures and sync failures are consolidated into a single `infraFailures` metric so the Captain sees the total infrastructure health of each ship in one number. The raw event types are available in error logs.

## Health Check

The health check runs on every ship when `!metrics` or `!health` is issued. It collects:
- Per-bot: status, RSS, memory limit, rolling OOM/SIGKILL counts
- Ship: session data totals

Health data is uploaded to S3 and aggregated by the speaker ship. The age of each ship's health report is shown ("live" if < 2 minutes, otherwise "Xm ago"). A stale report (> 30 minutes) indicates the ship missed the health upload — the ship may be down or its relay may have crashed.

## Displaying Metrics

### What each field tells you at a glance

```
🦁◉ Herc · 🏅1 · 2.1h up · ↻2 (1d) 5 (7d) · sync OK
  ├ ⭐ Cid   · 🎨 Artist · 🏅1 · RSS 120/512MB · 1d: SK+0 OOM+0
  └ ◉ Norm  · 💬 Normie · 🏅2 · RSS 98/512MB  · 1d: SK+0 OOM+0
```

- `↻2 (1d) 5 (7d)` — relay restarted twice today, five times over the last week
- `RSS 120/512MB` — Cid is using 120MB of its 512MB container limit right now (23%)
- `1d: SK+0 OOM+0` — no kills today; Cid has not been forcibly terminated

```
Fleet · 2 ships · availability 100% · autonomy 85% (1d) · OOM+0 (24h)
Operator · interventions 0/day (1d) · x-cmds 2/day (1d)
```

- `availability 100%` — all assigned bots are running
- `autonomy 85% (1d)` — 1 crash today (100 − 5×3) or 1–2 interventions
- `OOM+0 (24h)` — no memory kills across the fleet in the last 24h
- `interventions 0/day` — no operator interventions today (good)
- `x-cmds 2/day` — two management commands today (normal)

## Alerting

> **Status:** Designed, not yet implemented. Thresholds above are guidance for operator review, not automated alerts.

The intended alert pipeline: relay detects threshold breach → loudspeaker posts to Engineering → operator reviews.

Priority order (highest first):
1. Availability < 90% (bots are down)
2. OOM kills > 1/day for any bot (memory pressure)
3. Sync failures > 2/day (infrastructure degraded)
4. Autonomy < 50 (1d) (fleet requires heavy intervention)
5. Bot crashes > 2/day (instability)
6. RSS > 90% of limit (OOM imminent)
