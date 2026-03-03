#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_DATA_DIR="$ROOT_DIR/_runtime/data"
DATA_DIR="${DATA_DIR:-$DEFAULT_DATA_DIR}"
METRICS_FILE="$DATA_DIR/metrics-history.jsonl"

python3 - "$METRICS_FILE" <<'PY'
import json
import math
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone


def fmt_ts(ms):
    if ms is None:
        return "n/a"
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    except Exception:
        return "n/a"


def fmt_num(value):
    if value is None:
        return "n/a"
    if isinstance(value, float):
        return f"{value:.2f}"
    return str(value)


metrics_file = sys.argv[1]

if not os.path.exists(metrics_file):
    print("Metrics Dashboard")
    print(f"File: {metrics_file}")
    print("Status: metrics-history.jsonl not found yet.")
    sys.exit(0)

snapshots = []
invalid_lines = 0
with open(metrics_file, "r", encoding="utf-8") as f:
    for line_no, raw in enumerate(f, start=1):
        line = raw.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            invalid_lines += 1
            continue
        if not isinstance(obj, dict):
            invalid_lines += 1
            continue
        snapshots.append(obj)

if not snapshots:
    print("Metrics Dashboard")
    print(f"File: {metrics_file}")
    print("Status: no valid snapshots found.")
    if invalid_lines:
        print(f"Invalid lines skipped: {invalid_lines}")
    sys.exit(0)

# Time window
first_ts = snapshots[0].get("ts")
last_ts = snapshots[-1].get("ts")

# Memory trends
heap_vals = [s.get("heapMB") for s in snapshots if isinstance(s.get("heapMB"), (int, float))]
rss_vals = [s.get("rssMB") for s in snapshots if isinstance(s.get("rssMB"), (int, float))]


def trend(vals):
    if not vals:
        return (None, None, None)
    return (min(vals), max(vals), sum(vals) / len(vals))


heap_min, heap_max, heap_avg = trend(heap_vals)
rss_min, rss_max, rss_avg = trend(rss_vals)

# Per-group summaries
kill_total = defaultdict(int)
cooldown_activations = defaultdict(int)
active_total = defaultdict(int)
snapshot_total = defaultdict(int)
prev_kills = {}
prev_cooldown = {}

for snap in snapshots:
    groups = snap.get("groups")
    if not isinstance(groups, list):
        continue

    seen = set()
    for g in groups:
        if not isinstance(g, dict):
            continue
        gid = g.get("name") or g.get("jid") or "unknown"
        seen.add(gid)

        # Kill counter change tracking.
        kills = g.get("kills137")
        if isinstance(kills, (int, float)):
            kills = int(kills)
            if gid not in prev_kills:
                if kills > 0:
                    kill_total[gid] += kills
            else:
                delta = kills - prev_kills[gid]
                if delta > 0:
                    kill_total[gid] += delta
            prev_kills[gid] = kills

        cooldown = bool(g.get("killCooldownActive"))
        if gid in prev_cooldown and (not prev_cooldown[gid]) and cooldown:
            cooldown_activations[gid] += 1
        prev_cooldown[gid] = cooldown

        snapshot_total[gid] += 1
        if bool(g.get("active")):
            active_total[gid] += 1

# include groups that appeared in either summary
all_groups = sorted(set(snapshot_total) | set(kill_total) | set(cooldown_activations))

print("Metrics Dashboard")
print(f"File: {metrics_file}")
print()
print("Time Window")
print(f"- First snapshot: {fmt_ts(first_ts)}")
print(f"- Last snapshot:  {fmt_ts(last_ts)}")
print(f"- Snapshot count: {len(snapshots)}")
if invalid_lines:
    print(f"- Invalid lines skipped: {invalid_lines}")

print()
print("Per-Group Kill Summary")
if not all_groups:
    print("- No group data found")
else:
    for gid in all_groups:
        print(
            f"- {gid}: total exit-137 kills={kill_total[gid]}, "
            f"cooldown activations={cooldown_activations[gid]}"
        )

print()
print("Memory Trends (MB)")
print(
    "- heapMB: "
    f"min={fmt_num(heap_min)} max={fmt_num(heap_max)} avg={fmt_num(heap_avg)}"
)
print(
    "- rssMB:  "
    f"min={fmt_num(rss_min)} max={fmt_num(rss_max)} avg={fmt_num(rss_avg)}"
)

print()
print("Active Rate")
if not all_groups:
    print("- No group data found")
else:
    for gid in all_groups:
        total = snapshot_total[gid]
        active = active_total[gid]
        pct = (active / total * 100.0) if total > 0 else 0.0
        print(f"- {gid}: {pct:.1f}% ({active}/{total} snapshots active)")
PY
