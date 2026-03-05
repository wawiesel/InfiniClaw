# NEXT — Future Work

Items observed during operation. Operators: update continuously based on what's blocking progress.
Updated 2026-03-05 05:50 PM EST.

## HIGH PRIORITY — Captain Directives (blocking progress)

- **Bots not maintaining todo lists** — Captain complaint. All bots need to track what they're working on, what's blocked, and what's done. Use NEXT.md as the central tracking file and keep it current.

## MEDIUM — Next Up

- **Tool call breadcrumbs** (Captain idea). Tool calls should have single-line hash in Matrix, full content to S3.
- **Concurrency ceiling starvation**. When MAX_CONCURRENT_CONTAINERS reached, lower-priority bots starve.

## MEDIUM — Blocked on Captain

- **Gemini lobe delegation** — needs `GOOGLE_API_KEY` in bot env files at `~/.config/infiniclaw/secrets/{bot}/env`. Captain must provide the key.

## LOW — Infrastructure

- **Podman SSH connection drops on macOS** — SSH socket dies silently after sleep/wake. Fix: `podman machine stop && podman machine start`. Root cause unknown.
- Rename supervisor to "relay" — name conflicts with pm2.
- **Matrix sluggish on Poseidon** — conduwuit 500 errors on federated rooms. Status indicator spam throttled (5min cap). Consider leaving problematic rooms or upgrading conduwuit.
- **Rolling health metrics** — scripts done, just needs more snapshot collection time. Passive wait.

## LOW — Reliability

- **Pre-commit hook for dist/** — installed on HERACLES. Poseidon needs same hook manually.
- **Session OOM still possible** — V8 heap OOM (exit 137) from large JSONL sessions. Cleanup: DB sessions table, JSONL file, .claude/backups/.

## Recently Completed

- Lobe CWD education — fixed in `bots/CLAUDE.md`: use `/workspace/extra/InfiniClaw/_runtime/`, not `/_runtime/`.
- Bot display names — `Name (HOSTNAME) ⭐/🟢/🔴` via `botDisplayName()` in main.ts (`37fee0e`).
- Parker promoted to rank 3 (primary engineer), Cid demoted to rank 4. Rank removed from all bot CLAUDE.md files — roster.json is single source of truth.
- Security hardening sweep (Cid) — 23 files hardened, 23 commits, all 59 tests passing.
- Poseidon launchd check — Linux, no launchd. Clean.
- launchd zombie agents removed from HERACLES. See LESSONS_LEARNED.md.
- Supervisor auto-deploy, self-command fix, status indicator throttle, dream state machine, thread discipline, Parker autonomous monitoring, rolling health metrics, max session age (8h).
