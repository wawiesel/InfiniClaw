# NEXT — Future Work

Items observed during operation. Operators: update continuously based on what's blocking progress.
Updated 2026-03-06 08:45 AM EST.

## HIGH PRIORITY — Captain Directives

- **Bots must maintain personal todo lists at ALL times** — "You should have on your personal task list 2 things at all times: the thing you are working on and what you're doing next." Stop working on maintenance unless explicitly told to.
- **2-second response time to Captain** — Bots must respond to Captain messages within 2 seconds. CO must ALWAYS respond to Captain — never ignore.
- **Bot-to-bot cross-machine communication must be seamless** — "It should be seamless and just like human-to-human conversation." Cid and Parker must communicate fluidly in Engineering.
- **Health metrics: look at trends** — "you need to look at health metrics in the 1-day / 7-day rolling and look at trend." Not just collect snapshots — analyze and report trends.
- **Bots not reading Captain's directives** — Bots must `git pull` and review directive changes when told to.

## HIGH — Needs Restart

These features are committed but not yet active on running bots:
- **Tool call breadcrumbs** (`4c7a968`) — single-line hash in Matrix, full HTML to S3
- **Bot display names** (`37fee0e`) — `Name (HOSTNAME)` with CO/active/offline badges
- **Rerank fix** (`918e2b7`) — `restarted` msg includes `(rank N)`
- **Bare `!` help** (`e095361`) — lists all operator commands
- **Fleet reorg** — `machine.json` eliminated, `fleet.json` is single source of truth, new commands: `!transport`, `!promote`, `!demote`
- **Secrets repo sync loop** — 30-second pull/push cycle with transport pickup

## MEDIUM — Next Up

- **Concurrency ceiling starvation** — FIFO `waitingGroups` drain in `group-queue.ts` (upstream nanoclaw). Fix = priority-aware `drainWaiting()`. Needs Captain approval before touching upstream.
- **Cid SIGKILL death spirals** — Extended periods of SIGKILL loops (duplicate processes, podman EOF, session OOM). Need better resilience: faster detection, cooldown backoff, session clearing on repeated OOM.

## MEDIUM — Blocked on Captain

- **Gemini lobe delegation** — needs `GOOGLE_API_KEY` in bot env files at `~/.config/infiniclaw/secrets/bots/{bot}/env`. Captain must provide the key.

## LOW — Infrastructure

- **Poseidon: update S3 endpoint to remove containerNetwork dependency** — currently uses `containerNetwork: "host"` to reach S3. Update S3 endpoint on Poseidon so it's reachable without host networking, then remove the `machines` section from fleet.json entirely.
- **Podman SSH connection drops on macOS** — SSH socket dies silently after sleep/wake. Fix: `podman machine stop && podman machine start`. Root cause unknown.
- Rename supervisor to "relay" — name conflicts with pm2.
- **Matrix sluggish on Poseidon** — conduwuit 500 errors on federated rooms. Status indicator spam throttled (5min cap).

## LOW — Reliability

- **Pre-commit hook for dist/** — installed on HERACLES. Poseidon needs same hook.
- **Session OOM still possible** — V8 heap OOM (exit 137) from large JSONL sessions. Cleanup: DB sessions table, JSONL file, .claude/backups/.

## Recently Completed

- **Fleet reorg** — `roster.json` + `machine.json` merged into `bots/fleet.json`. Bot dirs moved to `secrets/bots/{name}/`. Ranks are per-role (1..N). Pre-commit hook validates rank integrity. `!transport`, `!promote`, `!demote` commands added. Secrets repo sync loop (30s) with auto transport pickup.
- **Operator root moved** — operator launches from `~/.config/infiniclaw/` with CLAUDE.md symlinked to `secrets/operator/CLAUDE.md`. README.md is the bootstrap runbook.
- Lobe CWD education — fixed in `bots/CLAUDE.md`.
- Bot display names — `botDisplayName()` in main.ts.
- Parker rank 1 engineer, Cid rank 2 engineer. Ranks in fleet.json only.
- Security hardening sweep (Cid) — 23 files hardened, all 59 tests passing.
- Supervisor auto-deploy, self-command fix, status indicator throttle, dream state machine, thread discipline, rolling health metrics, max session age (8h).
