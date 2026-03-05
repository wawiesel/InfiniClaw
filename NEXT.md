# NEXT — Future Work

Items observed during operation. Operators: update continuously based on what's blocking progress.

## HIGH PRIORITY — Captain Directives (blocking progress)

- **Thread discipline** — bots spam main room too much. More work in threads, only post summaries/results to main timeline. Cid now editing main.ts for this — monitor result.
- **2-second ack** — bot should acknowledge within 2s of being triggered, even if real work takes longer. Not yet implemented.
- **Standing orders drift** — Cid spent an entire session on low-priority security reviews instead of Captain directives. Root cause: old standing orders said "rotate through every source file, never stop" without priority ranking. Fixed in `08eb197` but pattern may recur. Operators must watch for bots doing low-value background work when high-priority items exist.

## MEDIUM — Bot Behavior

- Cid's `message-filtering.ts` edit sits uncommitted across many other commits — bot may be holding WIP edits too long without committing. Investigate if this blocks other work or causes merge issues.
- Operator monitoring was too passive — just checking "is the bot active" without questioning WHAT the bot is working on. Operators must check commit messages against priorities, not just activity.

## LOW — Infrastructure

- Rename supervisor to "relay" — name conflicts with pm2 (process supervisor). It's a Matrix message relay + command handler, not a process manager.
- Supervisor can't process `!restart`/`!join` sent via its own intercom account (ignores own messages). Workaround: `pm2 restart` directly.
- `npm run cli stop` hangs on S3 push — needs timeout or skip option.
- Pre-push hook runs full type-check + tests twice when push is rejected by remote. Consider caching results or skipping on immediate retry.

## LOW — Reliability

- Session OOM still possible — V8 heap OOM (exit 137) from large JSONL sessions. Agent-runner backup files (.claude/backups/) can restore old session IDs even after manual cleanup. Full cleanup chain: DB sessions table → JSONL file → .claude/backups/.
- Image hash cache files (`_runtime/data/image-hash-*`) prevent rebuild even when images are removed. Must delete hash files to force rebuild.
- Container exit 125 from missing agent-runner mount — partially fixed with `mountIfExists` but root cause (build context) should be revisited.
