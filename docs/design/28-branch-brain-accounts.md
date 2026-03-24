# 28 — Branch Brain Accounts

**Status:** Proposed
**Date:** 2026-03-23
**WBS:** TBD
**Supersedes:** Portions of [08-threading.md](08-threading.md) (BB merge flow)

## Terminology

| Abbreviation | Meaning |
|---|---|
| **MB** | Main Brain — the bot's primary process, always running |
| **BB** | Branch Brain — a temporary worker spawned for a task |
| **MT** | Main Timeline — the room's top-level message stream |
| **BT** | Branch Thread — a Matrix thread where a BB works |

These terms are used throughout InfiniClaw design docs.

## Problem

Branch brains (BBs) share their parent bot's Matrix identity. This causes:

1. **No review step.** BB auto-merges — main brain (MB) gets a bare "merged" notification with no summary, no diff, no chance to review or ask questions before results hit the main timeline.
2. **Identity ambiguity.** BB and MB messages come from the same sender, so the relay must do complex routing to distinguish them. Room history shows one user talking to itself.
3. **No exchange.** MB cannot converse with BB in the thread — both are the same account, so there's no natural back-and-forth.

## Solution

Each bot gets **3 permanent BB Matrix accounts**. On activation, the account's display name is set to a random 6-digit index + bot name. BB works under that distinct identity. MB reviews in the thread and decides when to merge.

## Architecture

### Account Pool

Each fleet bot gets 3 dedicated BB accounts:

| Bot | BB Accounts |
|---|---|
| Tali | `@bb1-tali`, `@bb2-tali`, `@bb3-tali` |
| Parker | `@bb1-parker`, `@bb2-parker`, `@bb3-parker` |
| Cid | `@bb1-cid`, `@bb2-cid`, `@bb3-cid` |

3 accounts matches the existing BB concurrency limit (`MAX_BRANCH_BRAINS_PER_BOT=3`). If all 3 are active, new BB requests queue until one frees up.

### Activation Lifecycle

```
1. MB dispatches {{branch Fix the crash}}
2. Relay selects idle account from pool (e.g. @bb1-tali)
3. Relay sets display name → "384729-tali" (random 6-digit index) — BEFORE joining the room
4. BB joins the room
5. Relay posts thread root message identifying the active BB account (display name + Matrix ID + task ref)
6. BB works in thread under identity "384729-tali"
7. BB finishes → posts summary callout to MB in thread
8. MB reviews thread, can exchange with BB (distinct identities)
9. MB posts {{merge}} → relay posts squash summary to main timeline
   — OR MB posts {{abort}} → relay posts cancellation notice, discards
10. BB leaves the room
11. Display name resets, @bb1-tali returns to idle pool
12. Next activation → same account becomes "517203-tali"
```

### Timeout and Crash Cleanup

If a BB crashes or MB never sends `{{merge}}`/`{{abort}}`, the pool account would stay "busy" forever. Reuse the existing `BRANCH_BRAIN_TIMEOUT_MS` to reclaim:

- When BB container exits (success or crash), start a reclaim timer
- If MB hasn't sent `{{merge}}` or `{{abort}}` within `BRANCH_BRAIN_TIMEOUT_MS`, relay auto-reclaims the account, posts timeout notice to thread, and returns account to pool
- If BB container itself times out (existing behavior), same reclaim applies

### Display Name Convention

```
<6-digit random index>-<bot name>
```

Examples: `384729-tali`, `517203-parker`, `091844-cid`

- The numeric index makes each activation unique and traceable in room history
- The bot name suffix identifies which MB owns this BB
- Random (not sequential) to avoid implying ordering

### Thread Root Message

The relay must post a thread root message that identifies the active BB account **before** BB sends any work messages. Required fields:

- **Display name** — the randomised identity for this activation (e.g. `384729-tali`)
- **Matrix ID** — the underlying pool account (e.g. `@bb1-tali:matrix.a-gis.org`)
- **Task reference** — the branch task description from the `{{branch}}` signal

Example:
```
BB activated: 384729-tali (@bb1-tali:matrix.a-gis.org)
Task: Fix the crash
```

This lets MB (and room observers) immediately correlate the thread to a specific pool account and task without inspecting relay logs.

### MB Review Protocol

Current model (fire-and-forget):
```
MB → {{branch}} → BB works → BB auto-merges → MB gets bare notification
```

New model (review-and-merge):
```
MB → {{branch}} → BB works → BB posts summary → MB reviews in thread
→ MB asks questions / requests changes → BB responds
→ MB posts {{merge}} → relay squash-posts to main timeline
— OR —
→ MB posts {{abort}} → relay posts cancellation, discards results
```

**`{{merge}}`** — MB approves. Relay posts squash summary to main timeline, returns account to pool.

**`{{abort}}`** — MB rejects. Relay posts cancellation notice to thread and main timeline, returns account to pool. No squash summary.

### Squash Summary

On `{{merge}}`, relay posts a single message to the main timeline:

```
🪾 Fix the crash — ✅ merged
  Files: relay.ts (+12, -3)
  Summary: Fixed OOM in thread routing by capping active thread map size
  Commit: abc1234
  Tests: tsc clean, 394 passed
```

One message. Everything relevant. No churn.

## Account Management

- **Registration:** One-time setup via Conduwuit admin API or manual registration
- **Room membership:** Per-activation — BB accounts join the room **after** the display name is set and **leave** when the activation ends (merge, abort, or timeout). Accounts are not room members while idle.
- **Homeserver:** Same as fleet (`matrix.a-gis.org`)
- **Persistence:** Accounts are permanent — no create/deactivate per task
- **Display name:** Only state that changes per activation

### Credential Configuration

BB credentials stored in each bot's env file:

```
BB_POOL_USER_1=@bb1-tali:matrix.a-gis.org
BB_POOL_TOKEN_1=syt_...
BB_POOL_USER_2=@bb2-tali:matrix.a-gis.org
BB_POOL_TOKEN_2=syt_...
BB_POOL_USER_3=@bb3-tali:matrix.a-gis.org
BB_POOL_TOKEN_3=syt_...
```

Relay reads these at startup and initializes the pool.

### Pool Size Validation

At startup, relay counts configured `BB_POOL_USER_N` env vars to determine actual pool size. If `MAX_BRANCH_BRAINS_PER_BOT` exceeds pool size:

1. **Hard clamp** — effective max = min(MAX_BRANCH_BRAINS_PER_BOT, pool size)
2. **Warning** — post alert to engineering room and BTC:
   ```
   ⚠️ BB pool misconfiguration: MAX_BRANCH_BRAINS_PER_BOT=5 but only 3 pool accounts configured. Clamped to 3.
   ```

This prevents silent failures where the relay tries to activate a BB account that doesn't exist.

## Relationship to Existing Design Docs

This doc supersedes the BB merge flow defined in [08-threading.md](08-threading.md). Specifically:

- **08-threading.md** defines BB threads as fire-and-forget with auto-merge. This doc replaces that with MB-controlled `{{merge}}`/`{{abort}}`.
- **08-threading.md** thread routing remains unchanged — BB messages still go to threads, MB messages still go to main timeline.
- **22-signals.md** gains two new signals: `{{merge}}` and `{{abort}}`.

## What This Does NOT Change

- BB container spawning — same process, just different Matrix credentials
- BB code execution — same agent-runner, same tools
- Thread creation — relay still creates the thread root
- IPC tasks — same git_push, rebuild_image pipeline

## Verification

1. **Pool allocation** — BB dispatch selects idle account, marks busy
2. **Display name first** — display name is set to `<index>-<bot>` before BB joins the room; the account must not appear in the room under the old name
3. **Join on activation** — BB account is not a room member while idle; it joins only after display name is set
4. **Thread root identifies BB** — the relay-posted thread root message includes the display name, Matrix ID, and task reference before any BB work messages
5. **Identity separation** — BB messages in thread show distinct sender from MB
6. **MB review** — MB can post in thread and BB sees/responds to it
7. **Merge control** — thread stays open until MB sends `{{merge}}`
8. **Abort control** — `{{abort}}` cancels thread, returns account to pool
9. **Leave on deactivation** — BB leaves the room on merge, abort, or timeout reclaim; idle accounts have no room membership
10. **Timeout reclaim** — crashed/abandoned BBs reclaimed after BRANCH_BRAIN_TIMEOUT_MS
11. **Squash summary** — main timeline gets single structured result message
12. **Pool return** — on merge/abort/timeout, display name resets, account returns to idle pool
