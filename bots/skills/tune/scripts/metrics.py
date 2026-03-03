#!/usr/bin/env python3
"""TUNE metrics dashboard — parses InfiniClaw logs to produce performance baselines."""

import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta

INFINICLAW_ROOT = os.environ.get("INFINICLAW_ROOT", "/workspace/extra/InfiniClaw")
LOGS_DIR = os.path.join(INFINICLAW_ROOT, "_runtime", "logs")


def parse_log_lines(filepath: str) -> list[dict]:
    """Parse pino-style log lines into structured records."""
    entries = []
    if not os.path.exists(filepath):
        return entries
    with open(filepath) as f:
        for line in f:
            # Match pino format: [HH:MM:SS.mmm] LEVEL (pid): message
            m = re.match(
                r"\[(\d{2}:\d{2}:\d{2}\.\d{3})\]\s+(?:\x1b\[\d+m)?(\w+)(?:\x1b\[\d+m)?\s+\((\d+)\):\s+(?:\x1b\[\d+m)?(.*?)(?:\x1b\[\d+m)?$",
                line,
            )
            if m:
                entries.append({
                    "time": m.group(1),
                    "level": m.group(2),
                    "pid": m.group(3),
                    "msg": m.group(4),
                })
    return entries


def count_pattern(filepath: str, pattern: str) -> int:
    """Count regex matches in a file."""
    if not os.path.exists(filepath):
        return 0
    with open(filepath) as f:
        return len(re.findall(pattern, f.read()))


def get_log_span_hours(content: str) -> float:
    """Compute hours between first and last timestamps in log content.
    Falls back to file stat if timestamps can't be parsed.
    Logs only have HH:MM:SS — we count day boundaries when time goes backwards."""
    times = re.findall(r"\[(\d{2}):(\d{2}):(\d{2})\.\d{3}\]", content)
    if len(times) < 2:
        return 0
    total_seconds = 0.0
    prev_secs = int(times[0][0]) * 3600 + int(times[0][1]) * 60 + int(times[0][2])
    for h, m, s in times[1:]:
        cur_secs = int(h) * 3600 + int(m) * 60 + int(s)
        diff = cur_secs - prev_secs
        if diff < -43200:  # Wrapped past midnight (>12h backward jump)
            diff += 86400
        if diff > 0:
            total_seconds += diff
        prev_secs = cur_secs
    return total_seconds / 3600


def analyze_bot(bot: str) -> dict:
    """Analyze metrics for a single bot."""
    logfile = os.path.join(LOGS_DIR, f"{bot}.log")
    errfile = os.path.join(LOGS_DIR, f"{bot}.error.log")
    if not os.path.exists(logfile):
        return {"bot": bot, "error": "no logs found"}

    # Read full log content once
    with open(logfile) as f:
        content = f.read()

    age_hours = get_log_span_hours(content)
    if age_hours == 0:
        return {"bot": bot, "error": "insufficient log data"}

    results = {"bot": bot, "log_hours": round(age_hours, 1)}

    # Container exits by code
    exit_codes = defaultdict(int)
    for m in re.finditer(r"Container exited with code (\d+)", content):
        exit_codes[int(m.group(1))] += 1
    total_exits = sum(exit_codes.values())
    results["exits"] = dict(exit_codes)
    results["exits_total"] = total_exits
    results["exits_per_hour"] = round(total_exits / max(age_hours, 1), 2)
    results["oom_kills"] = exit_codes.get(137, 0)
    results["oom_per_hour"] = round(exit_codes.get(137, 0) / max(age_hours, 1), 2)

    # Container durations
    durations = [int(d) for d in re.findall(r"Duration: (\d+)ms", content)]
    if durations:
        results["container_duration_ms"] = {
            "min": min(durations),
            "max": max(durations),
            "avg": round(sum(durations) / len(durations)),
            "p50": sorted(durations)[len(durations) // 2],
            "count": len(durations),
        }

    # Rate limits
    rate_limits = len(re.findall(r"M_LIMIT_EXCEEDED|rate.limit|429", content, re.IGNORECASE))
    results["rate_limits"] = rate_limits
    results["rate_limits_per_hour"] = round(rate_limits / max(age_hours, 1), 2)

    # M_TOO_LARGE
    too_large = len(re.findall(r"M_TOO_LARGE", content))
    results["m_too_large"] = too_large

    # Failed sends/edits
    failed_sends = len(re.findall(r"Failed to send", content, re.IGNORECASE))
    failed_edits = len(re.findall(r"Failed to edit|edit.*failed", content, re.IGNORECASE))
    results["failed_sends"] = failed_sends
    results["failed_edits"] = failed_edits

    # Error log size
    if os.path.exists(errfile):
        results["error_log_bytes"] = os.path.getsize(errfile)
    else:
        results["error_log_bytes"] = 0

    return results


def format_dashboard(metrics: list[dict]) -> str:
    """Format metrics as a markdown dashboard."""
    lines = ["# 🎛️ TUNE Dashboard\n"]

    for m in metrics:
        bot = m["bot"]
        if "error" in m:
            lines.append(f"## {bot}: {m['error']}\n")
            continue

        lines.append(f"## {bot} ({m['log_hours']}h of logs)\n")

        # Restart rate
        target_met = "🟢" if m["exits_per_hour"] < 1 else "🔴"
        lines.append(f"| Metric | Value | Target | Status |")
        lines.append(f"|---|---|---|---|")
        lines.append(f"| **Restart rate** | {m['exits_per_hour']}/hr ({m['exits_total']} total) | <1/hr | {target_met} |")
        lines.append(f"| **OOM kills** | {m['oom_per_hour']}/hr ({m['oom_kills']} total) | 0 | {'🟢' if m['oom_kills'] == 0 else '🟡'} |")
        lines.append(f"| **Rate limits** | {m['rate_limits_per_hour']}/hr ({m['rate_limits']} total) | 0 | {'🟢' if m['rate_limits'] == 0 else '🟡' if m['rate_limits_per_hour'] < 10 else '🔴'} |")
        lines.append(f"| **M_TOO_LARGE** | {m['m_too_large']} | 0 | {'🟢' if m['m_too_large'] == 0 else '🟡'} |")
        lines.append(f"| **Failed sends** | {m['failed_sends']} | 0 | {'🟢' if m['failed_sends'] == 0 else '🟡'} |")
        lines.append(f"| **Failed edits** | {m['failed_edits']} | 0 | {'🟢' if m['failed_edits'] == 0 else '🟡'} |")
        lines.append(f"| **Error log** | {m['error_log_bytes']} bytes | 0 | {'🟢' if m['error_log_bytes'] == 0 else '🟡'} |")

        if "container_duration_ms" in m:
            d = m["container_duration_ms"]
            lines.append(f"\n**Container runs** ({d['count']} total): avg {d['avg']}ms, p50 {d['p50']}ms, min {d['min']}ms, max {d['max']}ms")

        exits = m.get("exits", {})
        if exits:
            exit_str = ", ".join(f"code {k}: {v}" for k, v in sorted(exits.items()))
            lines.append(f"\n**Exit codes**: {exit_str}")

        lines.append("")

    return "\n".join(lines)


def main():
    bots = ["engineer", "commander"]
    metrics = [analyze_bot(b) for b in bots]

    if "--json" in sys.argv:
        print(json.dumps(metrics, indent=2))
    else:
        print(format_dashboard(metrics))


if __name__ == "__main__":
    main()
