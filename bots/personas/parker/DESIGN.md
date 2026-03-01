# Fleet Health Monitoring System — Design

Parker's primary mission: keep the fleet healthy, detect problems before the Captain does.

## Three pillars

### 1. Responsiveness

How fast does the fleet react?

| Metric | How measured | Target |
|--------|-------------|--------|
| Message-to-reply latency | Timestamp delta between trigger message and bot's first response | < 30s for simple replies |
| Container spawn time | Time from message arrival to container running (cold start) | < 15s |
| Lobe delegation round-trip | Time from `delegate_to_lobe` call to result returned | < 60s typical |
| MCP tool latency | Time to complete a wksm or google-workspace call | < 5s |

**Collection method:** Instrument the bot process (main.ts) to log timestamps at key points. Parse logs to extract latencies.

### 2. Uptime

Is everything running?

| Metric | How measured | Target |
|--------|-------------|--------|
| Bot availability | % of time each bot is online (via `list_recipients`) | > 99% |
| Unplanned restarts | Count of restarts not triggered by `restart_self` or deploy | 0 per day |
| OOM kills | Container exits with OOM signal or cgroup OOM events | **0 — never acceptable** |
| MCP proxy availability | Health endpoint check (wksm :8765, google-workspace :8767) | 100% |
| Lobe availability | Can each lobe (Codex, Gemini, Claude, Ollama) complete a test call? | All green |
| Restart loops | > 3 restarts in 10 minutes for same bot | 0 occurrences |

**OOM prevention (priority):**
- Container memory limit: 6144MB (6GB) per container
- Host heap watchdog: 1536MB threshold, checks every 60s, triggers graceful recycle
- OOMs happen when: session context grows too large, multiple lobes spawn simultaneously, or large file reads blow up memory
- Prevention strategies:
  - Monitor RSS per container via `docker stats` / `podman stats`
  - Alert when RSS exceeds 80% of container limit (4.9GB)
  - Track session file sizes — large sessions correlate with OOMs
  - Ensure host heap watchdog fires before container OOM killer

**Collection method:** Periodic health checks (every 5 min), log parsing for crash/restart events, container stats polling.

### 3. Capability (Captain-scored)

Is the bot actually useful?

| Rating | Score | Meaning |
|--------|-------|---------|
| 🅰️ | +5 | Excellent — exceeded expectations |
| 🅱️ | +2 | Good — got the job done |
| 👍 | +1 | Acceptable — minor issues |
| 👎 | -1 | Below expectations — needed correction |
| ❌ | -5 | Failed — wasted time or made things worse |

- Captain rates bot interactions via emoji reactions on messages
- Rolling score per bot, tracked over time
- Score resets are at Captain's discretion
- Capability score is the ultimate measure — a bot with 100% uptime but negative capability is failing

**Collection method:** Parse emoji reactions on bot messages from Matrix. Map reaction to score. Aggregate per bot per day/week.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Log Parser  │────▶│  Metrics DB  │────▶│  Reporter   │
│  (scripts)   │     │  (JSON files)│     │  (scheduled)│
└─────────────┘     └──────────────┘     └─────────────┘
       ▲                                        │
       │                                        ▼
┌─────────────┐                          ┌─────────────┐
│ Bot logs    │                          │ Engineering │
│ Container   │                          │ (Matrix)    │
│ stats       │                          └─────────────┘
│ MCP health  │
│ Reactions   │
└─────────────┘
```

**Design principles:**
- Scripts over services — health checks are scripts run on schedule, not a persistent daemon
- JSON files for state — no database, just structured JSON in `/workspace/extra/parker-persona/health/`
- Scheduled tasks for collection — use `mcp__nanoclaw__schedule_task` for periodic checks
- Matrix for reporting — post summaries to Engineering

## Cross-machine monitoring

Each machine runs its own bots. Parker can only directly measure the local machine. For remote machines:

1. Message a bot on the remote machine via Matrix
2. Ask it to run a health script and report results
3. Aggregate results locally

Protocol: structured JSON in Matrix messages, parseable by both humans and bots.

## Implementation phases

### Phase 1: Local instrumentation
- [ ] Container stats polling script (RSS, CPU, restart count)
- [ ] Log parser for OOM/crash events
- [ ] MCP proxy health checker
- [ ] Lobe availability tester
- [ ] Session file size tracker

### Phase 2: Reporting
- [ ] Scheduled health check (every 5 min)
- [ ] Daily summary to Engineering
- [ ] Alert on OOM, restart loop, or lobe down

### Phase 3: Capability tracking
- [ ] Reaction parser for Matrix emoji scores
- [ ] Per-bot rolling score
- [ ] Weekly capability report

### Phase 4: Cross-machine
- [ ] Health request/response protocol
- [ ] Remote bot health script
- [ ] Fleet-wide aggregation
