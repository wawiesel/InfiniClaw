# NEXT — InfiniClaw Task Queue

Prioritized by Captain value. Top items are most urgent / highest signal. Bots: check this list, pick the top unblocked item, and work on it. Operator: review and reprioritize as the fleet evolves.

Last curated: 2026-03-14

---

## 🔴 Do Now

### 1. Merge PR: fix 04-ship.md doc inaccuracies
Branch `docs/fix-04-ship-relay-accuracy` is open. Fixes: speaker election algorithm (rank-only, not S3/epoch), heartbeat loop description (nudges idle bots, not "relay liveness"), missing metricsLoop row (7 loops total).
**Who:** Operator reviews + merges.
**Blocked by:** Nothing.

### 2. Deploy dist to sleeping bots on git sync (code changes)
**Issue:** When a rebuild happens, only `onduty` and `quarters` bots get restarted (`RUNNING_STATUSES`). Sleeping bots have stale dist. When they wake up, they run old code until the next sync cycle rebuilds again (3 min gap). Captain said: "Even when they're sleeping they need to participate in sync."
**Fix:** In `gitSyncLoop` after rebuild, also call `deployBot(root, bot)` for `sleep`-status bots that belong to this ship (no restart, just deploy dist).
**Who:** Parker or operator.
**File:** `src/relay.ts` ~L1428 in gitSyncLoop.

---

## 🟠 High Priority

### 3. Boot pip transitions (🔄 → 🚀 → 🟡 → 🟢)
`setStatusPip()` is a no-op in `channels/matrix.ts`. The bot's display name pip stays static during boot. Implementing the four boot stages gives the Captain real-time visibility into which bot is in which boot phase.
**Design:** `05-bot.md` — Dynamic pip transitions section.
**Who:** Parker (engineer).
**File:** `src/channels/matrix.ts`, `setStatusPip()`.

### 4. Main timeline summary after branch brain completes
When a branch brain finishes, the result only appears inside the thread. The Captain monitoring the main timeline has no signal that work completed.
**Fix:** After branch brain exits + debounce, post a one-line summary on the main timeline: `🧵 <objective> — done` (or `⛔ failed`).
**Design:** `08-threading.md` — "Main timeline summary" status block.
**Who:** Parker (engineer).
**File:** `src/relay.ts` — after `branchBrainRestartTimers` debounce in `spawnBranchBrain()`.

### 5. @room cross-room routing from bots
Bots cannot currently send messages to another room (e.g., engineer → astrometrics). `@room:` is unimplemented. This would enable proper cross-room delegation.
**Design:** `02-matrix.md`, `13-intercom.md`.
**Who:** Parker.

---

## 🟡 Medium Priority

### 6. Context injection: fan main timeline messages to active branch brains
When a new message arrives on the main timeline, the relay should fan it to all active branch brain IPC queues with context (it may not apply; brain ignores if irrelevant).
**Design:** `08-threading.md` — "Context Injection" status block.
**Who:** Parker.

### 7. Thread reactivation — follow-up messages spawn new branch brains
After a branch brain completes, follow-up messages in that thread should be able to spawn a new branch brain continuing the work. Currently impossible.
**Design:** `08-threading.md` — "Thread reactivation" status block.
**Who:** Parker.

### 8. Per-task model selection for branch brains
Branch brains currently use the bot's `BRAIN_MODEL` env var. The design calls for the bot's persona/memory to specify per-task model selection (e.g., sonnet for complex engineering, haiku for quick lookups).
**Design:** `06-brain.md` — "Per-task model selection" status block.
**Who:** Parker.

---

## 🟢 Lower Priority

### 9. Lobe end-to-end workflow
`delegate_to_lobe` tool exists but the full workflow (quarters thread posting, completion notification, bot pickup) is not production-ready.
**Design:** `06-brain.md` — Lobe section.
**Who:** Parker or Cid (when HERACLES active).

### 10. Branch brain upgrade: full interactive session
Replace one-shot `claude --print` with a full nanoclaw group container session. Enables resumable, interactive, time-limited branch brains.
**Design:** `08-threading.md` — "Branch Brain Upgrade" status block.
**Who:** Parker + Cid collaboration.

### 11. Skills module (17-skills.md)
Pooled capability modules per role. Not yet implemented. Big feature.
**Design:** `17-skills.md`.
**Who:** Architect (Albert when HERACLES active) + engineers.

---

## 📋 Housekeeping

- Inbox item "Wake Parker" is stale — Parker is already onduty. Mark done in `secrets/operator/inbox.md`.
- Git push to GitHub is failing with `ETIMEDOUT` (last seen 13:55). Likely transient network. Monitor relay logs; if persists, check network and retry `!push`.
- HERACLES relay status unknown — Cid and Albert are on HERACLES. Verify HERACLES is online before assigning them work.
