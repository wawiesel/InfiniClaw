# NEXT — Future Work

Items observed during operation. Operators: update continuously based on what's blocking progress.
Updated 2026-03-05T18:00Z.

## HIGH PRIORITY — Captain Directives (blocking progress)

- **2-second ack** — bot should acknowledge within 2s of being triggered, even if real work takes longer. Cid implementing in `f28eb09` — verify it works in practice.
- **Thread discipline** — bots spam main room too much. More work in threads, only post summaries/results to main timeline. Cid editing main.ts and delegate-runner.ts for this — monitor result.
- **Parker ineffective as autonomous monitor**. Fixed: idle containers now wake for pending messages/tasks (group-queue.ts). Still needed: periodic heartbeat so Parker can do proactive health work without external trigger.
- **Matrix sluggish on Poseidon** (Captain report). Server responds <1ms locally — likely Element client or network issue. Investigate client-side or consider lighter Matrix client.
- **Standing orders drift** — Cid spent an entire session on low-priority security reviews instead of Captain directives. Fixed in `08eb197` but pattern may recur. Operators must check commit messages against priorities, not just activity.

## MEDIUM — Next Up

- **Gemini lobe delegation** (Captain directive). Not yet enabled. Verify API keys configured and lobe routing works.
- **Tool call breadcrumbs** (Captain idea). Tool calls should have single-line hash in Matrix, full content to S3. Any bot can download for detail.
- **Lobe delegation CWD too restrictive**. `delegate-runner.ts` only allows `/workspace/*` roots. Health scripts needing `/_runtime/` fail. Add runtime data paths to allowed roots.
- **Concurrency ceiling starvation**. When MAX_CONCURRENT_CONTAINERS reached, lower-priority bots starve. Need priority levels or reserved slots.
- Cid's `message-filtering.ts` edit sits uncommitted across many other commits — bot may be holding WIP edits too long.

## LOW — Infrastructure

- Rename supervisor to "relay" — name conflicts with pm2. It's a message relay, not a process manager.
- Supervisor can't process `!restart`/`!join` sent via its own intercom account (ignores own messages). Workaround: `pm2 restart` directly.
- `npm run cli stop` hangs on S3 push — needs timeout or skip option.
- Pre-push hook runs full type-check + tests twice when push is rejected by remote. Consider caching or skipping on immediate retry.

## LOW — Reliability

- Session OOM still possible — V8 heap OOM (exit 137) from large JSONL sessions. Agent-runner backup files (.claude/backups/) can restore old session IDs even after manual cleanup. Full cleanup chain: DB sessions table -> JSONL file -> .claude/backups/.
- Image hash cache files (`_runtime/data/image-hash-*`) prevent rebuild even when images are removed. Must delete hash files to force rebuild.
- Container exit 125 from missing agent-runner mount — partially fixed with `mountIfExists` but root cause (build context) should be revisited.
- Parker's scheduled task `ERR_SSL_PACKET_LENGTH_TOO_LONG` — should be fixed with `containerNetwork: "host"`, verify on next cron fire.
