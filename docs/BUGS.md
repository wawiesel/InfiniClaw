# BUGS — Known Issues

When this file has content, the commanding engineer must address these items first, delegating and using threads as appropriate.

## Active Bugs

### BUG-1: Restart has no visible indicator / doesn't happen in a thread

**Reported:** 2026-03-08
**Status:** open
**Component:** relay / operator-commands
**Symptom:** When a bot restarts, there is no Matrix message indicating the restart started or completed. The event should open a thread (like `!fleet` and other `!` commands).
**Root cause:** Restart acknowledgment is silent — no thread created, no pre/post messages sent.
**Fix:** Emit a thread in the Engineering room when restart begins and when the bot comes back online.

---

### BUG-2: `!todo <bot>` does not create a thread

**Reported:** 2026-03-08
**Status:** open
**Component:** operator-commands
**Symptom:** `!todo cid` should immediately create a thread showing the todo list for the named bot. Currently no thread is created.
**Root cause:** Unknown — `!todo` may not be implemented with thread creation.
**Fix:** `!todo <bot>` should create a thread immediately and display current todo items inside it.

---

### BUG-3: `!fleet` crew is not indented under ships

**Reported:** 2026-03-08
**Status:** open
**Component:** relay
**Symptom:** In `!fleet` output, crew members are not visually indented under their ship, making the output hard to read. HTML entities (`&lt;a href=...`) also appear raw in some clients.
**Root cause:** Indentation tree formatting broken; HTML may be double-escaped.
**Fix:** Ensure crew lines use consistent tree-style indentation (├/└) nested under their ship anchor.

---

### BUG-4: After restart, Cid is not on latest commit

**Reported:** 2026-03-08
**Status:** open
**Component:** relay / restart flow
**Symptom:** After restart, Cid shows an older commit SHA (e.g. `4dba7c7` 3.6h old, ↑25↓16) instead of the latest. Repo should be synced (git pull) as part of restart.
**Root cause:** Restart flow does not pull latest commits before building.
**Fix:** Ensure `git pull` (or equivalent sync) runs during the restart/rebuild cycle so the bot starts on HEAD.

---

### BUG-5: `is_main` flag not set in DB, blocking IPC commands for main group

**Reported:** 2026-03-08
**Status:** fixed
**Component:** ipc-commands / main.ts `loadState`
**Symptom:** Bots in the main duty room get `Unauthorized rebuild_image attempt blocked` (and all other `requireMain`-gated IPC commands: `restart_bot`, `git_push`, etc.) even though their `sourceGroup` is `"main"`.
**Root cause:** The `registered_groups` table had `is_main = 0` for the main folder group. Groups registered before the `isMain` column was added were persisted with `0` and never patched on reload. The IPC watcher builds `folderIsMain` from `group.isMain`, so the main group appeared unauthorized.
**Fix:** Added a migration in `loadState()` (main.ts) that patches any group with `folder === MAIN_GROUP_FOLDER` to `isMain: true` and persists it back to DB. Also manually fixed existing DBs for cid, albert, and johnny5.
