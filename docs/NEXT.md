# NEXT — InfiniClaw Planned Work

## ~~Priority 1: Restart Robustness~~ ✅
- **Done:** `injectResumeMessage()` now reads the bot's todo list via `readTodoItems()` and includes non-completed tasks in the resume message. Bots see their active tasks immediately on restart without rediscovering from conversation context.

## ~~Priority 1: Verify Sync Mechanisms~~ ✅
- **Done:** Verified all sync mechanisms are one-way (persona → container) as designed. `syncPersona`/`restorePersona` copy persona files at deploy. Skills are copied to session at spawn. MCP configs are read from persona `.mcp.json` and passed to container via `ContainerInput.mcpServers`. The only save-back is `saveMcpServersToPersona` which intentionally persists runtime MCP changes — this is by design for bots that add integrations.

## ~~Priority 1: NanoClaw Upgrades~~ ✅
- **Done:** Merged upstream nanoclaw v1.1.3 (da61a7e, 212 commits). Used read-tree + selective restore since upstream force-pushed away the original squash base. Incorporated: group-folder path validation (security), skills engine updates, new skills (slack, gmail, update, qodo), CI improvements, setup module. InfiniClaw patches (lobe system, session rotation, IPC fix, container skills) re-applied on top. Build + all 41 tests pass. (commits 67ecff9, daf2439)
- **Process for next time:** `git fetch upstream && git read-tree --prefix=external/nanoclaw/ -u upstream/main`, commit, then `git checkout <prev-commit> -- <infiniclaw-specific-files>`, fix any API changes, commit.

## ~~Priority 1: Engineer vault access gap~~ ✅
- **Fixed:** Added `"bots": ["commander"]` to the `_vault` allowlist entry and `"bots": ["engineer"]` to the InfiniClaw entry in `~/.config/nanoclaw/mount-allowlist.json`. The `findAllowedRoot` function skips entries when `root.bots` is set and the current bot isn't listed, so the engineer cannot mount `_vault` rw even if someone adds it to the engineer's `container-config.json`.

## Priority 2: InfiniClaw Config System
- **What:** Create an InfiniClaw-specific config directory (`~/.config/infiniclaw/`) independent of nanoclaw's `~/.config/nanoclaw/`.
- **Why:** InfiniClaw config is scattered across mount allowlist (nanoclaw config dir), bot secrets (bots/profiles), container config (bots/personas), and launchd plists. The allowlist path is hardcoded in nanoclaw's config.ts. InfiniClaw needs its own config namespace.
- **How:** Make nanoclaw's allowlist path configurable (env var or constructor param), move `mount-allowlist.json` to `~/.config/infiniclaw/`, and consolidate other InfiniClaw-specific config there.

## Priority 2: Restore Holodeck
- **What:** Add back the Holodeck functionality.
- **Why:** It provided a crucial blue-green test instance capability for deploying feature branches safely without risking the live Bridge and Engineering bots.
- **How:** Re-introduce the `holodeck` isolation (like `Albert the Hologram`) that was removed, aiming for a cleaner implementation that doesn't overcomplicate the base container lifecycle logic.

---

## Completed ✅

- **Restart Loop Prevention** — Added 60-second cooldown between restarts per bot in `ipc-commands.ts`. Prevents context-burning restart loops. (commit d213e31)
- **Todo List Enforcement** — Added 2-minute periodic check in `main.ts` that injects reminders when active bots have empty todo lists or no in_progress items. (commit d213e31)
- **Brain Management** — `set_brain_mode` and `restart_self` now work correctly. `applyBrainEnv` only sets `ANTHROPIC_MODEL` (SDK handles the rest), and `refreshPlist` is called before exit so the respawned process picks up the new env. (commit 99bce68)
- **Thread Management** — `delegate_to_lobe` handles threading atomically. The `thread_id` param was added to all delegate tools. (commit 99bce68)
- **Semantic Versioning** — InfiniClaw is at `v1.0.0`, tagged, `safe` branch tracks it.
- **Branch Strategy** — `safe` and `exp` branches exist locally (pending push to origin).
- **Claude Lobe Delegation** — `delegate_claude` added alongside Codex/Gemini/Ollama. Uses Claude CLI with `--print --output-format stream-json --dangerously-skip-permissions`. Also added to `delegate_to_lobe` atomic tool.
