# 28 — Branch Brain Accounts

**Status:** Proposed
**Date:** 2026-03-23
**WBS:** TBD

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

3 accounts matches the existing BB concurrency limit per bot. If all 3 are active, new BB requests queue until one frees up.

### Activation Lifecycle

```
1. MB dispatches {{branch Fix the crash}}
2. Relay selects idle account from pool (e.g. @bb1-tali)
3. Relay sets display name → "384729-tali" (random 6-digit index)
4. Account joins room (if not already member)
5. BB works in thread under identity "384729-tali"
6. BB finishes → posts summary callout to MB in thread
7. MB reviews thread, can exchange with BB (distinct identities)
8. MB posts {{merge}} → relay posts squash summary to main timeline
9. Display name resets, @bb1-tali returns to idle pool
10. Next activation → same account becomes "517203-tali"
```

### Display Name Convention

```
<6-digit random index>-<bot name>
```

Examples: `384729-tali`, `517203-parker`, `091844-cid`

- The numeric index makes each activation unique and traceable in room history
- The bot name suffix identifies which MB owns this BB
- Random (not sequential) to avoid implying ordering

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
```

The `{{merge}}` signal is new. Until MB sends it, the thread stays open and results stay in the thread. MB controls when and how results reach the main timeline.

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

- **Registration:** One-time setup via Synapse admin API or manual registration
- **Credentials:** Stored in bot env files alongside main account credentials
- **Homeserver:** Same as fleet (`matrix.a-gis.org`)
- **Persistence:** Accounts are permanent — no create/deactivate per task
- **Display name:** Only state that changes per activation

## What This Does NOT Change

- BB container spawning — same process, just different Matrix credentials
- BB code execution — same agent-runner, same tools
- Thread creation — relay still creates the thread root
- IPC tasks — same git_push, rebuild_image pipeline

## Verification

1. **Pool allocation** — BB dispatch selects idle account, sets display name, marks busy
2. **Identity separation** — BB messages in thread show distinct sender from MB
3. **MB review** — MB can post in thread and BB sees/responds to it
4. **Merge control** — thread stays open until MB sends `{{merge}}`
5. **Squash summary** — main timeline gets single structured result message
6. **Pool return** — on merge, display name resets, account returns to idle pool
