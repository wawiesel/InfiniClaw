# BUGS — Known Issues

When this file has content, the commanding engineer must address these items first, delegating and using threads as appropriate.

## Active Bugs

### BUG-15: git sync restarts fleet on every commit — doc commits should not restart

**Reported:** 2026-03-08
**Status:** fixed (d4c0c18)
**Component:** relay.ts / gitSyncLoop
**Symptom:** Every commit pushed to origin (including doc-only changes like BUGS.md, NEXT.md, README.md) triggers a full fleet restart. This kills any in-progress Thread Brains (BUG-14), interrupts Cid mid-task, and causes 3-5 restarts per working session.
**Root cause:** `gitSyncLoop` restarts fleet on ANY `newCommits > 0`. No check for whether the changes actually affect running code.
**Fix:** Added `hasSourceChanges()` function — diffs changed files between commits. If only documentation changed (no `*.ts`, `package.json`, `Dockerfile*`, `tsconfig*.json`), skips rebuild and restart.

---

### BUG-14: Thread Brain dies on container restart — branch_to_thread unreliable

**Reported:** 2026-03-08
**Status:** fixed (this commit)
**Component:** delegate-runner.ts / branch_to_thread / container lifecycle
**Symptom:** Main brain calls `branch_to_thread`, dispatches correctly, says "Thread brain spawned." But the Thread Brain never posts because the bot's container restarts (triggered by git sync detecting new commits), killing the Thread Brain child process inside the old container.
**Root cause:** Two compounding issues: (1) `branch_to_thread` spawns Thread Brain as a child process INSIDE the bot's container with `detached: true`. Container exit kills all children. (2) `--thread-id` is not a valid claude CLI flag — primary spawn always fails, fallback runs without `--resume`, but still dies when container exits.
**Fix:** Per design (02-threading.md), Thread Brains should be host-managed processes. New IPC task type: `spawn_thread_brain`. In delegate-runner.ts: write `_runtime/relay-tasks/thread-brain-<id>.json` with `{type:'thread_brain', thread_id, objective, bot, sessionId}` instead of spawning child claude. In relay.ts `relayTasksLoop`: handle `thread_brain` tasks by spawning a new container (`bootstrapBot` variant) with the objective injected via the IPC input mechanism, routing its Matrix output to the specified thread.

---

### BUG-13: branch_to_thread Thread Brain posts nowhere (no set_thread in objective)

**Reported:** 2026-03-08
**Status:** fixed (1486a9c)
**Component:** delegate-runner.ts / branch_to_thread tool
**Symptom:** Main brain calls `branch_to_thread(objective, thread_id)`, returns immediately, says "Branching to...". Thread Brain spawns but never posts anything in the Matrix thread. Thread is silent.
**Root cause:** Two issues:
1. The tool description says "Target thread ID to resume/anchor" but gives no instruction to call `set_thread` first. The spawned Claude process gets the objective via stdin but has no automatic Matrix thread context — it posts wherever the default send_message would go (or nowhere if no active thread).
2. The `--thread-id` arg passed to `claude --resume --thread-id $matrix_event_id` is a Claude Code session concept, not a Matrix thread ID. It will fail or be ignored, causing fallback to no-resume mode.
**Fix:** Two options: (a) Update the tool description to require bots include "First: call set_thread with {thread_id}. Post opening goal. Then do the work. Then post one-line summary on main timeline." explicitly in every objective. Or (b) Auto-inject a system prefix into the spawned process stdin that calls set_thread automatically before passing the objective. Option (b) is better — no bot should have to remember this boilerplate.

---

### BUG-12: Lobes use send_message/intercom tools, routing output to wrong channel

**Reported:** 2026-03-08
**Status:** fixed (this commit)
**Component:** delegate-runner.ts / lobe execution constraints
**Symptom:** A lobe dispatched for research/file-ops sent "📋 Fleet" through the Engineering intercom. Bots should never deliver output via the intercom — only relay `!` commands do that.
**Root cause:** `delegatedObjective` constraints in `delegate-runner.ts` didn't prohibit communication tools. Lobes had access to `send_message`, `send_image`, etc. and could inadvertently use them.
**Fix:** Added constraint to `delegatedObjective`: "Do NOT use send_message, send_image, send_file, or any intercom/communication tools." Output is delivered to the delegate thread automatically.

---

### BUG-11: Thought process not visible in threads (possible streaming output bug)

**Reported:** 2026-03-08
**Status:** fixed (ca16ce9)
**Component:** main.ts / streaming output / thread display
**Symptom:** Captain cannot see enough of the bot's reasoning in threads. Text the bot "thinks out loud" before tool calls is not appearing — only the tool call anchors are visible.
**Root cause:** 10s `PROGRESS_CHAT_COOLDOWN_MS` throttle was dropping all but the first text chunk per 10s window. Tool calls bypass this throttle but text doesn't — so bot thinking was silently discarded.
**Fix:** Skip cooldown check when in an active thread (`progressToolCallThreadIds` or `activeReplyThreadIds` set). In-thread text now flows at full rate. (ca16ce9)

---

### BUG-10: Cid announces itself after refit restart (should be silent)

**Reported:** 2026-03-08
**Status:** fixed (CLAUDE.md update)
**Component:** persona / restart behavior
**Symptom:** After a refit, Cid receives a system "you were restarted" prompt and sends "Refit complete — back online on HERACLES." Captain did not ask for this — it's noise.
**Root cause:** The restart system message always prompts for a response. Persona rules say "if not addressed and no work to report, produce zero output" but the restarted-after-refit case isn't being handled silently.
**Fix:** When restarted with no pending Captain/crew messages and nothing in progress, produce zero output. The restart system message is not an address.

---

### BUG-9: Refit fails to restart bots (Cid restart failed with 1E)

**Reported:** 2026-03-08
**Status:** fixed (78eff4d)
**Component:** relay / refit (BUG-6 regression)
**Symptom:** After refit, bot restart fails with ⛔. Likely a regression from BUG-6 fix — the join sequence adds git sync + room management, increasing failure surface during refit (Podman EOF, Matrix room errors).
**Root cause:** `handleLifecycleCommand('join')` has too many failure points (git sync, room leave/join, brain restore) during a refit when Podman may be in a degraded state. Also, already-onduty bots are a no-op via join.
**Fix:** Refit inlines `refreshBot()` directly — stop+kill+start, no room/brain management, no early-exit for onduty bots.

---

### BUG-8: Engineers cannot git push from container (mcp_nanoclaw__git_push fails)

**Reported:** 2026-03-08
**Status:** fixed (baa713d)
**Component:** ipc-commands / git_push
**Symptom:** `mcp__nanoclaw__git_push` always fails with "failed to push some refs" or "could not read Username". The `git push` runs inside the bot container which has no GitHub credentials.
**Root cause:** `handleGitPush` in `ipc-commands.ts` runs `git push` via `execFileSync` inside the container. The relay (on host) has git credentials; the container does not.
**Fix:** `handleGitPush` writes a task to `_runtime/relay-tasks/`; new `relayTasksLoop()` in `relay.ts` polls that dir every 2s and executes git push on the host. No operator commands involved.

---

### BUG-7: Brain thread branching not visible in Engineering

**Reported:** 2026-03-08
**Status:** fixed (f2eee23, built 2026-03-08, deploys on next bot refresh)
**Component:** main.ts / thread display + bot behavior
**Symptom:** Threads in Engineering show raw tool names ("🔧 TodoWrite") with no context. The lobe delegation and brain branching system is not apparent — Captain cannot tell what the bot is working on from the thread titles.
**Root cause:** (1) Thread anchor uses tool name as fallback when bot has no `lastProgressText`. (2) Bots do not consistently write meaningful text before calling tools. (3) `branch_to_thread` / `delegate_to_lobe` threads are not prominent enough.
**Fix:** (1) Use `currentObjective` as fallback anchor — committed in f2eee23. (2) Bot must always write a brief description before calling tools. (3) Use `branch_to_thread` visibly for all multi-step work so delegation is clearly visible.

---

### BUG-1: Restart has no visible indicator / doesn't happen in a thread

**Reported:** 2026-03-08
**Status:** fixed (d96372f)
**Component:** relay / operator-commands
**Symptom:** When a bot restarts, there is no Matrix message indicating the restart started or completed. The event should open a thread (like `!fleet` and other `!` commands).
**Root cause:** Restart acknowledgment is silent — no thread created, no pre/post messages sent.
**Fix:** Emit a thread in the Engineering room when restart begins and when the bot comes back online.

---

### BUG-2: `!todo <bot>` does not reply in-thread instantly

**Reported:** 2026-03-08
**Re-opened:** 2026-03-08 (d96372f marked fixed but Captain confirms still broken)
**Status:** fixed (ca16ce9)
**Component:** operator-commands / relay
**Symptom:** `!todo cid` should immediately open a thread and display the bot's current todo list. Captain reports it is not an instant in-thread reply.
**Root cause:** The thread IS created by `reply()` in relay.ts — but content comes from `status.json` (`lastProgress`/`currentObjective`), which is the relay's stale snapshot, not the bot's actual TodoWrite task list. Bot todos are stored in the Claude Code session, not accessible to the relay.
**Fix:** `!todo` now reads most recently modified `.claude/todos/*.json` session file; displays items with ✅/🔄/⬜ icons. Falls back to status.json if unavailable. (ca16ce9)

---

### BUG-3: `!fleet` crew is not indented under ships

**Reported:** 2026-03-08
**Status:** fixed (d96372f)
**Component:** relay
**Symptom:** In `!fleet` output, crew members are not visually indented under their ship, making the output hard to read. HTML entities (`&lt;a href=...`) also appear raw in some clients.
**Root cause:** Indentation tree formatting broken; HTML may be double-escaped.
**Fix:** Ensure crew lines use consistent tree-style indentation (├/└) nested under their ship anchor.

---

### BUG-4: After restart, Cid is not on latest commit

**Reported:** 2026-03-08
**Status:** fixed (d96372f)
**Component:** relay / restart flow
**Symptom:** After restart, Cid shows an older commit SHA (e.g. `4dba7c7` 3.6h old, ↑25↓16) instead of the latest. Repo should be synced (git pull) as part of restart.
**Root cause:** Restart flow does not pull latest commits before building.
**Fix:** Ensure `git pull` (or equivalent sync) runs during the restart/rebuild cycle so the bot starts on HEAD.

---

### BUG-6: After refit, bots should go through the normal restart sequence

**Reported:** 2026-03-08
**Status:** fixed (e60a5d4)
**Component:** relay / refit
**Symptom:** After a successful `!refit`, bots are restarted via `bootstrapBot()` directly, bypassing the normal `!join` sequence (room management, brain restore, thread notification per bot).
**Root cause:** Refit calls `bootstrapBot(root, bot)` directly instead of `handleLifecycleCommand('join', bot, conn)`.
**Fix:** Refit should invoke the same join flow as `!join` for each bot, so room state, brain model, and visible progress are all handled consistently.

---

### BUG-5: `is_main` flag not set in DB, blocking IPC commands for main group

**Reported:** 2026-03-08
**Status:** fixed
**Component:** ipc-commands / main.ts `loadState`
**Symptom:** Bots in the main duty room get `Unauthorized rebuild_image attempt blocked` (and all other `requireMain`-gated IPC commands: `refresh_bot`, `git_push`, etc.) even though their `sourceGroup` is `"main"`.
**Root cause:** The `registered_groups` table had `is_main = 0` for the main folder group. Groups registered before the `isMain` column was added were persisted with `0` and never patched on reload. The IPC watcher builds `folderIsMain` from `group.isMain`, so the main group appeared unauthorized.
**Fix:** Added a migration in `loadState()` (main.ts) that patches any group with `folder === MAIN_GROUP_FOLDER` to `isMain: true` and persists it back to DB. Also manually fixed existing DBs for cid, albert, and johnny5.
