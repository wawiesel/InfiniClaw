#!/usr/bin/env python3
"""
Compute 1-day and 7-day rolling uptime for each bot persona and each machine.

Bot uptime: derived from a local heartbeat log (uptime.db) that periodically
records each bot's liveness status. Uses the MetricOfSadness algorithm:
downtime is confirmed only when two consecutive pings are both down.

Machine uptime: local (always up) and heracles (SSH port 22 liveness check).
Both use the same two-consecutive-downs algorithm via machine_pings table.

Usage:
  python3 rolling_uptime.py             # report current rolling uptime
  python3 rolling_uptime.py --ping      # record current heartbeat status + report
"""

import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

RUNTIME = Path(os.environ.get("INFINICLAW_RUNTIME", "/workspace/extra/InfiniClaw/_runtime"))
INSTANCES_DIR = RUNTIME / "instances"
HEALTH_DIR = Path("/workspace/extra/parker-persona/health")
UPTIME_DB = HEALTH_DIR / "uptime.db"

BOTS = ["cid", "johnny5", "albert", "parker"]
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


# ── Machine uptime ─────────────────────────────────────────────────
# Machines: local (mac139160) and heracles.
# Local is always up if we're running. Heracles is tracked via ping DB.

def _init_machine_table(conn):
    """Create machine_pings table if needed."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS machine_pings (
            timestamp TEXT,
            machine TEXT,
            status TEXT,
            PRIMARY KEY (timestamp, machine)
        )
    """)


def record_machine_ping():
    """Record liveness for each machine. Local is always up.
    Heracles: check if SSH is reachable (port 22) with a 3s timeout."""
    now = now_utc()
    ts = now.isoformat()

    with sqlite3.connect(str(UPTIME_DB)) as conn:
        _init_machine_table(conn)

        # Local — always up (we're running on it)
        conn.execute(
            "INSERT OR REPLACE INTO machine_pings VALUES (?, ?, ?)",
            (ts, "local", "up"),
        )

        # Heracles — try TCP connect to port 22
        heracles_status = "down"
        try:
            import socket
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(3)
            result = sock.connect_ex(("heracles", 22))
            if result == 0:
                heracles_status = "up"
            sock.close()
        except Exception:
            pass
        conn.execute(
            "INSERT OR REPLACE INTO machine_pings VALUES (?, ?, ?)",
            (ts, "heracles", heracles_status),
        )

    # Prune old machine pings too
    cutoff = (now - timedelta(days=10)).isoformat()
    with sqlite3.connect(str(UPTIME_DB)) as conn:
        conn.execute("DELETE FROM machine_pings WHERE timestamp < ?", (cutoff,))


def compute_machine_uptime():
    """Compute 1d and 7d rolling uptime for each machine from ping database."""
    now = now_utc()
    machines_list = ["local", "heracles"]
    result = {}

    if not UPTIME_DB.exists():
        for m in machines_list:
            result[m] = {"uptime_1d": None, "uptime_7d": None, "status": "unknown"}
        return result

    with sqlite3.connect(str(UPTIME_DB)) as conn:
        _init_machine_table(conn)
        for m in machines_list:
            rows = conn.execute(
                "SELECT timestamp, status FROM machine_pings WHERE machine = ? ORDER BY timestamp",
                (m,),
            ).fetchall()

            if not rows:
                result[m] = {"uptime_1d": None, "uptime_7d": None, "status": "unknown"}
                continue

            events = [(parse_ts(r[0]), r[1] == "up") for r in rows]
            last_status = "up" if events[-1][1] else "down"

            up_1d = uptime_pct(events, now - timedelta(days=1), now)
            up_7d = uptime_pct(events, now - timedelta(days=7), now)

            result[m] = {
                "uptime_1d": up_1d,
                "uptime_7d": up_7d,
                "status": last_status,
            }

    return result


# ── Main ─────────────────────────────────────────────────────────────

def main():
    do_ping = "--ping" in sys.argv

    init_db()

    if do_ping:
        record_ping()
        record_machine_ping()

    result = {
        "timestamp": now_utc().isoformat(),
        "bots": compute_bot_uptime(),
        "machines": compute_machine_uptime(),
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
