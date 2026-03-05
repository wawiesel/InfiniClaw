# NEXT — Future Work

Items observed during operation. Operators: update continuously based on what's blocking progress.
Updated 2026-03-05T18:25Z.

## HIGH PRIORITY — Captain Directives (blocking progress)

- **Bots go silent for minutes** — Captain asked "are you working?" and got no response for 10+ minutes. Root cause: idle containers don't receive queued messages. Idle-wake fix (`e1b369e`) deployed on Poseidon, but HERACLES container needs restart to pick it up. Even with the fix, bots have no autonomous work mechanism — they only respond to incoming messages.
- **Thread discipline** — implemented in `f28eb09` — needs verification (Cid hasn't handled a thread interaction since restart).
- **Parker autonomous monitoring** — idle container wakeup fixed in `e1b369e`. Still needed: periodic heartbeat so Parker can do proactive health work without external trigger. Parker's scheduled health check cron fires hourly but SSL errors prevented execution — should work now with `containerNetwork: "host"`.
- **Matrix sluggish on Poseidon** (Captain report). Server responds <1ms locally — likely Element client or network.

## MEDIUM — Next Up

- **Cross-machine health monitoring** (Parker's primary mission). Build scripts to collect, aggregate, and report fleet health metrics across all machines. Metrics: container spawn times, exit codes, OOM kills, memory usage, session sizes, bot uptime.
- **Gemini lobe delegation** (Captain directive). Not yet enabled. Verify API keys configured and lobe routing works.
- **Tool call breadcrumbs** (Captain idea). Tool calls should have single-line hash in Matrix, full content to S3. Any bot can download for detail.
- **Lobe delegation CWD too restrictive**. `delegate-runner.ts` only allows `/workspace/*` roots. Health scripts needing `/_runtime/` fail. Add runtime data paths to allowed roots.
- **Concurrency ceiling starvation**. When MAX_CONCURRENT_CONTAINERS reached, lower-priority bots starve. Need priority levels or reserved slots.

## LOW — Infrastructure

- Rename supervisor to "relay" — name conflicts with pm2. It's a message relay, not a process manager.
- Supervisor can't process `!restart`/`!join` sent via its own intercom account (ignores own messages). Workaround: `pm2 restart` directly.

## LOW — Reliability

- Session OOM still possible — V8 heap OOM (exit 137) from large JSONL sessions. Agent-runner backup files (.claude/backups/) can restore old session IDs even after manual cleanup. Full cleanup chain: DB sessions table -> JSONL file -> .claude/backups/.
- Container exit 125 from missing agent-runner mount — partially fixed with `mountIfExists` but root cause (build context) should be revisited.
- Parker's scheduled task `ERR_SSL_PACKET_LENGTH_TOO_LONG` — should be fixed with `containerNetwork: "host"`, verify on next cron fire.

## Recently Completed

- S3 push timeout — 30s timeout in `stop()` prevents hanging. Fixed independently by both Albert and Operator.
- Max session age limit (8h default) — `1aa34a8`. Containers auto-recycle via `MAX_SESSION_AGE_MS`.
- 2-second trigger ack — `f28eb09`. Reaction + typing indicator on trigger.
- Pre-push hook cache — `.git/hooks/pre-push` caches by commit hash (5min TTL). Local-only, replicate on other machines.
- Standing orders drift — reprioritized Cid CLAUDE.md in `08eb197`. Captain directives first.
- CLAUDE.md directive separation — `aec6912`. Specific priorities moved to NEXT.md.
- Message-filtering regex fix — `a7ee61f`. lastIndex reset, type guard, expanded pattern.
- Idle container wakeup — `e1b369e`. Containers now wake for pending messages/tasks.
- Image hash cache fix — `5887d63`. Checks `podman image exists` before trusting cache.
