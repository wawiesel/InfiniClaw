# NEXT — Future Work

Items observed during operation. Operators: update continuously based on what's blocking progress.
Updated 2026-03-05 05:20 PM EST.

## HIGH PRIORITY — Captain Directives (blocking progress)

- **Bot display name format** — display names should follow `Name (location) 🔹` format, e.g. `Cid (HERACLES) ⭐`, `Parker (Poseidon) 🟢`. Needs update in container-config or bot profile.

## MEDIUM — Next Up

- **Rolling health metrics — need data accumulation**. Scripts are done (`health-check.sh` computes 24h/7d rolling deltas from JSONL history). Just needs more snapshot collection time for meaningful numbers. Passive wait.
- **Gemini lobe delegation** (Captain directive). Blocked: no `GOOGLE_API_KEY` in any bot's env file. Captain needs to provide a Gemini API key, then add `GOOGLE_API_KEY=...` to bot env files at `~/.config/infiniclaw/secrets/{bot}/env`.
- **Tool call breadcrumbs** (Captain idea). Tool calls should have single-line hash in Matrix, full content to S3.
- **Lobe delegation CWD too restrictive**. `delegate-runner.ts` only allows `/workspace/*` roots. Bots may try `/_runtime/` as CWD — should use `/workspace/extra/InfiniClaw/_runtime/` instead. May need bot education or a symlink inside the container.
- **Concurrency ceiling starvation**. When MAX_CONCURRENT_CONTAINERS reached, lower-priority bots starve.

## LOW — Infrastructure

- **Podman SSH connection drops on macOS** — Podman machine shows "Currently running" but SSH socket dies silently. Containers fail with "unable to connect to Podman socket". Fix: `podman machine stop && podman machine start` (may need a retry due to race condition). Root cause unknown — possibly long-running VM + sleep/wake cycles.
- Rename supervisor to "relay" — name conflicts with pm2. It's a message relay, not a process manager.
- **Matrix sluggish on Poseidon** (Captain report). conduwuit logs show 500 errors on federated rooms and UIAA auth errors. Status indicator spam now throttled (5min cap). Consider leaving problematic federated rooms or upgrading conduwuit.

## LOW — Reliability

- **Bots can commit dist/ files** — pre-commit hook added on HERACLES (`.git/hooks/pre-commit`). Blocks any commit with `dist/` staged. Note: `.git/hooks/` is not tracked by git — Poseidon needs the same hook installed manually.
- **Session OOM still possible** — V8 heap OOM (exit 137) from large JSONL sessions. Full cleanup chain: DB sessions table, JSONL file, .claude/backups/.

## Recently Completed

- Security hardening sweep (Cid) — systematic review across 23 source files (allow-list.ts through skill-sync.ts). Path traversal fixes, input validation, symlink escape prevention, HTML sanitization, command injection prevention, schema validation. 23 commits pushed, all 59 tests passing.
- Poseidon launchd check — Poseidon is Linux, no launchd agents. Clean.
- launchd zombie agents removed — old `com.infiniclaw.{bot}.plist` files with `KeepAlive: true` were fighting PM2, causing persistent duplicate processes. All launch agents deleted from HERACLES. MinIO also moved to Poseidon. See LESSONS_LEARNED.md.
- Supervisor auto-deploy — `gitSyncLoop` now copies `dist/supervisor.js` to all active bot instances after a successful build, so the supervisor picks up new code without needing a full `!restart`.
- Cross-machine health monitoring — verified. All 3 machines reporting to S3. `!health` aggregates fleet-wide.
- Health check liveness fix — `health-check.sh` now uses `podman ps` to detect running containers. Bots with containers show ACTIVE; stopped bots show IDLE/RECENT/STALE based on log freshness. Previously healthy bots with no recent errors appeared STALE.
- Supervisor self-command fix — supervisor now processes `!restart`/`!join` sent via its own intercom account.
- Status indicator throttle — indicators stop editing after 5 minutes.
- Dream period state machine — `032bef0`. IDLE→DREAMING→RECYCLING.
- Thread discipline + 2-second ack — `f28eb09`.
- Parker autonomous monitoring — SSL fixed (`containerNetwork: "host"`), health cron verified.
- Rolling health metrics — `health-check.sh` reports 24h/7d rolling deltas from JSONL history.
- Max session age (8h) — `1aa34a8`. Containers auto-recycle via `MAX_SESSION_AGE_MS`.
