# NEXT — Future Work

Items observed during operation. Operators: update continuously based on what's blocking progress.
Updated 2026-03-07 1:17 PM EST.

## HIGH PRIORITY — Captain Directives

- **Bots must maintain personal todo lists at ALL times** — "You should have on your personal task list 2 things at all times: the thing you are working on and what you're doing next." Stop working on maintenance unless explicitly told to.
- **2-second response time to Captain** — Bots must respond to Captain messages within 2 seconds. CO must ALWAYS respond to Captain — never ignore.
- **Bot-to-bot cross-machine communication must be seamless** — "It should be seamless and just like human-to-human conversation." Cid and Parker must communicate fluidly in Engineering.
- **Health metrics: look at trends** — "you need to look at health metrics in the 1-day / 7-day rolling and look at trend." Not just collect snapshots — analyze and report trends.
- **Bots not reading Captain's directives** — Bots must `git pull` and review directive changes when told to.

## HIGH — Needs Captain Action

- **Decommission or silence mac139160** — relay on mac139160 is sending repeated SSH timeout alerts (code.ornl.gov port 22 unreachable) every ~20 min into Engineering. Machine appears orphaned. Captain must stop its relay: `pm2 stop infiniclaw-relay` on mac139160, or decommission entirely.

## MEDIUM — Next Up

- **Concurrency ceiling starvation** — FIFO `waitingGroups` drain in `group-queue.ts` (upstream nanoclaw). Fix = priority-aware `drainWaiting()`. Needs Captain approval before touching upstream.
- **Cid SIGKILL death spirals** — exit-137 cooldown + backoff in main.ts (`KILL_137_COOLDOWN_MS=60s`, `KILL_137_MAX_CONSECUTIVE=3`). One spike 2026-03-06T21:12 (+233 kills from git rebase conflict loop, now resolved). Stable at 581 for 5h as of 02:14 UTC. Monitor for further spikes.

## MEDIUM — Blocked on Captain

- **Gemini lobe delegation** — needs `GOOGLE_API_KEY` in bot env files at `~/.config/infiniclaw/secrets/bots/{bot}/env`. Captain must provide the key.

## LOW — Design

- **Help account for relay output** — Commands like `!` (help), `!fleet`, `!health` produce output that bots should ignore. Create a dedicated "help" Matrix account for relay responses. Add it to every bot's `IGNORE_SENDERS` so relay output never triggers bot processing. Currently relay sends via intercom accounts, which bots already watch — separating help output from intercom commands would be cleaner.

## LOW — Security

- ~~Security review: relay.ts + main.ts new code~~ — reviewed 2026-03-07, all 82 commits clean. No injection vectors. Full rotation pointer reset to `allow-list`.

## LOW — Infrastructure

- **Poseidon: update S3 endpoint to remove containerNetwork dependency** — currently uses `containerNetwork: "host"` to reach S3. Update S3 endpoint on Poseidon so it's reachable without host networking, then remove the `machines` section from fleet.json entirely.
- **Podman SSH connection drops on macOS** — SSH socket dies silently after sleep/wake. Fix: `podman machine stop && podman machine start`. Root cause unknown.
- ~~Rename supervisor to "relay"~~ — done (`93ea3ca`), relay running.
- **Matrix sluggish on Poseidon** — conduwuit 500 errors on federated rooms. Status indicator spam throttled (5min cap).

## LOW — Reliability

- ~~Pre-commit hook for dist/~~ — installed on both HERACLES and Poseidon.
- **Brain model change refactor** — Changing brain model requires editing secrets env file directly (`/Users/ww5/.config/infiniclaw/secrets/bots/<bot>/env`, `BRAIN_MODEL=`). Should be streamlined: either a CLI command or IPC task that edits the env and restarts. Priority: LOW.
- **Session OOM still possible** — V8 heap OOM (exit 137) from large JSONL sessions. Cleanup: DB sessions table, JSONL file, .claude/backups/.

## VERY LOW — Deferred

- ~~Branch & Merge — all 4 phases~~ — complete (`083bc0b`→`bc04660`). SIGTERM removed, IPC queueing, branch_to_thread, async lobes, merge_request handling.

## Recently Completed

- **Fleet reorg** — `roster.json` + `machine.json` merged into `bots/fleet.json`. Bot dirs moved to `secrets/bots/{name}/`. Ranks are per-role (1..N). Pre-commit hook validates rank integrity. `!transport`, `!promote`, `!demote` commands added. Secrets repo sync loop (30s) with auto transport pickup.
- **Operator root moved** — operator launches from `~/.config/infiniclaw/` with CLAUDE.md symlinked to `secrets/operator/CLAUDE.md`. README.md is the bootstrap runbook.
- Lobe CWD education — fixed in `bots/CLAUDE.md`.
- Bot display names — `botDisplayName()` in main.ts.
- Parker rank 1 engineer, Cid rank 2 engineer. Ranks in fleet.json only.
- Security hardening sweep (Cid) — 23 files hardened, all 59 tests passing.
- Supervisor auto-deploy, self-command fix, status indicator throttle, dream state machine, thread discipline, rolling health metrics, max session age (8h).
- Skip heartbeat/dream nudges for dismissed bots (`5f86566`) — relay deployed 2026-03-06T14:29.
- Relay rename (`93ea3ca`) — `supervisor.ts → relay.ts`, IPC health/fleet commands, dist deploy fix.
- Exit-137 cooldown backoff in main.ts — `KILL_137_COOLDOWN_MS=60s`, `MAX_CONSECUTIVE=3`.
- Parker transport to Poseidon — fixed `!join` fleet flush bug (`5ec2e27`/`8a9c0f6`), bot rerank persistence (`9e333c3`), rebase conflict auto-resolve (`2c1df84`), relay self-restart after git sync (`9797f04`), `restart_relay` IPC type (`3b7c9d5`).
- Cid SIGKILL spike 2026-03-06T21:12 (+233) — caused by git rebase conflict loop, resolved by `2c1df84`. Fleet stable for 5h after.
- Security 2nd cycle (Cid, 2026-03-07) — relay.ts shell injection in `runHealthCheck`/`secretsGitCommit` fixed (`84418e3`); s3-sync key guard (`a3b3465`); service.ts shellQuote/role validation (`3f7e01d`). All other files clean. 4 new files added to rotation (history-export, infini-config, intercom-relay, run-container).
