#!/usr/bin/env bash
# Appends current health snapshot to a JSONL history file.
# Usage: health-history.sh [--report [hours]]
#   No args: append current snapshot to history
#   --report [N]: show summary of last N hours (default 24)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HISTORY_FILE="$ROOT_DIR/_runtime/data/health-history.jsonl"
MACHINE_NAME="${MACHINE_NAME:-$(hostname)}"

mkdir -p "$(dirname "$HISTORY_FILE")"

if [[ "${1:-}" == "--report" ]]; then
  HOURS="${2:-24}"
  python3 - "$HISTORY_FILE" "$HOURS" <<'PY'
import json, sys, os
from datetime import datetime, timezone, timedelta

history_file = sys.argv[1]
hours = int(sys.argv[2])
cutoff = datetime.now(tz=timezone.utc) - timedelta(hours=hours)

if not os.path.exists(history_file):
    print(f"No history file at {history_file}")
    sys.exit(0)

snapshots = []
with open(history_file, 'r') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            snap = json.loads(line)
            ts = datetime.fromisoformat(snap["ts"])
            if ts >= cutoff:
                snapshots.append(snap)
        except (json.JSONDecodeError, KeyError):
            continue

if not snapshots:
    print(f"No snapshots in last {hours}h")
    sys.exit(0)

print(f"Health History — last {hours}h ({len(snapshots)} snapshots)")
print(f"Machine: {snapshots[0].get('machine', '?')}")
print(f"Period: {snapshots[0]['ts'][:19]} → {snapshots[-1]['ts'][:19]}")
print()

# Aggregate per-bot stats across snapshots
bot_stats = {}
for snap in snapshots:
    for bot, data in snap.get("bots", {}).items():
        if "error" in data:
            continue
        if bot not in bot_stats:
            bot_stats[bot] = {
                "active_count": 0, "total_count": 0,
                "max_rss": 0, "min_rss": 999999,
                "oom_first": data.get("oom_kills", 0),
                "oom_last": data.get("oom_kills", 0),
                "sigkills_first": data.get("sigkills", 0),
                "sigkills_last": data.get("sigkills", 0),
                "errors_first": data.get("errors", 0),
                "errors_last": data.get("errors", 0),
            }
        s = bot_stats[bot]
        s["total_count"] += 1
        if data.get("status") == "ACTIVE":
            s["active_count"] += 1
        rss = data.get("rss_mb")
        if rss is not None:
            s["max_rss"] = max(s["max_rss"], rss)
            s["min_rss"] = min(s["min_rss"], rss)
        s["oom_last"] = data.get("oom_kills", 0)
        s["sigkills_last"] = data.get("sigkills", 0)
        s["errors_last"] = data.get("errors", 0)

for bot, s in sorted(bot_stats.items()):
    uptime_pct = (s["active_count"] / s["total_count"] * 100) if s["total_count"] > 0 else 0
    new_ooms = s["oom_last"] - s["oom_first"]
    new_kills = s["sigkills_last"] - s["sigkills_first"]
    new_errors = s["errors_last"] - s["errors_first"]
    rss_range = f"{s['min_rss']}-{s['max_rss']}MB" if s["min_rss"] < 999999 else "n/a"

    print(f"  {bot}: uptime={uptime_pct:.0f}% RSS={rss_range} new_OOM={new_ooms} new_kills={new_kills} new_errors={new_errors}")

# Session trend
first_sess = snapshots[0].get("session_total_mb", 0)
last_sess = snapshots[-1].get("session_total_mb", 0)
delta = last_sess - first_sess
print(f"\nSessions: {first_sess}MB → {last_sess}MB (delta: {delta:+.1f}MB)")
PY
else
  # Append mode: run health check and append result
  SNAPSHOT=$(MACHINE_NAME="$MACHINE_NAME" bash "$ROOT_DIR/scripts/health-check.sh" --json 2>/dev/null)
  if [[ -n "$SNAPSHOT" ]]; then
    echo "$SNAPSHOT" >> "$HISTORY_FILE"
    echo "Appended snapshot to $HISTORY_FILE ($(wc -l < "$HISTORY_FILE") entries)"
  else
    echo "Health check returned empty result" >&2
    exit 1
  fi
fi
