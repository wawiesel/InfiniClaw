#!/usr/bin/env bash
set -euo pipefail
#
# fleet-health.sh — Aggregate health reports from all machines.
#
# Usage:
#   1. Each machine runs: MACHINE_NAME=X health-check.sh --json > /path/report.json
#   2. Collect reports into a directory (one JSON file per machine)
#   3. Run: fleet-health.sh /path/to/reports/
#
# Or for local-only: fleet-health.sh --local
#

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORTS_DIR="${1:-}"

if [ "$REPORTS_DIR" = "--local" ]; then
    # Run local health check and display
    MACHINE_NAME="${MACHINE_NAME:-$(hostname)}" bash "$ROOT_DIR/scripts/health-check.sh"
    exit 0
fi

if [ -z "$REPORTS_DIR" ]; then
    REPORTS_DIR="$ROOT_DIR/_runtime/data/health-reports"
    mkdir -p "$REPORTS_DIR"
fi

python3 - "$REPORTS_DIR" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

reports_dir = sys.argv[1]

if not os.path.isdir(reports_dir):
    print(f"Reports directory not found: {reports_dir}")
    sys.exit(1)

reports = []
for f in sorted(os.listdir(reports_dir)):
    if not f.endswith('.json'):
        continue
    try:
        with open(os.path.join(reports_dir, f)) as fh:
            reports.append(json.load(fh))
    except (json.JSONDecodeError, IOError) as e:
        print(f"  Skipping {f}: {e}")

if not reports:
    print("No health reports found.")
    print(f"Directory: {reports_dir}")
    print()
    print("To generate a report on each machine:")
    print("  MACHINE_NAME=<name> bash scripts/health-check.sh --json > report.json")
    sys.exit(0)

now = datetime.now(tz=timezone.utc)
print("=" * 70)
print(f"FLEET HEALTH SUMMARY — {now.strftime('%Y-%m-%d %H:%M:%S UTC')}")
print(f"Machines reporting: {len(reports)}")
print("=" * 70)

# Aggregate
total_oom = 0
total_sigkills = 0
total_sessions_mb = 0
all_bots = []

for r in reports:
    machine = r.get("machine", "unknown")
    ts = r.get("ts", "?")
    bots = r.get("bots", {})
    sessions = r.get("sessions", {})
    session_total = r.get("session_total_mb", 0)

    print(f"\n{'─' * 70}")
    print(f"MACHINE: {machine} (reported: {ts})")
    print(f"{'─' * 70}")

    active = [b for b, d in bots.items() if d.get("status") == "ACTIVE"]
    stale = [b for b, d in bots.items() if d.get("status") == "STALE"]

    print(f"  Active bots: {', '.join(active) if active else 'none'}")
    if stale:
        print(f"  Stale bots: {', '.join(stale)}")

    # Per-bot summary (active only, or high OOM)
    for bot, d in bots.items():
        if isinstance(d, dict) and "error" not in d:
            oom = d.get("oom_kills", 0)
            total_oom += oom
            total_sigkills += d.get("sigkills", 0)
            all_bots.append({"machine": machine, "bot": bot, **d})

            if d.get("status") == "ACTIVE" or oom > 0:
                mem_str = f"RSS={d['rss_mb']}MB/{d['limit_mb']}MB ({d['mem_pct']}%)" if d.get('rss_mb') else "n/a"
                print(f"  {bot}: {d['status']} | {mem_str} | OOM={oom} SIGKILL={d.get('sigkills',0)}")

    total_sessions_mb += session_total
    print(f"  Session storage: {session_total}MB")

# Fleet-wide alerts
print(f"\n{'=' * 70}")
print("FLEET TOTALS")
print(f"  Total OOM kills: {total_oom}")
print(f"  Total SIGKILLs: {total_sigkills}")
print(f"  Total session storage: {total_sessions_mb}MB")

# Top offenders
if all_bots:
    by_oom = sorted(all_bots, key=lambda x: x.get("oom_kills", 0), reverse=True)[:3]
    if by_oom[0].get("oom_kills", 0) > 0:
        print("\n  Top OOM offenders:")
        for b in by_oom:
            if b.get("oom_kills", 0) > 0:
                print(f"    {b['machine']}/{b['bot']}: {b['oom_kills']} OOM kills")

    by_session = sorted(
        [(m, b, mb) for r in reports for b, mb in r.get("sessions", {}).items()
         if (m := r.get("machine", "?"))],
        key=lambda x: x[2], reverse=True
    )[:3]
    if by_session:
        print("\n  Largest session storage:")
        for machine, bot, mb in by_session:
            print(f"    {machine}/{bot}: {mb}MB")

print(f"\n{'=' * 70}")
PY
