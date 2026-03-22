# 27 — Alignment System

**Status:** Proposed
**Date:** 2026-03-22
**WBS:** 18, 18.1–18.8

## Problem

Bots deploy from main with no automated pre-flight check. A bad commit can break message routing, thread handling, command processing, or signal parsing — and the first signal is a production failure in a real Matrix room. Manual testing catches some issues but is inconsistent and slow.

## Solution

An alignment harness that boots a bot in a holodeck sandbox, injects test messages, and asserts expected behavior — all before the bot goes live. The harness reuses existing holodeck infrastructure (`holodeck_create`, `holodeck_send`, `holodeck_read`, `holodeck_teardown`).

## Architecture

```
┌──────────────────────────────────────────┐
│  Alignment Runner                        │
│                                          │
│  1. holodeck_create(bot, branch)         │
│  2. Wait for bot ready (poll holodeck)   │
│  3. Run test suite (inject → assert)     │
│  4. Collect results                      │
│  5. holodeck_teardown(bot)               │
│  6. Return pass/fail + evidence          │
└──────────────────────────────────────────┘
```

### Test flow

Each test case is a function: `(bot: string) => Promise<AlignmentResult>`.

```typescript
interface AlignmentResult {
  name: string;
  passed: boolean;
  evidence: string; // what was checked, what was found
}

interface AlignmentReport {
  bot: string;
  branch: string;
  timestamp: string;
  results: AlignmentResult[];
  passed: boolean; // all results passed
}
```

### Test cases (WBS 18.2–18.7)

| ID | Test | Method |
|----|------|--------|
| 18.2 | `{{branch}}` signal creates BB container | Send message with `{{branch ...}}`, read output, verify BB spawned |
| 18.3 | Command handling (`!fleet`, `!health`, `!wbs`) | Send each command, verify response format |
| 18.4 | Tool output uses S3 breadcrumbs | Trigger tool-heavy operation, verify no `<details>` in output |
| 18.5 | Thread routing — replies stay in thread | Send threaded message, verify response lands in same thread |
| 18.6 | `{{send}}` cross-room routing | Send `{{send target}}` message, verify delivery |
| 18.7 | No `Co-Authored-By` in commits | Check git log of branch for prohibited patterns |

### Integration (WBS 18.8)

`!wake` gains an `--align` flag (default: on for new deploys from main). Before starting the bot:

1. Run alignment harness against the branch
2. If all tests pass → proceed with normal boot
3. If any test fails → block deploy, report failures to room

```
!wake cid              # runs alignment first, then boots
!wake cid --no-align   # skip alignment (escape hatch)
```

## Harness Implementation (WBS 18.1)

The harness is a single module.

```typescript
export async function runAlignment(bot: string, branch: string): Promise<AlignmentReport>;
```

Steps:
1. `holodeckCreate(bot, branch)` — deploys branch to isolated instance
2. Poll `holodeckStatus(bot)` until bot is ready (max 60s timeout)
3. Run each test case sequentially (order matters — some tests depend on bot state)
4. Collect `AlignmentResult[]`
5. `holodeckTeardown(bot)` — always, even on failure
6. Return `AlignmentReport`

### Bot readiness check

After `holodeck_create`, the bot needs time to boot. The harness polls via `holodeck_send` with a ping message and checks `holodeck_read` for a response. Timeout: 60 seconds, poll interval: 3 seconds.

### Test registration

Tests are registered in an array — easy to add new ones:

```typescript
const ALIGNMENT_TESTS: AlignmentTest[] = [
  { name: 'commit-hygiene', fn: testNoCoAuthoredBy },
  { name: 'command-handling', fn: testCommands },
  // ... more as WBS 18.2–18.7 ship
];
```

### IPC integration

New IPC command: `alignment_run` — triggers alignment from relay context.

```typescript
// In ipc-commands.ts
case 'alignment_run': {
  const { bot, branch } = payload;
  const report = await runAlignment(bot, branch);
  return report;
}
```

### MCP tool

Exposed as `mcp__infiniclaw__run_alignment` so bots can self-align before requesting promotion.

## What This Does NOT Do

- Replace the holodeck for exploratory testing — alignment is automated pass/fail only
- Test every feature — only critical invariants that have broken production before
- Run on every commit — only on deploy (`!wake`) or explicit request

## Verification

1. **Harness boots holodeck** — `runAlignment('tali', 'main')` creates and tears down a holodeck instance.
   *Check:* No leftover worktrees or containers after run.

2. **Passing branch passes** — Run alignment against `main`.
   *Check:* All tests pass, report shows `passed: true`.

3. **Failing branch fails** — Create a branch with `Co-Authored-By` in a commit.
   *Check:* `commit-hygiene` test fails, report shows `passed: false` with evidence.

4. **`!wake` integration** — `!wake cid` runs alignment before boot.
   *Check:* Bot only starts after alignment passes.
