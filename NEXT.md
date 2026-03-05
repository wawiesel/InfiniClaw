# NEXT — Future Work

Items observed during operation. Operators: update continuously based on what's blocking progress.
Updated 2026-03-05T19:52Z.

## HIGH PRIORITY — Captain Directives (blocking progress)

- **Rolling health metrics** — Captain wants 1-day and 7-day rolling metrics as the key numbers, not cumulative. `health-check.sh` now computes rolling deltas from JSONL history. Need more snapshot collection time to show meaningful data.

## MEDIUM — Next Up

- **Cross-machine health monitoring** (Parker's primary mission). Build scripts to collect, aggregate, and report fleet health metrics across all machines. Metrics: container spawn times, exit codes, OOM kills, memory usage, session sizes, bot uptime.
- **Gemini lobe delegation** (Captain directive). No `GOOGLE_API_KEY` found in any bot's env file. Captain needs to provide a Gemini API key, then add `GOOGLE_API_KEY=...` to bot env files at `~/.config/infiniclaw/secrets/{bot}/env`. The delegate-runner spawns `@google/gemini-cli` which reads this env var.
- **Tool call breadcrumbs** (Captain idea). Tool calls should have single-line hash in Matrix, full content to S3.
- **Lobe delegation CWD too restrictive**. `delegate-runner.ts` only allows `/workspace/*` roots. Bots may try `/_runtime/` as CWD — should use `/workspace/extra/InfiniClaw/_runtime/` instead. May need bot education or a symlink inside the container.
- **Concurrency ceiling starvation**. When MAX_CONCURRENT_CONTAINERS reached, lower-priority bots starve.
- **Matrix sluggish on Poseidon** (Captain report). Server responds <1ms locally but conduwuit logs show 500 errors on federated rooms ("non-create event for room of unknown version") and UIAA auth errors. Contributing factor: status indicator spam — bots were editing room messages every 15s indefinitely (now throttled to stop after 5min). Consider leaving problematic federated rooms or upgrading conduwuit.

## LOW — Infrastructure

- **Supervisor deployment gotcha** — supervisor runs from `_runtime/instances/<first-bot>/dist/supervisor.js`, NOT from the project root `dist/`. After `npm run build` in the project root, you must also copy `dist/supervisor.js` to the instance dir or do a full `!restart` to trigger deploy. Operators: remember this when deploying supervisor changes.
- Rename supervisor to "relay" — name conflicts with pm2. It's a message relay, not a process manager.

## LOW — Reliability

- Session OOM still possible — V8 heap OOM (exit 137) from large JSONL sessions. Full cleanup chain: DB sessions table, JSONL file, .claude/backups/.
- Parker's scheduled task `ERR_SSL_PACKET_LENGTH_TOO_LONG` — should be fixed with `containerNetwork: "host"`, verify on next cron fire.

## Recently Completed

- Supervisor self-command fix — supervisor now processes `!restart`/`!join` sent via its own intercom account. Root cause was self-skip at line 641.
- Status indicator throttle — indicators stop editing after 5 minutes. Previously they edited the room message every 15s indefinitely, flooding rooms with hundreds of status edits per hour per bot.
- Dream period state machine — `032bef0`. IDLE→DREAMING→RECYCLING, deployed to instance dists.
- Supervisor heartbeat deployment — verified working on HERACLES.
- Thread discipline + 2-second ack — `f28eb09`. Reaction + typing indicator + lobe threading.
- Parker autonomous monitoring — SSL fixed (`containerNetwork: "host"`), health cron verified ✅.
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
