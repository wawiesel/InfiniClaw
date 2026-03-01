# Rolling Uptime Task

## Objective
Captain wants 1-day and 7-day rolling uptime for the bot fleet, modeled after the MetricOfSadness tool.

## Reference: MetricOfSadness (`/Users/ww5/2026-MetricOfSadness/`)
- Python tool that monitors SSH connectivity and directory accessibility
- Uses SQLite databases (`ssh.db`, `dirs.db`) to store ping results
- Calculates rolling uptime with a "two consecutive down = confirmed downtime" rule
- Key function: `_uptime_pct_duration()` — clips downtime intervals to window boundaries
- `_get_rolling_uptime_now()` — computes rolling uptime ending at last ping (not midnight-aligned)
- Status bubbles: green (up+fast), yellow (up+slow or mixed), red (all down)
- Generates plots with 7-day and 1-day rolling uptime over last 100 days

## Implementation Plan for Fleet Uptime
1. **Data source**: Bot logs at `$INFINICLAW_ROOT/_runtime/logs/` — parse timestamps of errors, OOMs, restarts
2. **Define "up" vs "down"**: Bot is "down" during OOM restarts, crashes, or unresponsive periods
3. **Store pings**: Either use existing log data or add periodic health pings to SQLite
4. **Calculate rolling uptime**: Adapt MoS's `_uptime_pct_duration` approach
   - Two consecutive "down" checks = confirmed downtime
   - Clip intervals to window boundaries
5. **Report**: Add 1d/7d rolling uptime columns to the fleet health report
6. **check.sh already has**: uptime_hrs, errors_per_hr, ooms_per_hr, restarts_per_hr

## Key Design Decisions Needed
- What constitutes a "ping"? Use log timestamps? Or add active pings?
- How to detect "down" from logs (OOM events, restarts, gaps in log activity)?
- Where to store the uptime database?
- Should this be in check.sh (bash) or a separate Python script?

## Status
- Read and understood reference implementation
- NOT yet implemented — was saving context when session ended
