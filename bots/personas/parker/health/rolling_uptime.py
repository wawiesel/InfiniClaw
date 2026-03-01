#!/usr/bin/env python3
"""
Compute 1-day and 7-day rolling uptime for each bot persona and each machine.

Bot uptime: derived from a local heartbeat log (uptime.db) that periodically
records each bot's liveness status. Uses the MetricOfSadness algorithm:
downtime is confirmed only when two consecutive pings are both down.

Machine uptime: derived from MetricOfSadness SQLite databases.

Usage:
  python3 rolling_uptime.py             # report current rolling uptime
  python3 rolling_uptime.py --ping      # record current heartbeat status + report
"""

import json
import os
import sqlite3
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

RUNTIME = Path(os.environ.get("INFINICLAW_RUNTIME", "/workspace/extra/InfiniClaw/_runtime"))
INSTANCES_DIR = RUNTIME / "instances"
HEALTH_DIR = Path("/workspace/extra/parker-persona/health")
UPTIME_DB = HEALTH_DIR / "uptime.db"
MOS_DIR = Path("/Users/ww5/2026-MetricOfSadness")

BOTS = ["architect", "commander", "engineer", "navigator", "parker"]
HEARTBEAT_STALE_S = 180  # 3 minutes — matches InfiniClaw's threshold


def now_utc():
    return datetime.now(timezone.utc).replace(microsecond=0)


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ── Uptime DB ────────────────────────────────────────────────────────

def init_db():
    """Create the uptime.db if it doesn't exist."""
    HEALTH_DIR.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(str(UPTIME_DB)) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS bot_pings (
                timestamp TEXT,
                bot TEXT,
                status TEXT,
                PRIMARY KEY (timestamp, bot)
            )
        """)


def record_ping():
    """Record current heartbeat status for each bot."""
    now = now_utc()
    ts = now.isoformat()

    with sqlite3.connect(str(UPTIME_DB)) as conn:
        for bot in BOTS:
            heartbeat_path = INSTANCES_DIR / bot / "data" / "heartbeat"
            status = "down"
            if heartbeat_path.exists():
                try:
                    hb_ms = int(heartbeat_path.read_text().strip())
                    age_s = (now - datetime.fromtimestamp(hb_ms / 1000, tz=timezone.utc)).total_seconds()
                    status = "up" if age_s < HEARTBEAT_STALE_S else "down"
                except (ValueError, OSError):
                    pass
            conn.execute(
                "INSERT OR REPLACE INTO bot_pings VALUES (?, ?, ?)",
                (ts, bot, status),
            )

    # Prune: keep only last 10 days
    cutoff = (now - timedelta(days=10)).isoformat()
    with sqlite3.connect(str(UPTIME_DB)) as conn:
        conn.execute("DELETE FROM bot_pings WHERE timestamp < ?", (cutoff,))


# ── MOS-style uptime calculation ─────────────────────────────────────

def uptime_pct(events, window_start, window_end):
    """
    Compute uptime % from a list of (datetime, is_up:bool) events.
    Uses the MetricOfSadness two-consecutive-downs algorithm.
    """
    total = (window_end - window_start).total_seconds()
    if total <= 0 or not events:
        return None
    sorted_events = sorted(events, key=lambda e: e[0])
    down_seconds = 0.0
    for i in range(len(sorted_events) - 1):
        if not sorted_events[i][1] and not sorted_events[i + 1][1]:
            t_i = sorted_events[i][0]
            t_n = sorted_events[i + 1][0]
            cs = max(t_i, window_start)
            ce = min(t_n, window_end)
            if ce > cs:
                down_seconds += (ce - cs).total_seconds()
    return round(100.0 * (total - down_seconds) / total, 2)


# ── Bot uptime from uptime.db ────────────────────────────────────────

def compute_bot_uptime():
    """Compute 1d and 7d rolling uptime for each bot from the ping database."""
    now = now_utc()
    result = {}

    if not UPTIME_DB.exists():
        for bot in BOTS:
            result[bot] = {"uptime_1d": None, "uptime_7d": None, "status": "unknown"}
        return result

    with sqlite3.connect(str(UPTIME_DB)) as conn:
        for bot in BOTS:
            rows = conn.execute(
                "SELECT timestamp, status FROM bot_pings WHERE bot = ? ORDER BY timestamp",
                (bot,),
            ).fetchall()

            if not rows:
                result[bot] = {"uptime_1d": None, "uptime_7d": None, "status": "unknown"}
                continue

            events = [(parse_ts(r[0]), r[1] == "up") for r in rows]
            last_status = "up" if events[-1][1] else "down"

            up_1d = uptime_pct(events, now - timedelta(days=1), now)
            up_7d = uptime_pct(events, now - timedelta(days=7), now)

            result[bot] = {
                "uptime_1d": up_1d,
                "uptime_7d": up_7d,
                "status": last_status,
            }

    return result


# ── Machine uptime (MetricOfSadness) ────────────────────────────────

def compute_machine_uptime():
    machines = {}

    # Local machine — always up
    machines["local"] = {
        "ssh_uptime_1d": 100.0,
        "ssh_uptime_7d": 100.0,
        "dirs_uptime_1d": None,
        "dirs_uptime_7d": None,
    }

    # scaledev — from MetricOfSadness
    ssh_db = MOS_DIR / "ssh.db"
    dirs_db = MOS_DIR / "dirs.db"

    if ssh_db.exists() and dirs_db.exists():
        sd = {
            "ssh_uptime_1d": None, "ssh_uptime_7d": None,
            "dirs_uptime_1d": None, "dirs_uptime_7d": None,
        }

        try:
            with sqlite3.connect(str(ssh_db)) as c:
                rows = c.execute(
                    "SELECT timestamp, ssh_status FROM ssh ORDER BY timestamp"
                ).fetchall()
            if rows:
                events = [(parse_ts(r[0]), r[1] == "available") for r in rows]
                last = events[-1][0]
                sd["ssh_uptime_1d"] = uptime_pct(events, last - timedelta(days=1), last)
                sd["ssh_uptime_7d"] = uptime_pct(events, last - timedelta(days=7), last)
        except Exception:
            pass

        try:
            with sqlite3.connect(str(dirs_db)) as c:
                rows = c.execute(
                    "SELECT timestamp, path, status, seconds FROM dir_checks ORDER BY timestamp"
                ).fetchall()
            if rows:
                by_ts = defaultdict(lambda: True)
                for ts, path, status, sec in rows:
                    if status != "available":
                        by_ts[ts] = False
                agg = [(parse_ts(ts), is_up) for ts, is_up in sorted(by_ts.items())]
                if agg:
                    last = agg[-1][0]
                    sd["dirs_uptime_1d"] = uptime_pct(agg, last - timedelta(days=1), last)
                    sd["dirs_uptime_7d"] = uptime_pct(agg, last - timedelta(days=7), last)
        except Exception:
            pass

        machines["scaledev"] = sd

    return machines


# ── Main ─────────────────────────────────────────────────────────────

def main():
    do_ping = "--ping" in sys.argv

    init_db()

    if do_ping:
        record_ping()

    result = {
        "timestamp": now_utc().isoformat(),
        "bots": compute_bot_uptime(),
        "machines": compute_machine_uptime(),
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
