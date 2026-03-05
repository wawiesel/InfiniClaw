#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS_DIR="$ROOT_DIR/_runtime/logs"
INSTANCES_DIR="$ROOT_DIR/_runtime/instances"
OUTPUT_MODE="${1:-text}"  # text or --json
MACHINE_NAME="${MACHINE_NAME:-$(hostname)}"
export MACHINE_NAME

python3 - "$LOGS_DIR" "$INSTANCES_DIR" "$OUTPUT_MODE" <<'PY'
import json
import os
import re
import sys
from datetime import datetime, timezone

logs_dir = sys.argv[1]
instances_dir = sys.argv[2]
json_mode = sys.argv[3] == "--json"

ANSI_RE = re.compile(r'\x1b\[[0-9;]*m')
def strip_ansi(s):
    return ANSI_RE.sub('', s)

now = datetime.now(tz=timezone.utc)
report = {
    "ts": now.isoformat(),
    "machine": os.environ.get("MACHINE_NAME", os.environ.get("HOSTNAME", "unknown")),
    "bots": {},
    "sessions": {},
    "session_total_mb": 0,
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

    try:
        with open(error_log, 'r', errors='replace') as f:
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
                if m:
                    limit_mb = int(m.group(1))
                m = re.match(r'\[(\d{2}:\d{2}:\d{2}\.\d+)\]', clean)
                if m:
                    last_ts = m.group(1)
    except Exception as e:
        report["bots"][bot] = {"error": str(e)}
        continue

    error_mtime = datetime.fromtimestamp(os.path.getmtime(error_log), tz=timezone.utc)
    age_min = (now - error_mtime).total_seconds() / 60
    status = "ACTIVE" if age_min < 5 else ("RECENT" if age_min < 60 else "STALE")

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
            print(f"  Memory: RSS={d['rss_mb']}MB heap={d['heap_mb']}MB limit={d['limit_mb']}MB ({d['mem_pct']}%)")
        print(f"  Events: spawns={d['spawns']} SIGKILLs={d['sigkills']} SIGTERMs={d['sigterms']} OOM={d['oom_kills']} errors={d['errors']}")
        if d["last_ts"]:
            print(f"  Last entry: {d['last_ts']}")
    print(f"\n{'=' * 60}")
    print("SESSION FILES")
    for bot, mb in report["sessions"].items():
        print(f"  {bot}: {mb}MB")
    print(f"  TOTAL: {report['session_total_mb']}MB")
    print(f"\n{'=' * 60}")
PY
