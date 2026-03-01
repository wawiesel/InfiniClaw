---
name: tune
description: Run TUNE performance metrics dashboard. Use periodically to check system health targets.
---

# TUNE — Performance Metrics

Run the metrics script to produce the TUNE dashboard:

```bash
python3 /home/node/.claude/skills/tune/scripts/metrics.py
```

For JSON output (for programmatic use):
```bash
python3 /home/node/.claude/skills/tune/scripts/metrics.py --json
```

## Captain-Defined Targets

| Metric | Target |
|---|---|
| responsiveness | <2s from message to first response |
| idle_time | 0s (always working on standing orders) |
| restart_rate | <1 per hour |

## What to Do With Results

1. Report the dashboard to Engineering
2. If any metric is 🔴, investigate and fix
3. After fixes, re-run to confirm improvement
4. Save significant baseline changes to memory
