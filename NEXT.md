# NEXT — InfiniClaw Task Queue

Prioritized by Captain value. Top items are most urgent / highest signal. Bots: check this list, pick the top unblocked item, and work on it. Operator: review and reprioritize as the fleet evolves.

Last curated: 2026-03-14 15:28

---

## 🔴 Do Now

### ~~1. Merge PR: fix 04-ship.md doc inaccuracies~~ ✅ DONE (PR #18 merged 2026-03-14)

### ~~2. Deploy dist to sleeping bots on git sync~~ ✅ DONE (6a741d5)
`gitSyncLoop` now calls `deployBot()` for sleep-status bots after each rebuild — they'll have current code the moment they wake.

---

## 🟠 High Priority

### 3. Brain timeout cascade — resume context flood (issue #21)
Bots restart-loop when resume context exceeds 90s brain timeout. On restart, `injectResumeMessage()` sends last 10 messages + tasks. If that prompt takes >90s, brain is SIGKILL'd (exit 137), bot restarts again with same context → loop until `KILL_137_MAX_CONSECUTIVE` (3) kills engage 60s cooldown. Bot can be unresponsive for ~4.5 minutes.
**Fix options:** (a) reduce resume context from 10 messages to 3-5, (b) extend/exempt timeout for resume turns, (c) on timeout-killed resume, halve context for next attempt.
**Files:** `src/main.ts:1356` (`injectResumeMessage`), `src/main.ts:1068` (timeout kill), `src/main.ts:281` (`KILL_137_MAX_CONSECUTIVE`).
**Who:** Parker (engineer).

### 4. Boot pip transitions (🔄 → 🚀 → 🟡 → 🟢)
`setStatusPip()` is a no-op in `channels/matrix.ts`. The bot's display name pip stays static during boot. Implementing the four boot stages gives the Captain real-time visibility into which bot is in which boot phase.
**Design:** `05-bot.md` — Dynamic pip transitions section.
**Who:** Parker (engineer).
**File:** `src/channels/matrix.ts`, `setStatusPip()`.

### ~~5. Main timeline summary after branch brain completes~~ ✅ DONE
Posts `🧵 <title> — ✅ done` (or `⛔ failed`) on main timeline when debounce fires after branch brain exits. Implemented in `src/relay.ts` `spawnBranchBrain()` debounce callback.

### 6. @room cross-room routing from bots
Bots cannot currently send messages to another room (e.g., engineer → astrometrics). `@room:` is unimplemented. This would enable proper cross-room delegation.
**Design:** `02-matrix.md`, `13-intercom.md`.
**Who:** Parker.

---

## 🟡 Medium Priority

### 7. Context injection: fan main timeline messages to active branch brains
When a new message arrives on the main timeline, the relay should fan it to all active branch brain IPC queues with context (it may not apply; brain ignores if irrelevant).
**Design:** `08-threading.md` — "Context Injection" status block.
**Who:** Parker.

### 8. Thread reactivation — follow-up messages spawn new branch brains
After a branch brain completes, follow-up messages in that thread should be able to spawn a new branch brain continuing the work. Currently impossible.
**Design:** `08-threading.md` — "Thread reactivation" status block.
**Who:** Parker.

### 9. Per-task model selection for branch brains
Branch brains currently use the bot's `BRAIN_MODEL` env var. The design calls for the bot's persona/memory to specify per-task model selection (e.g., sonnet for complex engineering, haiku for quick lookups).
**Design:** `06-brain.md` — "Per-task model selection" status block.
**Who:** Parker.

---

## 🟢 Lower Priority

### 10. Lobe end-to-end workflow
`delegate_to_lobe` tool exists but the full workflow (quarters thread posting, completion notification, bot pickup) is not production-ready.
**Design:** `06-brain.md` — Lobe section.
**Who:** Parker or Cid (when HERACLES active).

### 11. Branch brain upgrade: full interactive session
Replace one-shot `claude --print` with a full nanoclaw group container session. Enables resumable, interactive, time-limited branch brains.
**Design:** `08-threading.md` — "Branch Brain Upgrade" status block.
**Who:** Parker + Cid collaboration.

### 12. Skills module (17-skills.md)
Pooled capability modules per role. Not yet implemented. Big feature.
**Design:** `17-skills.md`.
**Who:** Architect (Albert when HERACLES active) + engineers.

---

## 📋 Housekeeping

- ~~Inbox item "Wake Parker"~~ — marked done in secrets inbox.
- ~~Git push ETIMEDOUT~~ — last seen 2026-03-14 13:59, resolved; subsequent syncs succeeded.
- HERACLES is active — operator sent `!pull heracles` at 14:38, 14:48, 15:13 today. Safe to assign work to Cid/Albert there.
