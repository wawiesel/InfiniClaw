# NEXT — Future Work

Items observed during operation. Operators: update continuously based on what's blocking progress.
Updated 2026-03-05T18:15Z.

## HIGH PRIORITY — Captain Directives (blocking progress)

- **Idle bots don't process queued messages**. Root cause: when a container goes idle (waitForIpcMessage), incoming messages just set a flag but never wake the container. Fix in `e1b369e` (idle-wake in group-queue.ts) deployed on Poseidon but NOT on HERACLES (git sync was broken). Cid is stuck idle since 18:09. **HERACLES needs to pull and rebuild.**
- **2-second ack** — implemented in `f28eb09` (👀 reaction + typing indicator). Cannot verify until Cid is responsive again.
- **Thread discipline** — implemented in `f28eb09`. Cannot verify until Cid is responsive.
- **CLAUDE.md should be overarching directives only** (Captain directive 18:00). Specific priorities go in NEXT.md. Bots should consult NEXT.md for what to work on. Implemented in `aec6912`.
- **Standing orders drift** — bots default to low-priority background work instead of Captain directives. Root: specific task lists in CLAUDE.md. Fixed by moving priorities to NEXT.md.
- **Matrix sluggish on Poseidon** (Captain report). Server responds <1ms locally — likely Element client or network.

## MEDIUM — Next Up

- **Cross-machine health monitoring** (Parker's primary mission). Build scripts to collect, aggregate, and report fleet health metrics across all machines. Metrics: container spawn times, exit codes, OOM kills, memory usage, session sizes, scheduled task success rates, bot uptime. Use Matrix intercom to request health reports from bots on other machines.
- **Gemini lobe delegation** (Captain directive). Not yet enabled. Verify API keys configured and lobe routing works.
- **Tool call breadcrumbs** (Captain idea). Tool calls should have single-line hash in Matrix, full content to S3. Any bot can download for detail.
- **Lobe delegation CWD too restrictive**. `delegate-runner.ts` only allows `/workspace/*` roots. Health scripts needing `/_runtime/` fail. Add runtime data paths to allowed roots.
- **Concurrency ceiling starvation**. When MAX_CONCURRENT_CONTAINERS reached, lower-priority bots starve. Need priority levels or reserved slots.

## LOW — Infrastructure

- Rename supervisor to "relay" — name conflicts with pm2. It's a message relay, not a process manager.
- Supervisor can't process `!restart`/`!join` sent via its own intercom account (ignores own messages). Workaround: `pm2 restart` directly.
- ~~`npm run cli stop` hangs on S3 push~~ — fixed in `83ba947`, 30s timeout.
- Pre-push hook runs full type-check + tests twice when push is rejected by remote. Consider caching or skipping on immediate retry.

## LOW — Reliability

- **Max session age** — implemented in `1aa34a8`. Containers auto-recycle after `MAX_SESSION_AGE_MS` (default 8h). Prevents 65h+ stale sessions. Verify in production.
- Session OOM still possible — V8 heap OOM (exit 137) from large JSONL sessions. Agent-runner backup files (.claude/backups/) can restore old session IDs even after manual cleanup. Full cleanup chain: DB sessions table -> JSONL file -> .claude/backups/.
- Image hash cache files (`_runtime/data/image-hash-*`) prevent rebuild even when images are removed. Must delete hash files to force rebuild.
- Container exit 125 from missing agent-runner mount — partially fixed with `mountIfExists` but root cause (build context) should be revisited.
- Parker's scheduled task `ERR_SSL_PACKET_LENGTH_TOO_LONG` — should be fixed with `containerNetwork: "host"`, verify on next cron fire.
