# NEXT — InfiniClaw Planned Work

## Priority 1: Claude Lobe Delegation
- **What:** Add `delegate_claude` to delegate options.
- **Why:** We can currently delegate to `delegate_gemini`, `delegate_codex`, and `delegate_ollama`, but not Claude itself. Claude should be able to spin up sub-instances for parallel reasoning tasks without blocking the main event loop.
- **How:** Implement `delegate_claude` similar to how other lobes are currently mounted and managed in `nanoclaw/src/container-runner.ts` and ensure it properly links to existing profiles/credentials.

## Priority 1: Restart Robustness
- **What:** Ensure bots always pick up where they left off after a restart.
- **Why:** During container restarts or deployments, any active tasks or conversational context might be dropped.
- **How:** Implement reliable logic (e.g., `injectResumeMessage()`) on startup that checks `store/messages.db` or active objectives to trigger the bot to summarize its last state and pick up pending work.

## Priority 1: Brain Management
- **What:** Ensure brains are properly managed and can be upgraded/downgraded on the fly by a bot.
- **Why:** Bots should be able to dynamically select a smarter model (e.g., Opus) for difficult, high-context tasks, and a faster/cheaper model (e.g., Haiku) for simple formatting or status checks.
- **How:** Expose an MCP tool or system command allowing the bot to write changes to its `.claude/settings.json` or update its active bot profile (e.g., `ANTHROPIC_MODEL`) via IPC.

### Bug: `set_brain_mode` doesn't fully take effect
- **Problem:** `set_brain_mode` writes to the profile env file, but `restart_self` does `process.exit(0)` and launchd respawns with the **old plist env**. The plist env is only rebuilt on `bootstrapBot()` or full `start()`, not on self-restart.
- **Fix:** When mode is `anthropic`, stop overriding `ANTHROPIC_SMALL_FAST_MODEL` and `ANTHROPIC_DEFAULT_SONNET_MODEL` — let the SDK use its own defaults for those. Only set `ANTHROPIC_MODEL` from `BRAIN_MODEL`. When mode is `ollama`, set all model vars to the ollama model.
- **Also:** `restart_self` must rebuild the launchd plist (via `installPlistAndLoad` with fresh `buildLaunchdEnv`) before exiting, so the respawned process picks up the new env.

## Priority 1: Thread Management
- **What:** Ensure Matrix threads are properly managed.
- **Why:** Keeping the main room channels clear is vital for operator visibility. Every lobe activity and long-running operation must be neatly organized into conversation threads.
- **How:** Ensure `sendMessage` properly supports Matrix threads (`thread_id`) across all integrations, and that bots have the MCP capabilities to explicitly dictate when they start or reply to threads.

## Priority 1: Verify Sync Mechanisms
- **What:** Make sure one-way sync is active for all bots.
- **Why:** We need to reliably propagate repository skills and configurations (from `bots/personas/`) down into the active container sessions during spawn.
- **How:** Review `syncPersona`, `loadSkillsToSession`, and `loadMcpServersToSettings`. We must be completely confident that changes made in the git repository immediately take effect upon container restart with no state drift.

## Priority 1: NanoClaw Upgrades
- **What:** Update NanoClaw to the latest upstream version and develop a simple way to do that continuously.
- **Why:** The underlying NanoClaw framework receives upstream bug fixes and features. We must stay current without breaking InfiniClaw's custom IPC, UI, and Matrix layers.
- **How:** Document and automate a clean workflow (e.g., `git subtree pull` or rebasing) that safely integrates upstream changes.

## Priority 1: Semantic Versioning
- **What:** Introduce strict semver on `main` for InfiniClaw, independent of NanoClaw's version.
- **Why:** No version currently exists in InfiniClaw's `package.json`. Versioning gives us clear release milestones, makes the `safe` branch meaningful (it tracks the last tagged stable release), and lets us reason about breaking changes vs. additive features.
- **How:**
  - Start InfiniClaw at **`1.0.0`** — set in `package.json`
  - **Patch** (`1.0.x`) — bug fixes, config/persona changes, dependency bumps
  - **Minor** (`1.x.0`) — new features, new tools/channels, new IPC command types
  - **Major** (`x.0.0`) — breaking changes to IPC protocol, container API, or persona contract
  - Bump version in `package.json` with every merge to `main`; tag `main` with `vX.Y.Z`
  - Advance `safe` to the new tag after a confirmed stable build+restart cycle
  - NanoClaw's version in `external/nanoclaw/package.json` tracks upstream independently — document the pinned nanoclaw commit in release notes

## Priority 1: Branch Strategy — `safe` and `exp`
- **What:** Maintain two permanent branches alongside `main`: `safe` (last known-good deployable state) and `exp` (experimental/holodeck work-in-progress).
- **Why:** The deploy validator runs `tsc` against the working tree on every restart. Parallel edits from Captain and Engineer can leave the tree in a broken state that blocks restarts entirely. `safe` gives us a guaranteed fallback; `exp` lets us iterate without risking the live bots.
- **How:**
  - `safe` — advance after a stable build+restart cycle. Use when a restart is urgently needed and `main` is broken.
  - `exp` — branch off `main` for risky/experimental changes. Merge back to `main` when stable.
  - Engineer should check `git status` before any restart attempt and flag if `main` is in a broken state.

## Priority 1: Engineer vault access gap
- **Problem:** Engineer can reach `~/_vault` via `/workspace/extra/home/_vault` — a direct host path that bypasses the mount allowlist entirely. The allowlist correctly scopes `_vault` to `commander` only, but `/workspace/extra/` is mounted without those restrictions.
- **Fix:** Either remove `/workspace/extra/` from engineer's container mounts, or make the agent-runner enforce allowlist rules against the `/workspace/extra/` tree the same way it does for standard mounts. Engineer should have no write access to the vault under any path.

## Priority 2: Restore Holodeck
- **What:** Add back the Holodeck functionality.
- **Why:** It provided a crucial blue-green test instance capability for deploying feature branches safely without risking the live Bridge and Engineering bots.
- **How:** Re-introduce the `holodeck` isolation (like `Albert the Hologram`) that was removed, aiming for a cleaner implementation that doesn't overcomplicate the base container lifecycle logic.