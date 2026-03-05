# NEXT — Future Work

Items observed during operation. Operators: update continuously based on what's blocking progress.
Updated 2026-03-05 06:10 PM EST.

## HIGH PRIORITY — Captain Directives (from Engineering conversation review)

- **Bots must maintain personal todo lists at ALL times** — Captain: "You should have on your personal task list 2 things at all times: the thing you are working on and what you're doing next." Bots are wasting time on maintenance instead of assigned tasks. Stop working on maintenance unless explicitly told to.
- **2-second response time to Captain** — Captain explicitly called this out as an activity. Bots must respond to Captain messages within 2 seconds. CO must ALWAYS respond to Captain — never ignore.
- **Tool call breadcrumbs** ✅ — Implemented `4c7a968`: single-line `🔧 Name · hash` in Matrix, full HTML to S3 under `tool-calls/{bot}/{ts}-{hash}.html`. Needs restart to activate.
- **Bot display names still not showing** — Code committed (`37fee0e`). Rerank fix also committed (`918e2b7`): `restarted` supervisor msg now includes `(rank N)` — prevents wrong bot stealing ⭐ on restart. Both need restart to activate.
- **Bot-to-bot cross-machine communication must be seamless** — Captain: "It should be seamless and just like human-to-human conversation." Cid and Parker must communicate fluidly in Engineering.
- **Health metrics: look at trends** — Captain: "you need to look at health metrics in the 1-day / 7-day rolling and look at trend." Not just collect snapshots — analyze and report trends.
- **Bots not reading Captain's directives** — Captain updated main and engineer CLAUDE.md directives (commit `8b75*`). Asked bots to pull and review. Bots didn't read them, leading to Captain frustration. Bots must `git pull` and review directive changes when told to.
- **Duplicate bot instances** — Two Parkers were running (one on mac139160, one on Poseidon). Fixed on Poseidon (machine.json trimmed). mac139160 Parker needs `!dismiss parker`. HERACLES machine.json also trimmed to `["cid"]` only.

## MEDIUM — Next Up

- **Concurrency ceiling starvation**. FIFO `waitingGroups` drain in `group-queue.ts` (upstream nanoclaw). Active groups hog slots across rapid messages; waiting groups queue fairly but can lag. Fix = priority-aware `drainWaiting()`. Needs Captain approval before touching upstream.
- **Cid SIGKILL death spirals** — Extended periods of SIGKILL loops (duplicate processes, podman EOF, session OOM). Need better resilience: faster detection of unrecoverable state, cooldown backoff, session clearing on repeated OOM.

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
