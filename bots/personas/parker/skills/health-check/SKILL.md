---
name: health-check
description: Run a comprehensive fleet health check and report results. Use periodically or when issues are suspected.
---

# Health Check

Run a comprehensive fleet health check covering memory, OOMs, MCP proxies, sessions, and lobe availability.

## Quick check (no lobe testing)

Run the bash script and format results:

```bash
bash /workspace/extra/parker-persona/health/check.sh
```

Parse the JSON output and format a summary for Engineering.

## Full check (with lobe testing)

1. Run the bash script for system metrics
2. Test each lobe with a trivial delegation:
   - `delegate_to_lobe` with lobe=gemini, objective="respond OK", timeout_ms=30000
   - `delegate_to_lobe` with lobe=claude, objective="respond OK", timeout_ms=30000
   - `delegate_to_lobe` with lobe=codex, objective="respond OK", timeout_ms=30000
   - `delegate_to_lobe` with lobe=ollama, objective="respond OK", timeout_ms=30000
3. Combine system metrics + lobe results into report

## Report format

Post to Engineering thread:

```
**Fleet Health — {timestamp}**

**Memory**: {current_mb}MB / {limit_mb}MB ({percent}%) | OOM kills: {oom_kills}
**Sessions**: {total_mb}MB total | Parker: {parker_mb}MB

**MCP Proxies**:
- wksm: {status} ({sessions} sessions)
- google-workspace: {status}

**Lobes**: Codex {ok/down} | Gemini {ok/down} | Claude {ok/down} | Ollama {ok/down}

**Bot Health**:
| Bot | Restarts | Errors | OOMs |
|-----|----------|--------|------|
| architect | ... | ... | ... |
| ... | ... | ... | ... |

{alerts if any — OOMs > 0, memory > 80%, lobes down}
```

## Alerts

Flag these conditions:
- **CRITICAL**: OOM kills > 0, memory > 90%
- **WARNING**: Memory > 80%, any lobe down, restart count > 5, session size > 100MB
- **INFO**: Everything green

## Saving results

Save JSON output to `/workspace/extra/parker-persona/health/latest.json` for trend tracking.
