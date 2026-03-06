#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS_DIR="$ROOT_DIR/_runtime/logs"
INSTANCES_DIR="$ROOT_DIR/_runtime/instances"
HISTORY_FILE="$ROOT_DIR/_runtime/data/health-history.jsonl"
OUTPUT_MODE="${1:-text}"  # text or --json
MACHINE_NAME="${MACHINE_NAME:-$(hostname)}"
export MACHINE_NAME

python3 - "$LOGS_DIR" "$INSTANCES_DIR" "$OUTPUT_MODE" "$HISTORY_FILE" <<'PY'
import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta

logs_dir = sys.argv[1]
instances_dir = sys.argv[2]
json_mode = sys.argv[3] == "--json"
history_file = sys.argv[4]

import subprocess

ANSI_RE = re.compile(r'\x1b\[[0-9;]*m')
def strip_ansi(s):
    return ANSI_RE.sub('', s)

now = datetime.now(tz=timezone.utc)

# Get running containers to determine liveness
running_containers = set()
try:
    result = subprocess.run(
        ["podman", "ps", "--format", "{{.Names}}"],
        capture_output=True, text=True, timeout=10
    )
    for line in result.stdout.strip().splitlines():
        # container names like nanoclaw-cid-main-... → extract bot name
        parts = line.split("-")
        if len(parts) >= 2 and parts[0] == "nanoclaw":
            running_containers.add(parts[1])
except Exception:
    pass
report = {
    "ts": now.isoformat(),
    "machine": os.environ.get("MACHINE_NAME", os.environ.get("HOSTNAME", "unknown")),
    "bots": {},
    "sessions": {},
    "session_total_mb": 0,
    "rolling": {},
}

# Discover bots from error logs
bots = set()
if os.path.isdir(logs_dir):
    for f in os.listdir(logs_dir):
        if f.endswith('.error.log'):
            bots.add(f.replace('.error.log', ''))

for bot in sorted(bots):
    error_log = os.path.join(logs_dir, f"{bot}.error.log")
    main_log = os.path.join(logs_dir, f"{bot}.log")
    if not os.path.exists(error_log):
        continue

    error_size = os.path.getsize(error_log)
    main_size = os.path.getsize(main_log) if os.path.exists(main_log) else 0

    sigkills = 0
    sigterms = 0
    oom_kills = 0
    spawns = 0
    last_rss = None
    last_heap = None
    limit_mb = None
    last_ts = None
    errors = 0

    # Parse both main log and error log — events (spawns, kills, memory)
    # are in the main log; errors are in the error log.
    logs_to_parse = []
    if os.path.exists(main_log):
        logs_to_parse.append(main_log)
    logs_to_parse.append(error_log)

    try:
        for log_file in logs_to_parse:
            with open(log_file, 'r', errors='replace') as f:
                for line in f:
                    clean = strip_ansi(line.strip())
                    if 'SIGKILL' in clean:
                        sigkills += 1
                    if 'SIGTERM' in clean:
                        sigterms += 1
                    if 'isOomKill' in clean and 'true' in clean.lower():
                        oom_kills += 1
                    if 'Spawning container' in clean:
                        spawns += 1
                    if 'ERROR' in clean:
                        errors += 1
                    m = re.search(r'rssMB.*?(\d+)', clean)
                    if m:
                        last_rss = int(m.group(1))
                    m = re.search(r'heapMB.*?(\d+)', clean)
                    if m:
                        last_heap = int(m.group(1))
                    m = re.search(r'limitMB.*?(\d+)', clean)
                    if m and int(m.group(1)) > 0:
                        limit_mb = int(m.group(1))
                    m = re.match(r'\[(\d{2}:\d{2}:\d{2}\.\d+)\]', clean)
                    if m:
                        last_ts = m.group(1)
    except Exception as e:
        report["bots"][bot] = {"error": str(e)}
        continue

    # Fallback: read memory from metrics-history.jsonl if error logs lack it
    if last_rss is None:
        metrics_file = os.path.join(instances_dir, bot, "data", "metrics-history.jsonl")
        if os.path.exists(metrics_file):
            try:
                with open(metrics_file, 'rb') as mf:
                    mf.seek(0, 2)
                    pos = mf.tell()
                    buf = b''
                    while pos > 0 and buf.count(b'\n') < 3:
                        pos = max(0, pos - 4096)
                        mf.seek(pos)
                        buf = mf.read() + buf
                    for raw in reversed(buf.split(b'\n')):
                        raw = raw.strip()
                        if not raw:
                            continue
                        try:
                            m_data = json.loads(raw)
                            last_rss = m_data.get("rssMB")
                            last_heap = m_data.get("heapMB")
                            break
                        except (json.JSONDecodeError, ValueError):
                            continue
            except Exception:
                pass

    # Use most recent mtime of either log for age (main log is always written to)
    log_mtime = os.path.getmtime(error_log)
    if os.path.exists(main_log):
        log_mtime = max(log_mtime, os.path.getmtime(main_log))
    log_dt = datetime.fromtimestamp(log_mtime, tz=timezone.utc)
    age_min = (now - log_dt).total_seconds() / 60

    # A bot with a running container is ACTIVE regardless of log age
    # If podman is unavailable, fall back to log freshness (< 5min = ACTIVE)
    if bot in running_containers:
        status = "ACTIVE"
    elif not running_containers and age_min < 5:
        status = "ACTIVE"
    else:
        status = "RECENT" if age_min < 60 else "STALE"

    report["bots"][bot] = {
        "status": status,
        "log_age_min": round(age_min),
        "error_log_kb": round(error_size / 1024),
        "main_log_kb": round(main_size / 1024),
        "rss_mb": last_rss,
        "heap_mb": last_heap,
        "limit_mb": limit_mb,
        "mem_pct": round(last_rss / limit_mb * 100) if last_rss and limit_mb else None,
        "spawns": spawns,
        "sigkills": sigkills,
        "sigterms": sigterms,
        "oom_kills": oom_kills,
        "errors": errors,
        "last_ts": last_ts,
    }

# Session sizes
total_session = 0
if os.path.isdir(instances_dir):
    for bot_dir in sorted(os.listdir(instances_dir)):
        bot_path = os.path.join(instances_dir, bot_dir)
        if not os.path.isdir(bot_path):
            continue
        size = 0
        for dp, _, fnames in os.walk(bot_path, followlinks=False):
            for fn in fnames:
                fp = os.path.join(dp, fn)
                if os.path.islink(fp):
                    continue
                try:
                    size += os.path.getsize(fp)
                except OSError:
                    pass
        size_mb = round(size / 1024 / 1024, 1)
        total_session += size
        report["sessions"][bot_dir] = size_mb
report["session_total_mb"] = round(total_session / 1024 / 1024, 1)

# ── Rolling metrics from history ──────────────────────────────────
def compute_rolling(snapshots, hours_label):
    """Compute rolling deltas from a list of snapshots."""
    if len(snapshots) < 2:
        return None
    first = snapshots[0]
    last = snapshots[-1]
    result = {"snapshots": len(snapshots), "bots": {}}

    for bot in set(list(first.get("bots", {})) + list(last.get("bots", {}))):
        fb = first.get("bots", {}).get(bot, {})
        lb = last.get("bots", {}).get(bot, {})
        if "error" in fb or "error" in lb:
            continue
        result["bots"][bot] = {
            "oom_kills": lb.get("oom_kills", 0) - fb.get("oom_kills", 0),
            "sigkills": lb.get("sigkills", 0) - fb.get("sigkills", 0),
            "errors": lb.get("errors", 0) - fb.get("errors", 0),
            "spawns": lb.get("spawns", 0) - fb.get("spawns", 0),
            "rss_max": max(
                (s.get("bots", {}).get(bot, {}).get("rss_mb", 0) or 0)
                for s in snapshots
            ),
        }

    first_sess = first.get("session_total_mb", 0)
    last_sess = last.get("session_total_mb", 0)
    result["session_delta_mb"] = round(last_sess - first_sess, 1)
    return result

if os.path.exists(history_file):
    cutoff_24h = now - timedelta(hours=24)
    cutoff_7d = now - timedelta(days=7)
    snaps_24h = []
    snaps_7d = []
    try:
        with open(history_file, 'r') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    snap = json.loads(line)
                    ts = datetime.fromisoformat(snap["ts"])
                    if ts >= cutoff_7d:
                        snaps_7d.append(snap)
                    if ts >= cutoff_24h:
                        snaps_24h.append(snap)
                except (json.JSONDecodeError, KeyError, ValueError):
                    continue
    except Exception:
        pass

    r24 = compute_rolling(snaps_24h, "24h")
    r7d = compute_rolling(snaps_7d, "7d")
    if r24:
        report["rolling"]["24h"] = r24
    if r7d:
        report["rolling"]["7d"] = r7d

# Output
if json_mode:
    print(json.dumps(report))
else:
    print("=" * 60)
    print("FLEET HEALTH CHECK — " + now.strftime("%Y-%m-%d %H:%M:%S UTC"))
    print(f"Machine: {report['machine']}")
    print("=" * 60)
    for bot, d in report["bots"].items():
        if "error" in d:
            print(f"\n--- {bot} ---\n  Error: {d['error']}")
            continue
        print(f"\n--- {bot} [{d['status']}] ---")
        print(f"  Log age: {d['log_age_min']}min | Error: {d['error_log_kb']}KB | Main: {d['main_log_kb']}KB")
        if d["rss_mb"] is not None:
            mem_line = f"  Memory: RSS={d['rss_mb']}MB heap={d['heap_mb']}MB"
            if d["limit_mb"] is not None:
                mem_line += f" limit={d['limit_mb']}MB ({d['mem_pct']}%)"
            print(mem_line)
        print(f"  Cumulative: spawns={d['spawns']} SIGKILLs={d['sigkills']} SIGTERMs={d['sigterms']} OOM={d['oom_kills']} errors={d['errors']}")
        if d["last_ts"]:
            print(f"  Last entry: {d['last_ts']}")

    # Rolling metrics
    for window, label in [("24h", "24-HOUR"), ("7d", "7-DAY")]:
        rolling = report.get("rolling", {}).get(window)
        if rolling:
            print(f"\n{'=' * 60}")
            print(f"ROLLING {label} ({rolling['snapshots']} snapshots)")
            print("=" * 60)
            for bot, rd in rolling["bots"].items():
                print(f"  {bot}: OOM={rd['oom_kills']} kills={rd['sigkills']} errors={rd['errors']} spawns={rd['spawns']} peak_RSS={rd['rss_max']}MB")
            print(f"  Session delta: {rolling['session_delta_mb']:+.1f}MB")

    print(f"\n{'=' * 60}")
    print("SESSION FILES")
    for bot, mb in report["sessions"].items():
        print(f"  {bot}: {mb}MB")
    print(f"  TOTAL: {report['session_total_mb']}MB")
    print(f"\n{'=' * 60}")
PY
