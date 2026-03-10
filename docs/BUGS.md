# BUGS — Known Issues

When this file has content, the commanding engineer must address these items first, delegating and using threads as appropriate.

## Active Bugs

### BUG-30: johnny5 stale runtime files

**Reported:** 2026-03-08
**Status:** open — no fix needed until johnny5 brought onduty
**Priority:** LOW
**Component:** `_runtime/instances/johnny5/` — `pm2-ecosystem.json`, `start.sh`
**Symptom:** `pm2-ecosystem.json` has `ASSISTANT_ROLE=Commander` (title, not role; role is `navigator`). `start.sh` sources `secrets/johnny5/env` instead of correct `secrets/bots/johnny5/env`. Together cause `bots/commander/johnny5/` mount attempts → exit 125.
**Fix:** Run `bootstrapBot("johnny5")` via relay to regenerate both files from current code with correct paths.

---

### BUG-29: Matrix sluggish on Poseidon — conduwuit 500 errors on federated rooms

**Reported:** 2026-03-08
**Status:** open
**Priority:** LOW
**Component:** Poseidon / conduwuit homeserver
**Symptom:** conduwuit returns 500 errors on federated room operations. Status indicator spam throttled (5min cap) as workaround.
**Fix:** Investigate conduwuit federation config on Poseidon. May require upgrade or federation disable.

---

### BUG-28: Podman SSH connection drops on macOS — silent death after sleep/wake

**Reported:** 2026-03-08
**Status:** open
**Priority:** LOW
**Component:** Infrastructure / Podman machine on macOS
**Symptom:** Podman SSH socket dies silently after macOS sleep/wake cycle. Bots fail to spawn containers with no clear error.
**Workaround:** `podman machine stop && podman machine start`
**Fix:** Root cause unknown. Investigate Podman machine QEMU socket keepalive or auto-reconnect.

---

### BUG-27: mac139160 orphaned relay — SSH timeout spam in Engineering

**Reported:** 2026-03-08
**Status:** open — blocked on Captain
**Priority:** HIGH (operational noise)
**Component:** mac139160 relay instance
**Symptom:** Relay on mac139160 sends repeated SSH timeout alerts (code.ornl.gov port 22 unreachable) every ~20 min into Engineering room. Machine appears orphaned — no bots assigned.
**Fix:** Captain must run `pm2 stop infiniclaw-relay` on mac139160, or decommission entirely.

---

### BUG-26: Concurrency ceiling starvation in group-queue.ts

**Reported:** 2026-03-08
**Status:** open — blocked on Captain approval
**Priority:** MEDIUM
**Component:** `external/nanoclaw/src/group-queue.ts` — `drainWaiting()`
**Symptom:** FIFO `waitingGroups` drain starves lower-priority groups when high-priority traffic is sustained. Groups queue indefinitely.
**Fix:** Priority-aware `drainWaiting()`. Needs Captain approval before touching upstream nanoclaw.

---

### BUG-25: Media download fully buffered before size check — OOM risk

**Reported:** 2026-03-08 (9th cycle audit)
**Status:** open — deferred pending SDK investigation
**Priority:** MEDIUM
**Component:** `src/channels/matrix.ts` — `downloadContent()`
**Symptom:** `downloadContent` buffers the full file into memory before the 50 MB cap is applied. Repeated large media from adversarial homeservers can spike RSS by hundreds of MB.
**Fix:** Stream `Content-Length` pre-flight check OR streaming download with byte-count abort. Deferred — needs matrix-bot-sdk streaming API investigation.

---

### BUG-24: `isPreformattedHtml` bypass allows prompt injection via raw HTML

**Reported:** 2026-03-08 (9th cycle audit)
**Status:** fixed (this commit)
**Priority:** MEDIUM (security)
**Component:** `src/channels/matrix.ts` — `sendMessage()` / `editMessage()`
**Symptom:** Strings starting with `<details`, `<font`, or `<small` skip `renderMarkdownForMatrix` and are sent as raw HTML with no sanitization. A prompt-injection payload beginning with `<details>` can carry arbitrary HTML to Matrix clients.
**Fix:** Added `sanitizePreformattedHtml()` — strips `<script>`, `<iframe>`, `<object>`, `<embed>` tags (with content), event-handler attributes (`on\w+=`), and `javascript:`/`data:` URL schemes. Applied on both bypass paths in `sendTextReturningId` and `editMessage`. No new dependencies. Legitimate uses (`<details>`, `<font>`, `<small>` with inline styles/color) are unaffected.

---

### BUG-23: Thread Brain dispatch has no main-timeline title announcement

**Reported:** 2026-03-08
**Status:** fixed (this commit)
**Component:** `src/relay.ts` — `spawnThreadBrain()`
**Symptom:** When Cid dispatches a Thread Brain via `branch_to_thread`, the Captain sees only "Thread Brain dispatched." on the main timeline. The topic/objective is not announced. Thread Brain results appear in the thread without a preceding title on main, making it hard to correlate threads to tasks.
**Root cause:** The `branch_to_thread` protocol requires the bot to post the title as plain text BEFORE making tool calls (step 1 of the protocol). However, the Claude model consistently skips this step, jumping directly to `get_last_event_id` and `branch_to_thread` tool calls. Persona instructions (`bots/engineer/cid/CLAUDE.md`) are insufficient to enforce this ordering reliably.
**Fix:** `spawnThreadBrain()` in `relay.ts` now posts `🧵 Thread Brain: <first line of objective>` on the main timeline before spawning the Thread Brain process. This is a code-level guarantee — the announcement always appears, regardless of model behavior.

---

### BUG-22: Thread Brain output triggers bot main loop (feedback loop)

**Reported:** 2026-03-08
**Status:** fixed (this commit)
**Component:** `src/infini-config.ts` — `IGNORE_SENDERS` / `bots/cid/env`
**Symptom:** Thread Brain posts its summary via @engineering-intercom to the Engineering room. If the summary mentions the bot's name (e.g. "Owner: Cid (Engineer)" quoted from NEXT.md), it matches TRIGGER_PATTERN and triggers the bot's message loop. The bot then processes the Thread Brain output as if it were a new message — violating step 5 of the `branch_to_thread` protocol ("do not act on Thread Brain output").
**Root cause:** @engineering-intercom (and other relay intercom accounts) were not in `IGNORE_SENDERS`. Relay notifications are status updates for the Captain, not messages to the bot. Any mention of the bot's name in relay output triggers a full response cycle.
**Fix:** Added `IGNORE_SENDERS=@engineering-intercom:a-gis.org,@bridge-intercom:a-gis.org,@astrometrics-intercom:a-gis.org` to `bots/cid/env`. Relay intercom messages are now filtered before trigger checking. Also strengthened the `branch_to_thread` step 5 instruction in `bots/engineer/cid/CLAUDE.md`.

---

### BUG-21: `resolveReplyThread()` picks up old context messages with `thread_id`

**Reported:** 2026-03-08
**Status:** fixed (this commit)
**Component:** `src/main.ts` — `resolveReplyThread()`
**Symptom:** After restart, bot responded to main-timeline messages (BUG-19 test, status ping) by routing to the old `!refresh` thread instead of main timeline. Messages sent to `@cid` on main timeline got replies inside `$KPS0azO4puk3Lfj1KldZrPmbQykUgSu67GuuLx7SgBo`.
**Root cause:** `resolveReplyThread` scans `messagesToSend` (full context since `lastAgentTimestamp`) for the most recent message with a non-null `thread_id`. The context batch included the old `[1m] ⛔ !refresh Cid — fetch failed` notification (which is in the `!refresh` thread), and it matched the TRIGGER_PATTERN because it contains "Cid". The scan returned this old thread_id even though the actual trigger messages were on the main timeline.
**Fix:** Only accept a thread_id from the scan if the message also matches TRIGGER_PATTERN AND is from a non-intercom sender (`!sender.includes('-intercom')`). Relay notifications from intercom accounts (e.g. `@engineering-intercom:a-gis.org`) that mention "Cid" should not trigger thread routing. Falls back to `lastMsg.thread_id` for CO/participating-thread scenarios.

---

### BUG-20: `resumeGate` blocks message loop for full container idle timeout at startup

**Reported:** 2026-03-08
**Status:** fixed (this commit)
**Component:** `src/main.ts` — `injectResumeMessage()`
**Symptom:** After Cid restarts, messages sent during the first ~30 minutes are silently buffered in the DB. They are not processed until the startup container's idle timeout fires. Observed: BUG-19 test and status ping waited ~30 minutes before Cid responded.
**Root cause:** `injectResumeMessage()` calls `await processGroupMessages(mainJid)`, which calls `await runAgent(...)`, which blocks until the container exits. The container only exits via idle timeout (30 min after last output). `resumeGateResolve()` is called only AFTER `processGroupMessages()` returns. `startMessageLoop()` awaits `resumeGate`, so the message loop is blocked for the full container lifetime. Any messages that arrive during the startup container run pile up in the DB and are only processed in a batch after the gate opens.
**Impact:** Startup responsiveness is severely degraded — urgent operator messages can wait up to 30 minutes for acknowledgment.
**Fix proposal:** Open `resumeGate` immediately after injecting the resume message (or after first output), not after container exit. The IPC piping mechanism (`groupStatus.active` check in `handleGroupMessagesInLoop`) already handles routing new messages to the active container, so blocking the message loop is unnecessary. Remove `await processGroupMessages(mainJid)` from `injectResumeMessage` — let the queue handle it via `queue.enqueueMessageCheck` (already called at line 1285).

---

### BUG-19: `resolveReplyThread()` routes main-timeline messages to stale work thread

**Reported:** 2026-03-08
**Status:** fixed (52d39a2)
**Component:** main.ts — `resolveReplyThread()`
**Symptom:** After bot replies to a message IN a thread (e.g., the BUG-18 test message), the next unrelated main-timeline message is incorrectly routed to the old thread. Bot responds inside the stale thread instead of on the main timeline.
**Root cause:** `resolveReplyThread()` had a fallback: if no thread is found in incoming `contextMessages`, check `workThreadIds[chatJid]` (set by the BUG-16 auto-routing when a thread message was processed). `workThreadIds` is never cleared after processing, so the stale thread ID persists and hijacks routing of the next main-timeline message. The `threadNote` injected into the prompt says "incoming message is in Matrix thread `$old...`" — bot believes it and works in the wrong thread.
**Fix:** Remove the `workThreadIds` fallback from `resolveReplyThread()`. `workThreadIds` controls outbound IPC routing (via `getWorkThread()`), not where incoming message replies are sent. When incoming messages have no thread_id, reply on main timeline unconditionally.

---

### BUG-18: `thread_id` lost at DB layer — BUG-16 fix is a no-op, `thread` attr never in XML

**Reported:** 2026-03-08
**Status:** fixed (29648e5)
**Component:** nanoclaw/db.ts — `storeMessage` / `getNewMessages`
**Symptom:** Operator posts in Matrix thread EEj0QqC at 12:51. Message reaches Cid but WITHOUT a `thread` attribute in the XML. Bot replies on main timeline. BUG-16 fix (85d69dc) is also silently inactive.
**Root cause:** Two missing DB fields in `nanoclaw/src/db.ts`:
1. `storeMessage` INSERT does not include `thread_id` — stored as NULL for every inbound message, regardless of Matrix thread membership.
2. `getNewMessages` SELECT does not include `thread_id` — even if a row had it, the field is absent from returned `NewMessage` objects.
**Full path the 12:51 message took:**
- `matrix.ts:888` — `threadId = "EEj0QqC"` correctly extracted from `m.relates_to.event_id`
- `matrix.ts:933` — `NewMessage` created with `thread_id: "EEj0QqC"` ✓
- `main.ts:1484` — `normalizeInboundMessage` preserves `thread_id` ✓
- `main.ts:1491` — `storeMessage(safeMsg)` called — INSERT omits `thread_id` → stored NULL ✗
- `processGroupMessages` → `getNewMessages` → SELECT omits `thread_id` → all `NewMessage.thread_id = undefined` ✗
- `resolveReplyThread` scans: no `m.thread_id` found → returns `undefined`
- BUG-16 fix: `if (activeReplyThreadIds[chatJid])` → false → `workThreadIds` never set (no-op)
- `formatMessages` → `m.thread_id ? \` thread="${...}"\` : ''` → empty → no `thread` attr in XML
- Bot receives XML without `thread` attribute → replies on main timeline
**Note:** Live Cid DB DOES have a `thread_id` column on `messages` (verified via PRAGMA — it's column 7). It was added by a migration that no longer exists in source. But `storeMessage` still doesn't write it, so it's always NULL.
**Fix:** In `nanoclaw/src/db.ts`: (1) add `thread_id` to `storeMessage` INSERT and its VALUES. (2) add `thread_id` to `getNewMessages` SELECT. (3) add migration `ALTER TABLE messages ADD COLUMN thread_id TEXT` guarded with try-catch (for fresh DBs — live DBs already have the column). Once `thread_id` flows through the DB, `resolveReplyThread` will find it, the BUG-16 auto-set will fire, and `formatMessages` will emit `thread="EEj0QqC"` in the XML.

---

### BUG-17: `@rollup/rollup-darwin-x64` optional dep disappears after npm install

**Reported:** 2026-03-08
**Status:** fixed (7422390)
**Component:** pre-push hook / npm optional dependencies
**Symptom:** Pre-push hook runs `npm test` (vitest) which needs `@rollup/rollup-darwin-x64`. After `npm install`, this optional dep is missing on HERACLES (arm64 Mac with Rosetta/x64 compatibility). Push fails: "Cannot find module @rollup/rollup-darwin-x64".
**Root cause:** npm bug ([npm/cli#4828](https://github.com/npm/cli/issues/4828)) — optional deps sometimes not installed. The pre-push hook runs `npm test --if-present` which invokes vitest which imports rollup.
**Fix:** Added darwin check to `scripts/hooks/infiniclaw-pre-push`: if `@rollup/rollup-darwin-x64` is missing, auto-installs with `--no-save --prefer-offline` before type-checking and tests. Also copies updated hook to `.git/hooks/pre-push`.

---

### BUG-16: Bot doesn't reply in-thread when addressed in an existing thread

**Reported:** 2026-03-08
**Status:** fixed (85d69dc)
**Component:** main.ts / message routing / bot persona
**Symptom:** When operator/Captain posts a message inside an existing thread (with `m.relates_to.rel_type = "m.thread"`), the bot receives and acknowledges the content but replies on the main timeline instead of within the thread.
**Root cause:** The agent-runner's auto-threading logic creates new threads for @callouts, but when a message arrives that's already part of a thread, the bot doesn't automatically call `set_thread` to route replies back into that thread. The bot sees the `thread_id` attribute on the incoming `<message>` but has no standing instruction to `set_thread` first.
**Fix candidates:** (a) Code: in `main.ts`, detect `threadId` on incoming messages and auto-call `set_thread` before injecting the message to the bot session. (b) Persona: add instruction to CLAUDE.md — "If incoming `<message>` has a `thread_id`, call `mcp__nanoclaw__set_thread` with that ID before replying." Option (a) is cleaner (no bot should have to remember this boilerplate).

---

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
**Status:** fixed (0e2f5c3, 5db9263)
**Component:** delegate-runner.ts / branch_to_thread / container lifecycle
**Symptom:** Main brain calls `branch_to_thread`, dispatches correctly, says "Thread brain spawned." But the Thread Brain never posts because the bot's container restarts (triggered by git sync detecting new commits), killing the Thread Brain child process inside the old container.
**Root cause:** Two compounding issues: (1) `branch_to_thread` spawns Thread Brain as a child process INSIDE the bot's container with `detached: true`. Container exit kills all children. (2) `--thread-id` is not a valid claude CLI flag — primary spawn always fails, fallback runs without `--resume`, but still dies when container exits.
**Fix:** Per design (02-threading.md), Thread Brains should be host-managed processes. `branch_to_thread` now writes `_runtime/relay-tasks/thread-brain-<id>.json` with `{type:'thread_brain', thread_id, objective, bot, chat_jid}`. `relayTasksLoop` in relay.ts picks it up and spawns `claude --print` on the HOST with bot credentials loaded via `loadProfileEnv()`. Thread Brain output is posted to the Matrix thread via `threadReply()`. End-to-end verified 2026-03-08.

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
**Status:** fixed (bed1bbc)
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
