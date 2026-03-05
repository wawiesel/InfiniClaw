#!/bin/bash
# Fleet health check script — run from inside a bot container
# Outputs JSON with all health metrics for this machine
# Usage: bash /workspace/persona/skills/fleet-inspection/scripts/check.sh

RUNTIME="/workspace/extra/InfiniClaw/_runtime"
LOGS_DIR="$RUNTIME/logs"
HEALTH_DIR="/workspace/persona/health"

mkdir -p "$HEALTH_DIR"

# ── Memory (cgroup) ──────────────────────────────────────────────────
mem_current=0
mem_limit=0
mem_pct=0
if [ -f /sys/fs/cgroup/memory.current ]; then
  mem_current=$(cat /sys/fs/cgroup/memory.current)
  mem_limit=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo 0)
  if [ "$mem_limit" != "max" ] && [ "$mem_limit" -gt 0 ] 2>/dev/null; then
    mem_pct=$((mem_current * 100 / mem_limit))
  fi
fi
mem_current_mb=$((mem_current / 1024 / 1024))
if [ "$mem_limit" != "max" ] && [ "$mem_limit" -gt 0 ] 2>/dev/null; then
  mem_limit_mb=$((mem_limit / 1024 / 1024))
else
  mem_limit_mb=0
fi

# ── OOM events from cgroup ──────────────────────────────────────────
oom_count=0
if [ -f /sys/fs/cgroup/memory.events ]; then
  oom_count=$(grep 'oom_kill' /sys/fs/cgroup/memory.events 2>/dev/null | awk '{print $2}' || echo 0)
  [ -z "$oom_count" ] && oom_count=0
fi

# ── Per-bot log stats with rates ─────────────────────────────────────
now_epoch=$(date +%s)
bot_json=""
for bot in cid johnny5 albert parker; do
  log="$LOGS_DIR/$bot.log"
  errlog="$LOGS_DIR/$bot.error.log"

  # Uptime: use earliest log file birth time as start of tracking period
  log_start=0
  for f in "$log" "$errlog"; do
    if [ -f "$f" ]; then
      birth=$(stat --format='%W' "$f" 2>/dev/null || echo 0)
      # %W returns 0 if birth time unavailable, fall back to ctime
      [ "$birth" = "0" ] && birth=$(stat --format='%Z' "$f" 2>/dev/null || echo 0)
      if [ "$birth" -gt 0 ] 2>/dev/null; then
        if [ "$log_start" = "0" ] || [ "$birth" -lt "$log_start" ]; then
          log_start=$birth
        fi
      fi
    fi
  done
  uptime_hours=0
  if [ "$log_start" -gt 0 ] 2>/dev/null; then
    uptime_secs=$((now_epoch - log_start))
    [ "$uptime_secs" -lt 1 ] && uptime_secs=1
    # Integer hours (x10 for 1 decimal place precision)
    uptime_hours_x10=$((uptime_secs * 10 / 3600))
    [ "$uptime_hours_x10" -lt 1 ] && uptime_hours_x10=1
  else
    uptime_hours_x10=10  # default 1 hour to avoid div by zero
  fi

  restarts=0
  if [ -f "$log" ]; then
    restarts=$(grep -c 'shutting down\|Bot starting\|Process spawned' "$log" 2>/dev/null || true)
    [ -z "$restarts" ] && restarts=0
  fi

  errors=0
  if [ -f "$errlog" ]; then
    errors=$(grep -c 'ERROR\|error' "$errlog" 2>/dev/null || true)
    [ -z "$errors" ] && errors=0
  fi

  ooms=0
  for f in "$log" "$errlog"; do
    if [ -f "$f" ]; then
      # Only match actual OOM events, not casual mentions of "room" etc.
      c=$(grep -ci 'Heap limit exceeded\|OOM killed\|out of memory' "$f" 2>/dev/null || true)
      [ -n "$c" ] && ooms=$((ooms + c))
    fi
  done

  # Compute rates per hour (1 decimal place via x10 math)
  errors_per_hr_x10=$((errors * 10 * 10 / uptime_hours_x10))
  ooms_per_hr_x10=$((ooms * 10 * 10 / uptime_hours_x10))
  restarts_per_hr_x10=$((restarts * 10 * 10 / uptime_hours_x10))

  # Format as decimal strings (e.g. 125 -> "12.5")
  errors_per_hr="$((errors_per_hr_x10 / 10)).$((errors_per_hr_x10 % 10))"
  ooms_per_hr="$((ooms_per_hr_x10 / 10)).$((ooms_per_hr_x10 % 10))"
  restarts_per_hr="$((restarts_per_hr_x10 / 10)).$((restarts_per_hr_x10 % 10))"
  uptime_hrs="$((uptime_hours_x10 / 10)).$((uptime_hours_x10 % 10))"

  [ -n "$bot_json" ] && bot_json="$bot_json,"
  bot_json="$bot_json
    \"$bot\": { \"restarts\": $restarts, \"errors\": $errors, \"ooms\": $ooms, \"uptime_hrs\": $uptime_hrs, \"errors_per_hr\": $errors_per_hr, \"ooms_per_hr\": $ooms_per_hr, \"restarts_per_hr\": $restarts_per_hr }"
done

# ── MCP proxy health ────────────────────────────────────────────────
wksm_status="down"
wksm_sessions=0
wksm_resp=$(curl -s --max-time 3 http://host.containers.internal:8765/health 2>/dev/null || echo "")
if echo "$wksm_resp" | grep -q '"ok"'; then
  wksm_status="ok"
  wksm_sessions=$(echo "$wksm_resp" | grep -oP '"sessions":\s*\K\d+' 2>/dev/null || echo 0)
fi

gworkspace_status="down"
gworkspace_resp=$(curl -s --max-time 3 http://host.containers.internal:8767/mcp 2>/dev/null || echo "")
if [ -n "$gworkspace_resp" ]; then
  gworkspace_status="ok"
fi

# ── Session file sizes ──────────────────────────────────────────────
sessions_dir="/workspace/extra/InfiniClaw/_runtime/data/sessions"
session_total_mb=0
if [ -d "$sessions_dir" ]; then
  session_total_mb=$(du -sm "$sessions_dir" 2>/dev/null | cut -f1 || echo 0)
fi

my_session_mb=0
my_session_dir="/home/node/.claude/projects/-workspace-group"
if [ -d "$my_session_dir" ]; then
  my_session_mb=$(du -sm "$my_session_dir" 2>/dev/null | cut -f1 || echo 0)
fi

# ── Rolling uptime (bots + machines) ─────────────────────────────────
# Pings heartbeats and records to uptime.db, then queries rolling uptime
uptime_json=$(python3 /workspace/persona/health/rolling_uptime.py --ping 2>/dev/null || echo "{}")

# ── Output JSON ──────────────────────────────────────────────────────
timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat << ENDJSON
{
  "timestamp": "$timestamp",
  "memory": {
    "current_mb": $mem_current_mb,
    "limit_mb": $mem_limit_mb,
    "percent": $mem_pct,
    "oom_kills": $oom_count
  },
  "bots": {$bot_json
  },
  "mcp": {
    "wksm": { "status": "$wksm_status", "sessions": $wksm_sessions },
    "google_workspace": { "status": "$gworkspace_status" }
  },
  "sessions": {
    "total_mb": $session_total_mb,
    "parker_mb": $my_session_mb
  },
  "rolling_uptime": $uptime_json
}
ENDJSON
