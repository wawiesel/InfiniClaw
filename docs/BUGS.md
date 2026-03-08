# BUGS — Known Issues

When this file has content, the commanding engineer must address these items first, delegating and using threads as appropriate.

## Active Bugs

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
**Status:** open
**Component:** ipc-commands / git_push
**Symptom:** `mcp__nanoclaw__git_push` always fails with "failed to push some refs" or "could not read Username". The `git push` runs inside the bot container which has no GitHub credentials.
**Root cause:** `handleGitPush` in `ipc-commands.ts` runs `git push` via `execFileSync` inside the container. The relay (on host) has git credentials; the container does not.
**Fix:** Route git_push through the relay. Options: (a) add a relay-side file watcher for git_push tasks, (b) add a `!push` relay Matrix command, (c) configure SSH/token credentials in container.

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

### BUG-2: `!todo <bot>` does not create a thread

**Reported:** 2026-03-08
**Status:** fixed (d96372f)
**Component:** operator-commands
**Symptom:** `!todo cid` should immediately create a thread showing the todo list for the named bot. Currently no thread is created.
**Root cause:** Unknown — `!todo` may not be implemented with thread creation.
**Fix:** `!todo <bot>` should create a thread immediately and display current todo items inside it.

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
