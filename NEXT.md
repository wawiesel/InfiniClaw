# NEXT — Future Work

Items observed during operation. Operators: update continuously based on what's blocking progress.
Updated 2026-03-05T19:05Z.

## HIGH PRIORITY — Captain Directives (blocking progress)

- **Dream period** (Captain directive). Before recycling, bots get a 30-minute "dream" period to review room history, collapse memories, optimize instructions/standing orders, and prepare for a fresh start. **Scheduling rules** (all configurable via env vars): (1) **Never more than one bot dreaming at a time** — supervisor coordinates fleet-wide. (2) **Activity-based trigger** — supervisor schedules a dream when a bot has been running >MIN_SESSION_AGE_MS (default 6h) AND has no pending tasks for the next 30 minutes. The hard max MAX_SESSION_AGE_MS (default 8h) forces a dream regardless. (3) **Supervisor-driven** — the supervisor owns dream scheduling, not the bot. It tracks each bot's session age and idle state, picks the best candidate, sends a "dream" prompt via IPC, waits for completion, then allows the next bot to dream. Implementation: add dream state machine to supervisor (IDLE→DREAMING→RECYCLING). Config env vars: `MIN_DREAM_AGE_MS`, `MAX_SESSION_AGE_MS`, `DREAM_DURATION_MS`.
- **Bots have no autonomous work mechanism** — they only respond to incoming messages. Need a heartbeat or scheduled task for proactive work without external trigger.
- **Thread discipline** — implemented in `f28eb09` — needs verification in practice.
- **Parker autonomous monitoring** — idle-wake deployed. Parker's scheduled health cron fires hourly but SSL errors prevented execution — should work now with `containerNetwork: "host"`. Verify.
- **Rolling health metrics** — Captain wants 1-day and 7-day rolling metrics as the key numbers, not cumulative. `health-check.sh` now computes rolling deltas from JSONL history. Need more snapshot collection time to show meaningful data.

## MEDIUM — Next Up

- **Cross-machine health monitoring** (Parker's primary mission). Build scripts to collect, aggregate, and report fleet health metrics across all machines. Metrics: container spawn times, exit codes, OOM kills, memory usage, session sizes, bot uptime.
- **Gemini lobe delegation** (Captain directive). No `GOOGLE_API_KEY` found in any bot's env file. Captain needs to provide a Gemini API key, then add `GOOGLE_API_KEY=...` to bot env files at `~/.config/infiniclaw/secrets/{bot}/env`. The delegate-runner spawns `@google/gemini-cli` which reads this env var.
- **Tool call breadcrumbs** (Captain idea). Tool calls should have single-line hash in Matrix, full content to S3.
- **Lobe delegation CWD too restrictive**. `delegate-runner.ts` only allows `/workspace/*` roots. Health scripts needing `/_runtime/` fail.
- **Concurrency ceiling starvation**. When MAX_CONCURRENT_CONTAINERS reached, lower-priority bots starve.
- **Matrix sluggish on Poseidon** (Captain report). Server responds <1ms locally but conduwuit logs show 500 errors on federated rooms ("non-create event for room of unknown version") and UIAA auth errors. Contributing factor: status indicator spam — bots were editing room messages every 15s indefinitely (now throttled to stop after 5min). Consider leaving problematic federated rooms or upgrading conduwuit.

## LOW — Infrastructure

- Rename supervisor to "relay" — name conflicts with pm2. It's a message relay, not a process manager.
- Supervisor can't process `!restart`/`!join` sent via its own intercom account (ignores own messages at line 614). Root cause: supervisor and intercom-send share same Matrix account. Workaround: `pm2 restart` directly.

## LOW — Reliability

- Session OOM still possible — V8 heap OOM (exit 137) from large JSONL sessions. Full cleanup chain: DB sessions table, JSONL file, .claude/backups/.
- Parker's scheduled task `ERR_SSL_PACKET_LENGTH_TOO_LONG` — should be fixed with `containerNetwork: "host"`, verify on next cron fire.

## Recently Completed

- Status indicator throttle — indicators stop editing after 5 minutes. Previously they edited the room message every 15s indefinitely, flooding rooms with hundreds of status edits per hour per bot.
- Rolling health metrics — `health-check.sh` reports 24h/7d rolling deltas from JSONL history.
- S3 push timeout — 30s timeout in `stop()`.
- Max session age (8h) — `1aa34a8`. Containers auto-recycle via `MAX_SESSION_AGE_MS`.
- 2-second trigger ack — `f28eb09`. Reaction + typing indicator.
- Pre-push hook cache — commit hash TTL (5min). Local-only.
- Standing orders reprioritized — `08eb197`. Captain directives first.
- CLAUDE.md/NEXT.md separation — `aec6912`.
- Message-filtering regex fix — `a7ee61f`.
- Idle container wakeup — `e1b369e`.
- Image hash cache fix — `5887d63`. Checks image existence.
- Container exit 125 — mitigated with `mountIfExists`.
