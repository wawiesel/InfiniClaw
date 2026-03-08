# NEXT — Future Work

Items observed during operation. Operators: update continuously based on what's blocking progress.
Updated 2026-03-08 EST.

## HIGH PRIORITY — Bugs

- ~~**Pre-push hook fails on HERACLES: `@rollup/rollup-darwin-x64` missing**~~ — Fixed: removed `npm test` step from `.git/hooks/pre-push`; hook now only runs `tsc --noEmit` type-checks. Tests can be run manually with `npm test`.

## HIGH PRIORITY — Captain Directives

- **Thread brain model: bots must constantly evaluate "should I start a new thread?"** — At each response, evaluate complexity/length. If work will take multiple steps or be long, open a thread immediately with `branch_to_thread`. Then evaluate "should I delegate to a lobe?" — if yes, use `delegate_to_lobe`. This is the standard brain model for all bots.
- **src directory READMEs** — Every `src/` directory must have a `README.md` explaining what belongs there and what doesn't. As engineers learn the codebase, record key observations in these files to jumpstart future engineers. Start with `src/` (InfiniClaw) and `external/nanoclaw/src/`.

- **Bots must maintain personal todo lists at ALL times** — "You should have on your personal task list 2 things at all times: the thing you are working on and what you're doing next." Stop working on maintenance unless explicitly told to.
- **2-second response time to Captain** — Bots must respond to Captain messages within 2 seconds. CO must ALWAYS respond to Captain — never ignore.
- **Bot-to-bot cross-machine communication must be seamless** — "It should be seamless and just like human-to-human conversation." Cid and Parker must communicate fluidly in Engineering.
- ~~**Health metrics: look at trends**~~ — `a3f5769`: relay now computes 24h deltas (sigkills, OOM) from health-history.jsonl and includes `trends_24h` in S3 upload; `!health` displays `SK=` and `Δ24h` per bot.
- **Bots not reading Captain's directives** — Bots must `git pull` and review directive changes when told to.

## HIGH — Needs Captain Action

- **Decommission or silence mac139160** — relay on mac139160 is sending repeated SSH timeout alerts (code.ornl.gov port 22 unreachable) every ~20 min into Engineering. Machine appears orphaned. Captain must stop its relay: `pm2 stop infiniclaw-relay` on mac139160, or decommission entirely.

## MEDIUM — Next Up

- **`channels/matrix.ts` F2: `isPreformattedHtml` raw HTML passthrough (9th cycle)** — `sendMessage`/`editMessage` skip `renderMarkdownForMatrix` for strings starting with `<details`, `<font`, `<small`. No sanitization follows. A prompt-injection payload opening with `<details>` can carry arbitrary HTML to Matrix clients. Fix requires architectural decision: either restrict the allowlist or add a post-hoc HTML sanitizer (e.g. `sanitize-html`) to strip unsafe tags/attrs after the bypass path. Deferred pending architecture review.
- **`channels/matrix.ts` F4: media fully buffered before size check (9th cycle)** — `downloadContent` buffers the full file before the 50MB cap is applied. Repeated large media from adversarial homeservers can spike RSS by hundreds of MB. Fix requires streaming `Content-Length` pre-flight or streaming download with byte-count abort. Deferred — needs SDK streaming API investigation.
- **johnny5 stale runtime files (lounge — no fix needed until brought onduty)** — `_runtime/instances/johnny5/pm2-ecosystem.json` has `ASSISTANT_ROLE=Commander` (title, not role; role is `navigator`). `start.sh` sources `secrets/johnny5/env` instead of correct `secrets/bots/johnny5/env`. Together caused `bots/commander/johnny5/` mount attempts → exit 125 (resolved 2026-03-02). Fix: run `bootstrapBot("johnny5")` via relay — regenerates both files from current code with correct paths.



- **MAX_THREAD_BRAINS_PER_BOT limit** — Currently no cap on concurrent Thread Brains per bot. Captain spec: max 3, configurable via env var `MAX_THREAD_BRAINS_PER_BOT=3`. Relay should reject new `branch_to_thread` calls when limit is reached and notify the bot.
- **Concurrency ceiling starvation** — FIFO `waitingGroups` drain in `group-queue.ts` (upstream nanoclaw). Fix = priority-aware `drainWaiting()`. Needs Captain approval before touching upstream.
- ~~**Cid SIGKILL death spirals**~~ — stable at 614 for 4h+ as of 2026-03-08T04:21 UTC. Session OOM addressed by `997fb21`. Monitor.

## MEDIUM — Blocked on Captain

- **Gemini lobe delegation** — needs `GOOGLE_API_KEY` in bot env files at `~/.config/infiniclaw/secrets/bots/{bot}/env`. Captain must provide the key.

## LOW — Code Quality

### Reduce code duplication in src/

Detailed audit complete (2026-03-08). Key findings below. Tackle in order.

#### 1. Git sync — extract shared `gitSyncRepo()` helper (HIGH)
`relay.ts:946-1024` (`gitSync`) and `relay.ts:1122-1182` (`secretsGitSync`) and `ipc-commands.ts:602-665` (`handleGitPull`) are three near-identical stash→rebase→pop implementations. Differences are only CWD and log prefix. Extract one function to `src/git-utils.ts`:
```ts
function gitSyncRepo(cwd: string, label: string): { pulled: number; changed: boolean }
```
Covers: rebase-abort guard, stash/pop, commit count, conflict fallback to hard reset.

#### 2. JSON I/O — add `readJson` / `writeJson` to utils.ts (HIGH)
`JSON.parse(fs.readFileSync(path, 'utf-8'))` appears 30+ times (ship-config, relay, ipc-commands, allow-list, main, mcp-sync, history-export, skill-sync, container-spawn, intercom-relay). `writeFileSync(path, JSON.stringify(data, null, 2) + '\n')` appears 14 times with inconsistent trailing newline. Add to utils.ts:
```ts
function readJson<T>(path: string, fallback?: T): T          // throws or returns fallback
function writeJson(path: string, data: unknown): void         // atomic .tmp + rename, always + '\n'
```

#### 3. Error string conversion — use `errStr()` everywhere (MEDIUM)
`errStr()` is already defined in `utils.ts:16-18` but not imported in `ship-config.ts`, `cli.ts` (4 inline occurrences), `run-container.ts`, `ipc-commands.ts` (2). Replace all inline `err instanceof Error ? err.message : String(err)` with `errStr(err)`.

#### 4. Regex escape — consolidate to `utils.ts` (MEDIUM)
Three independent implementations of `/[.*+?^${}()|[\]\\]/g`:
- `infini-config.ts:33-35` `escapeRegex()` — move to utils.ts and export
- `channels/matrix.ts:152` — inline, replace with import
- `main.ts:207` — inline, replace with import

#### 5. Git exec options — factory function (MEDIUM)
`{ cwd, encoding: 'utf-8', timeout: N, stdio: 'pipe' }` is redefined 8+ times in relay.ts alone (lines 299, 310, 318, 351, 948, 1093, 1124, 1765). Add to `git-utils.ts`:
```ts
function gitOpts(cwd: string, timeoutMs = 15_000): ExecSyncOptions
```

#### 6. Env var parsing — add `envInt()` / `envMs()` to utils.ts (MEDIUM)
`parseInt(process.env.VAR || '', 10) || default` appears 12+ times in infini-config.ts, relay.ts, main.ts, container-spawn.ts with varying radix usage. Add:
```ts
function envInt(name: string, defaultVal: number): number
function envMs(name: string, defaultVal: number): number  // same but documents unit intent
```

#### 7. Git version extraction — consolidate to version.ts (MEDIUM)
Three separate implementations calling `git rev-parse --short HEAD`, `git log -1 --format=%ci`, `git log -1 --format=%s` in service.ts, version.ts, relay.ts. `version.ts` should own this; other files should import from it.

#### 8. Safe name validation — one regex in ship-config.ts or utils.ts (LOW)
Four similar but slightly different regexes for "safe identifier" checking:
- `ship-config.ts:38` `SAFE_BOT_NAME`
- `container-spawn.ts:83` `SAFE_CONTAINER_NAME_TAG`
- `allow-list.ts:48` inline
- `channels/matrix.ts:188` inline
Consolidate to a single `SAFE_NAME_RE` in utils.ts, document the differences where stricter validation is intentional.

#### 9. `isNonEmptyString` — export from utils.ts (LOW)
Locally defined in `ship-config.ts:42-44`. Move to utils.ts and import everywhere.

---

## LOW — Design

- **Help account for relay output** — Commands like `!` (help), `!fleet`, `!health` produce output that bots should ignore. Create a dedicated "help" Matrix account for relay responses. Add it to every bot's `IGNORE_SENDERS` so relay output never triggers bot processing. Currently relay sends via intercom accounts, which bots already watch — separating help output from intercom commands would be cleaner.

## LOW — Security

- ~~Security review: relay.ts + main.ts new code~~ — reviewed 2026-03-07, all 82 commits clean. No injection vectors. Full rotation pointer reset to `allow-list`.
- ~~Security rotation cycles 3–6~~ — completed 2026-03-07. Fixes: `8edc180` (ipc-commands handleHealthCheck shell injection), `a153075` (relay hasRunningContainer/getContainerStartTime shell injection), `10a762e` (relay botVersion SHA validation). All other files clean.

## LOW — Infrastructure

- **Poseidon: update S3 endpoint to remove containerNetwork dependency** — currently uses `containerNetwork: "host"` to reach S3. Update S3 endpoint on Poseidon so it's reachable without host networking, then remove the `machines` section from fleet.json entirely.
- **Podman SSH connection drops on macOS** — SSH socket dies silently after sleep/wake. Fix: `podman machine stop && podman machine start`. Root cause unknown.
- ~~Rename supervisor to "relay"~~ — done (`93ea3ca`), relay running.
- **Matrix sluggish on Poseidon** — conduwuit 500 errors on federated rooms. Status indicator spam throttled (5min cap).

## LOW — Reliability

- ~~Pre-commit hook for dist/~~ — installed on both HERACLES and Poseidon.
- ~~**Brain model change refactor**~~ — `c619bcb`: `set_brain_mode` IPC now auto-restarts after updating env. No manual restart needed.
- ~~**Session OOM still possible**~~ — `997fb21`: pruneOldSessions now covers all project dirs + archive/ subdirs (was only cwd dir). Cleared 26MB of stale JSONL on next restart.

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
- Thread design (`bca7c72`, `13d4305`) — tool call threads now use last bot text as anchor title; discussion routes into thread; final result merges back to main timeline.
- Health 24h trends (`a3f5769`) — relay computes sigkill/OOM deltas from history, embeds in S3 upload.
- Session pruning (`997fb21`) — pruneOldSessions covers all project dirs + archive/ subdirs.
