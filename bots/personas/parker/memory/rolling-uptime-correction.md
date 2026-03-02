# Rolling Uptime — Correction (2026-03-01)

## Captain's Direction
- **DO NOT** query scaledev/MetricOfSadness DBs. That was just a reference example for the algorithm.
- **Machines to track**: this machine (local/mac) and **heracles** (currently offline).
- Use the MetricOfSadness two-consecutive-downs algorithm for uptime calculation.

## What's Deployed
- `uptime.db` at `/workspace/extra/parker-persona/health/uptime.db` — records bot heartbeat pings every 5 min
- `rolling_uptime.py` at `/workspace/extra/parker-persona/health/rolling_uptime.py` — computes rolling uptime
- Scheduled task pings every 5 min (interval 300000ms)
- Health-check skill updated (but was reverted by external edit — skill file was reset to simpler version)

## TODO
- Remove scaledev from `rolling_uptime.py` machine section
- Add heracles machine tracking (need to determine how to check heracles liveness — SSH ping? heartbeat file?)
- Keep local machine tracking
- The health-check SKILL.md was reverted externally — my rolling uptime additions were removed. Need to re-add them properly.
- `check.sh` still has rolling_uptime integration intact

## Thread Rule
- ALWAYS respond in thread. Got chewed out for posting to main timeline. Use `set_thread` on startup.
