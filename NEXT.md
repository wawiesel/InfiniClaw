# NEXT — Future Work

Items observed during operation. Operators: add new items as you see them.

## Infrastructure
- Rename supervisor to "relay" — name conflicts with pm2 (process supervisor). It's a Matrix message relay + command handler, not a process manager.
- Supervisor can't process `!restart`/`!join` sent via its own intercom account (ignores own messages). Workaround: `pm2 restart` directly.
- `npm run cli stop` hangs on S3 push — needs timeout or skip option.
- Pre-push hook runs full type-check + tests twice when push is rejected by remote. Consider caching results or skipping on immediate retry.

## Bot Behavior
- Cid's `message-filtering.ts` edit sits uncommitted across many other commits — investigate if bot is holding WIP edits too long without committing.
- Bots spam main room too much (Captain directive). Need better thread discipline — more work in threads, less main timeline noise.
- 2-second ack not yet implemented (Captain directive). Bot should acknowledge within 2s of being triggered, even if real work takes longer.

## Reliability
- Session OOM still possible — V8 heap OOM (exit 137) from large JSONL sessions. Agent-runner backup files (.claude/backups/) can restore old session IDs even after manual cleanup, causing repeat OOMs. Full cleanup chain: DB sessions table → JSONL file → .claude/backups/.
- Image hash cache files (`_runtime/data/image-hash-*`) prevent rebuild even when images are removed. Must delete hash files to force rebuild.
- Container exit 125 from missing agent-runner mount — partially fixed with `mountIfExists` but root cause (build context) should be revisited.
