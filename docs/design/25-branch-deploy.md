# 25 — Branch Deploy

**Status:** Proposed
**Date:** 2026-03-17

## Problem

All fleet bots always run from `main`. There is no way to deploy a single bot from a feature branch for live testing without either:
- Merging to main first (risky)
- Spinning up a full Holodeck (isolated, no real data)

## Solution

Extend `!wake` with an optional `--branch` flag. The bot runs in real rooms with real credentials but from a branch worktree instead of main.

```
!wake cid --branch feat/new-tool   # deploy from branch
!wake cid                          # return to main
```

## Mechanism

Reuses the Holodeck's proven code path: `git worktree → rsyncInstance → bootstrapBot`.

1. Parse `--branch <name>` in the `!wake` handler
2. `git worktree add _runtime/branch-test/{bot} <branch>`
3. Store `overrideBranch: "feat/new-tool"` on the bot's `fleet.json` entry
4. Call `bootstrapBot(branchWorktree, bot)` instead of `bootstrapBot(root, bot)`
5. Git sync loop: skip instance updates for bots with `overrideBranch` set
6. `!wake cid` (no `--branch`) or `!sleep` + `!wake` clears `overrideBranch`, removes worktree, redeploys from main

### Fleet display

`!fleet` long form shows: `🦁🏠 Cid ⚙️🥈🟢🔥 [branch: feat/new-tool]`

## Implementation Scope

~6 changes, all in `relay.ts` + `service.ts`:

| File | Change |
|------|--------|
| `relay.ts` | Parse `--branch` from `!wake` args |
| `relay.ts` | Write `overrideBranch` to fleet.json entry |
| `relay.ts` | Skip gitSync for bots with `overrideBranch` |
| `service.ts` | Add `createBranchWorktree(bot, branch)` helper |
| `service.ts` | Pass worktree path to `bootstrapBot` when `overrideBranch` is set |
| `service.ts` | Clean up worktree on `!sleep` or `!wake` without `--branch` |

## Safety

- Bot runs in **real rooms with real credentials** — this is a live canary, not a sandbox
- Use Holodeck for full isolation and integration testing
- Only one branch override per bot at a time

## Alternatives Considered

- **`!deploy <bot> <branch>`**: New dedicated command, cleaner signal, can hot-swap running bots without sleep/wake. Add later if hot-swap is needed.
- **Holodeck**: Already works for integration testing in isolated rooms. Not suitable when real data/rooms are needed.
