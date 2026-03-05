#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS_DIR="$ROOT_DIR/_runtime/logs"
INSTANCES_DIR="$ROOT_DIR/_runtime/instances"

python3 - "$LOGS_DIR" "$INSTANCES_DIR" <<'PY'
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone

logs_dir = sys.argv[1]
instances_dir = sys.argv[2]

# Strip ANSI escape codes
ANSI_RE = re.compile(r'\x1b\[[0-9;]*m')
def strip_ansi(s):
    return ANSI_RE.sub('', s)

# Discover bots from error logs
bots = set()
for f in os.listdir(logs_dir):
    if f.endswith('.error.log'):
        bots.add(f.replace('.error.log', ''))

print("=" * 60)
print("FLEET HEALTH CHECK — " + datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"))
print("=" * 60)

for bot in sorted(bots):
    error_log = os.path.join(logs_dir, f"{bot}.error.log")
    main_log = os.path.join(logs_dir, f"{bot}.log")

    if not os.path.exists(error_log):
        continue

    error_size = os.path.getsize(error_log)
    main_size = os.path.getsize(main_log) if os.path.exists(main_log) else 0

    # Parse error log for key events
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
                # Count SIGKILLs
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

                # Extract memory values
                m = re.search(r'rssMB.*?(\d+)', clean)
                if m:
                    last_rss = int(m.group(1))
                m = re.search(r'heapMB.*?(\d+)', clean)
                if m:
                    last_heap = int(m.group(1))
                m = re.search(r'limitMB.*?(\d+)', clean)
                if m:
                    limit_mb = int(m.group(1))

                # Extract timestamp
                m = re.match(r'\[(\d{2}:\d{2}:\d{2}\.\d+)\]', clean)
                if m:
                    last_ts = m.group(1)
    except Exception as e:
        print(f"\n--- {bot} ---")
        print(f"  Error reading log: {e}")
        continue

    # Log freshness
    error_mtime = datetime.fromtimestamp(os.path.getmtime(error_log), tz=timezone.utc)
    age_min = (datetime.now(tz=timezone.utc) - error_mtime).total_seconds() / 60

    # Status determination
    if age_min < 5:
        status = "ACTIVE"
    elif age_min < 60:
        status = "RECENT"
    else:
        status = "STALE"

    print(f"\n--- {bot} [{status}] ---")
    print(f"  Log age: {age_min:.0f}min | Error log: {error_size/1024:.0f}KB | Main log: {main_size/1024:.0f}KB")
    if last_rss is not None:
        pct = (last_rss / limit_mb * 100) if limit_mb else 0
        print(f"  Memory: RSS={last_rss}MB heap={last_heap}MB limit={limit_mb}MB ({pct:.0f}% used)")
    print(f"  Events: spawns={spawns} SIGKILLs={sigkills} SIGTERMs={sigterms} OOM={oom_kills} errors={errors}")
    if last_ts:
        print(f"  Last log entry: {last_ts}")

# Session sizes
print(f"\n{'=' * 60}")
print("SESSION FILES")
sessions_dir = os.path.join(instances_dir)
total_session_size = 0
for bot_dir in sorted(os.listdir(instances_dir)):
    bot_path = os.path.join(instances_dir, bot_dir)
    if not os.path.isdir(bot_path):
        continue
    size = 0
    for dp, _, fnames in os.walk(bot_path, followlinks=False):
        for f in fnames:
            fp = os.path.join(dp, f)
            if os.path.islink(fp):
                continue
            try:
                size += os.path.getsize(fp)
            except OSError:
                pass
    total_session_size += size
    print(f"  {bot_dir}: {size/1024/1024:.1f}MB")
print(f"  TOTAL: {total_session_size/1024/1024:.1f}MB")

print(f"\n{'=' * 60}")
print("END HEALTH CHECK")
PY
