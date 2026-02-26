# NEXT — InfiniClaw Planned Work

## ~~Priority 1: Restart Robustness~~ ✅
- **Done:** `injectResumeMessage()` now reads the bot's todo list via `readTodoItems()` and includes non-completed tasks in the resume message. Bots see their active tasks immediately on restart without rediscovering from conversation context.

## ~~Priority 1: Verify Sync Mechanisms~~ ✅
- **Done:** Verified all sync mechanisms are one-way (persona → container). `syncPersona`/`restorePersona` copy persona files at deploy. Skills are copied to session at spawn. MCP configs are loaded from persona dirs. Cid found `saveMcpServersToPersona` save-back — removed it (deleted from `mcp-sync.ts` and `syncPersona` call site). All sync is now strictly one-way.

## ~~Priority 1: NanoClaw Upgrades~~ ✅
- **Done:** Merged upstream nanoclaw v1.1.3 (da61a7e, 212 commits). Used read-tree + selective restore since upstream force-pushed away the original squash base. Incorporated: group-folder path validation (security), skills engine updates, new skills (slack, gmail, update, qodo), CI improvements, setup module. InfiniClaw patches (lobe system, session rotation, IPC fix, container skills) re-applied on top. Build + all 41 tests pass. (commits 67ecff9, daf2439)
- **Process for next time:** `git fetch upstream && git read-tree --prefix=external/nanoclaw/ -u upstream/main`, commit, then `git checkout <prev-commit> -- <infiniclaw-specific-files>`, fix any API changes, commit.

## ~~Priority 1: Engineer vault access gap~~ ✅
- **Fixed:** Added `"bots": ["commander"]` to the `_vault` allowlist entry and `"bots": ["engineer"]` to the InfiniClaw entry in `~/.config/nanoclaw/mount-allowlist.json`. The `findAllowedRoot` function skips entries when `root.bots` is set and the current bot isn't listed, so the engineer cannot mount `_vault` rw even if someone adds it to the engineer's `container-config.json`.

## ~~Priority 2: InfiniClaw Config System~~ ✅
- **Done:** `~/.config/infiniclaw/` is the sole config directory. `allow-list.ts` reads/writes `allow-list.json` there. No InfiniClaw source references `~/.config/nanoclaw/`. Old `mount-allowlist.json` is stale/unused. Config is organized: runtime config → `~/.config/infiniclaw/`, deployment config → `bots/`, OS services → `~/Library/LaunchAgents/`.

## ~~Priority 2: Restore Holodeck~~ ✅
- **Done:** Reimplemented as CLI subcommands: `holodeck create|chat|teardown|promote`. Creates a git worktree from a feature branch, deploys to a separate instance (`_runtime/instances/{bot}-holodeck/`), runs as its own launchd service in terminal-only mode. Promote merges the branch and redeploys the live bot. No Matrix conflicts — holodeck runs terminal-only by default.

---

## Completed ✅

- **Restart Loop Prevention** — Added 60-second cooldown between restarts per bot in `ipc-commands.ts`. Prevents context-burning restart loops. (commit d213e31)
- **Todo List Enforcement** — Added 2-minute periodic check in `main.ts` that injects reminders when active bots have empty todo lists or no in_progress items. (commit d213e31)
- **Brain Management** — `set_brain_mode` and `restart_self` now work correctly. `applyBrainEnv` only sets `ANTHROPIC_MODEL` (SDK handles the rest), and `refreshPlist` is called before exit so the respawned process picks up the new env. (commit 99bce68)
- **Thread Management** — `delegate_to_lobe` handles threading atomically. The `thread_id` param was added to all delegate tools. (commit 99bce68)
- **Semantic Versioning** — InfiniClaw is at `v1.0.0`, tagged, `safe` branch tracks it.
- **Branch Strategy** — `safe` and `exp` branches exist locally (pending push to origin).
- **Claude Lobe Delegation** — `delegate_claude` added alongside Codex/Gemini/Ollama. Uses Claude CLI with `--print --output-format stream-json --dangerously-skip-permissions`. Also added to `delegate_to_lobe` atomic tool.
