# 20 — Metrics

Good metrics for InfiniClaw answer three questions: **Is the fleet doing useful work? Is it reliable? Is it autonomous?** Each metric must have a clear good/bad threshold so you can look at a number and immediately know whether to act.

All rolling metrics use:
- **1d** — last 24 hours: how is today going?
- **7d** — last 7 days: is this a trend or a blip?

Snapshots (no suffix) are point-in-time values. All rates are per-day.

---

## Metric Taxonomy

Five categories. A mature fleet scores well on all five. A fleet in crisis will lag on one or more.

| Category | Question answered | Example |
|----------|------------------|---------|
| **Productivity** | Are bots getting work done? | messages/day, token I/O |
| **Quality** | Is the work good? | score/day, branch success % |
| **Responsiveness** | How fast do bots react? | response latency p50/p95 |
| **Reliability** | Are bots stable and available? | uptime %, crash rate |
| **Autonomy** | Does the fleet need humans? | interventions/day |

---

## Productivity — Is the fleet doing work?

| Metric | Formula | Good | Alarm | Status |
|--------|---------|------|-------|--------|
| **Messages/day** | Bot replies sent per day | > 5/day | 0/day (silent bot) | ✅ Tracked |
| **Token throughput** | (input + output tokens) / day | Increasing | Sudden drop | 🔲 Planned |
| **Score** | Net reaction points/day: 👍=+1, 💯=+3, 👎=−1, ❌=−3 | > 0 | < −2/day | ✅ Tracked |
| **Task completion** | Todos resolved / todos created per day | > 80% | < 50% | 🔲 Planned |
| **Branch brain success** | % of branch brain sessions with output (not error/timeout) | > 80% | < 50% | ✅ Tracked |

**Token throughput** is the raw measure of how much thinking the fleet is doing. A bot sending 5-word replies has low token throughput. A bot doing deep code analysis has high throughput. A sudden drop means a bot is idle or broken. Source: session JSONL usage fields.

**Score** is the Captain's subjective quality rating. It is the only metric that directly measures whether the work was good, not just that work happened.

**Task completion** tracks whether bots finish what they start. Source: Claude Code todos JSON from session files.

---

## Reliability — Is the fleet stable?

| Metric | Formula | Good | Alarm | Status |
|--------|---------|------|-------|--------|
| **Relay uptime %** | % of last 24h relay was running (approx: current uptime / 86400s) | 100% (1d) | < 90% | ✅ Tracked (approx) |
| **Response latency** | p50/p95 time from Captain mention to first bot reply | < 30s p50 | > 2min p95 | 🔲 Planned |
| **Crashes/day** | PM2 restart count per day | 0 | > 2/day | ✅ Tracked |
| **OOM kills/day** | Container killed by memory limit per day | 0 | Any | ✅ Tracked |
| **SIGKILL/day** | Forced process termination per day | 0 | > 0 | ✅ Tracked |
| **RSS / limit** | Current RSS vs container memory cap (snapshot) | < 80% | > 90% | ✅ Tracked |

**Relay uptime %** is approximated as `min(uptimeSeconds, 86400) / 86400 × 100`. If the relay has been continuously running for 22h, that's 92%. If it just restarted, it's near 0%. Displayed as `up 91% (1d)` in `!metrics`. This understates reliability if the relay restarts quickly, but a low % always means something went wrong recently. The precise implementation (recording stop/start timestamps) is planned — see below.

**Response latency** measures the user experience — how long does the Captain wait? A bot that's running but slow to respond is as useless as one that's down. Source: relay tracks the delta between curtainLoop event timestamp and first bot reply.

**RSS / limit** is the primary memory health signal. A bot at 90% of its container limit is one large context operation away from an OOM kill. The fleet-level total RSS shows aggregate memory consumption across all ships.

---

## Autonomy — Is the fleet self-managing?

| Metric | Formula | Good | Alarm | Status |
|--------|---------|------|-------|--------|
| **Interventions/day** | `@operator` messages outside BehindTheCurtain | 0 | > 3/day | ✅ Tracked |
| **Autonomy score** | 100 − (interventions × 10) − (crashes × 5), clamped 0–100 | 100 | < 50 | ✅ Tracked |
| **MTBI** | Mean time between interventions | Increasing | < 1h | 🔲 Planned |
| **Self-recovery rate** | Crashes resolved without operator action / total crashes | 100% | < 80% | 🔲 Planned |

**Interventions/day** is the single most important metric. Each one means the fleet couldn't handle something on its own. Target is zero. An intervention-free day means the fleet ran itself.

**Autonomy score** formula: `100 − (interventions × 10) − (crashes × 5)`. Score of 100 = fully autonomous. Score of 80 = 2 crashes (normal during development). Score of 50 = 5 interventions or 10 crashes. Score below 20 = crisis. Note: heavy operator sessions (bootstrap, debugging) will drive this down — use 7d window for trend.

**MTBI** (Mean Time Between Interventions) is the complement of interventions/day — it answers "how long can the fleet run itself?" A MTBI of 3 days is much better than 3 hours. Requires timestamp tracking per intervention event.

---

## Infrastructure — Is the platform stable?

| Metric | Formula | Good | Alarm | Status |
|--------|---------|------|-------|--------|
| **Relay restarts** | PM2 restarts per day (1d / 7d) | 0 | > 5/day | ✅ Tracked |
| **Sync failures** | Failed git pulls + build failures per day | 0 | > 2/day | ✅ Tracked |
| **Fleet RSS** | Total RSS across all bot containers (snapshot) | < 2GB fleet total | > 4GB | ✅ Tracked |

**Relay restarts**: 0–2/day from `!pull` is normal during active development. > 5/day suggests the relay is crash-looping. Note: PM2 only tracks cumulative restarts; rolling counts are approximate (see Accuracy Notes below).

**Sync failures** include git pull failures and TypeScript build failures. Every `⚠️ code build down` alert becomes a count here. Zero is the target.

**Fleet RSS** is total RAM consumed by all bot containers right now. < 2GB for a 4-bot fleet is normal. Growing fleet RSS means bots are accumulating context; OOM kills will follow.

---

## Displaying Metrics

The `!metrics` output uses the **medium** verbosity of the [unified display format](05-bot.md#unified-display-format):

```
🦁Herc · 🏅1 · up 91% (1d) · ↻2/5 · sync OK
  ├ 🦁⚙️·🟢🔥·Cid·⚙️⭐ · mem 120/512MB · SK+0 OOM+0 (1d)
  └ 🦁⚙️·🟢·Norm·💬🥈 · mem 98/512MB  · SK+0 OOM+0 (1d)

Fleet · 2 ships · avail 100% · autonomy 85% (1d) · OOM+0 (24h) · RSS 218MB
Operator · interventions 0/day (1d) · x-cmds 2/day (1d)
```

| Field | Meaning | Good | Bad |
|-------|---------|------|-----|
| `↻2/5` | Relay restarts: 2 today, 5 this week | 0/0 | > 5/day |
| `mem 120/512MB` | Current RSS / container limit — how close to OOM? | < 80% | > 90% |
| `SK+0 OOM+0 (1d)` | Process kills today (hidden when both zero) | 0 | Any |
| `avail 100%` | All active bots have running processes | 100% | < 90% |
| `autonomy 85% (1d)` | Fleet self-managed 85% — 1 crash or ~1 intervention | 100% | < 50% |
| `OOM+0 (24h)` | No memory kills today | 0 | Any |
| `RSS 218MB` | Total container RAM in use fleet-wide | < 2GB | > 4GB |
| `interventions 0/day` | No operator interventions today | 0 | > 3/day |

---

## Planned Metrics (Not Yet Implemented)

> **Status:** The metrics below are designed and specified but not yet implemented. They require additional data collection in the relay or bot runtime.

### Token Throughput

Track `(input_tokens + output_tokens)` per bot per day from session JSONL files. Collected by the health check script reading Claude Code session files. Published alongside RSS in the S3 health report.

- **> 50K tokens/day** = active bot
- **< 5K tokens/day** = idle or broken
- **Sudden drop** = bot may be stuck or sleeping unexpectedly

### Response Latency

The relay records a timestamp when a Captain message enters a bot's context (👀 reaction), and another when the bot's reply is sent (🔔 reaction). Delta = response latency.

- **p50 < 30s** = normal for a working bot
- **p95 > 2min** = bot is struggling (large context, slow model, stuck)
- Display as `lat 12s p50 · 45s p95 (1d)` per bot in `!metrics`

### Task Completion Rate

Read Claude Code todos JSON from `_runtime/instances/{bot}/data/sessions/main/.claude/todos/`. Track resolved vs created counts per day.

- **> 80%** = bot is finishing what it starts
- **< 50%** = bot is accumulating work debt or not prioritizing

### Mean Time Between Interventions (MTBI)

Timestamp each intervention event. Compute average gap between consecutive interventions in the 7d window.

- **> 24h** = fleet is largely autonomous
- **< 1h** = operator is fire-fighting

---

## Accuracy Notes

- **Restart approximation**: PM2 only tracks cumulative restarts, not per-event timestamps. Rolling counts use an approximation: if the process started within the window, all restarts are counted as in-window. If running longer than the window, count shows 0 until next restart.
- **Uptime % approximation**: `min(uptimeSeconds, 86400) / 86400`. Underestimates stability if relay restarts briefly multiple times. Overestimates if relay crashed and stayed down but just recovered.
- **Sync failures**: Counted per `reportFailure()` call — a build that fails 3× in one day counts as 3.
- **Interventions**: Counted from relay's `backfillOperatorEvents()` on startup plus in-memory accumulation. Accuracy depends on Matrix history availability.

---

## Alerting

> **Status:** Designed, not yet implemented.

Priority order:
1. Availability < 90% — bots are down
2. OOM kills > 0 — memory pressure (any OOM is bad)
3. Sync failures > 2/day — infrastructure degraded
4. Response latency p95 > 2min — bots are slow
5. Autonomy score < 50 (1d) — heavy intervention required
6. RSS > 90% of limit per bot — OOM imminent
7. Score < −2/day — Captain disapproves of output
