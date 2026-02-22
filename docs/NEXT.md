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

## Priority 2: Restore Holodeck
- **What:** Add back the Holodeck functionality.
- **Why:** It provided a crucial blue-green test instance capability for deploying feature branches safely without risking the live Bridge and Engineering bots.
- **How:** Re-introduce the `holodeck` isolation (like `Albert the Hologram`) that was removed, aiming for a cleaner implementation that doesn't overcomplicate the base container lifecycle logic.