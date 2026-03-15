---
name: wbs-management
description: Understand and operate within the room's Work Breakdown Structure. All bots learn the system; only the Chief (lowest-rank active bot) can modify the WBS and assign todos. Enforced by MCP permission checks.
---

# WBS Management

Every duty room has a Work Breakdown Structure (WBS) — the single source of truth for all work in scope. All bots understand how it works. **Only the Chief (lowest-rank active bot in the room) can modify the WBS and assign todos.** This is enforced at the InfiniClaw MCP level — non-Chief bots calling write operations are rejected.

If you are the Chief, you manage the WBS: decompose, estimate, schedule, assign, review, complete. If you are crew, you observe your assignments and execute work — posting results in the room for the Chief to review.

## WBS Principles

- **100% Rule**: The WBS captures all work in scope. Every child sums to its parent. No gaps, no extras.
- **Mutually Exclusive**: No work item appears under two parents.
- **Outcome-Oriented**: Items describe deliverables, not activities. "Authentication module" not "code authentication."
- **8/80 Rule**: Work packages take 8-80 hours. Below 8 is over-decomposed; above 80 needs breakdown.
- **Rolling Wave**: Near-term work is detailed; future work stays at higher levels.

## Item Hierarchy

```
Phase (Level 1)
  Deliverable (Level 2)
    Work Package (Level 3)
      Task (Level 4 — assignable unit)
```

Only tasks (leaf nodes) are assigned to bots. Work packages, deliverables, and phases track progress by aggregating their children.

## Item Fields

Each WBS item has:

| Field | Purpose |
|---|---|
| `id` | Hierarchical code (e.g., "1.2.3") |
| `parent` | Parent WBS ID (null for root) |
| `title` | Short name |
| `description` | Detailed scope |
| `type` | `phase`, `deliverable`, `work_package`, `task`, `milestone` |
| `status` | `pending`, `ready`, `assigned`, `in_progress`, `review`, `done`, `blocked`, `cancelled` |
| `priority` | `critical`, `high`, `medium`, `low` |
| `assignee` | Bot name (null if unassigned) |
| `source` | GitHub issue, PR, or Captain directive |
| `acceptance_criteria` | How to verify completion |
| `dependencies` | Predecessor items and relationship type |
| `estimates` | PERT three-point (optimistic, likely, pessimistic) |
| `actual` | Measured start time, end time, effort |
| `due_date` | Target completion (if set by Captain) |

## PERT Estimation

Always estimate with three points:

- **O** = Optimistic (best case)
- **M** = Most Likely (normal conditions)
- **P** = Pessimistic (complications arise)

Compute:
```
Expected = (O + 4M + P) / 6
Std Dev  = (P - O) / 6
```

Bot tasks have high variance — set the O/P spread wider than you would for humans. A task that takes 1h optimistically might take 6h pessimistically if the bot gets stuck or needs restart.

## Dependencies

Support two types:

- **FS (Finish-to-Start)**: B can't start until A finishes. Most common.
- **SS (Start-to-Start)**: B can start once A starts. For parallel work.

Record as: `{"predecessor": "1.2.1", "type": "FS", "lag": 0}`

## Critical Path

The critical path is the longest chain of dependent tasks. It determines the minimum project duration.

1. **Forward pass**: Compute earliest start/finish for each task
2. **Backward pass**: Compute latest start/finish from the end
3. **Float** = Latest Start - Earliest Start
4. Tasks with **zero float** are critical — any delay delays everything

**Always assign critical-path tasks first, to the most capable bot.**

## Assignment Algorithm

When assigning work:

1. Filter: tasks whose dependencies are all satisfied (`status: ready`)
2. Sort by:
   a. Critical path membership (critical first)
   b. Priority (`critical` > `high` > `medium` > `low`)
   c. Least float (most time-sensitive first)
   d. Unblock count (tasks that free the most downstream work)
3. Match to available bots by capability
4. Assign — update `assignee` and `status: assigned`

## Completion Flow

Bots **cannot** modify the WBS. The flow is:

```
Bot finishes work → posts results in room
  → Chief reviews output
  → Chief marks item done in WBS
  → Relay unblocks dependents
  → Chief assigns newly-ready items
```

Use **0/100 completion** — items are 0% until done, then 100%. No partial credit. Bot work is atomic.

## Rebalancing

When a bot goes off duty:
1. Reabsorb its assigned items (`assignee: null, status: ready`)
2. Re-run assignment for remaining bots

When a new bot reports for duty:
1. Add to available pool
2. Assign highest-priority ready task

## Earned Value Management

Track these metrics:

| Metric | Formula | Meaning |
|---|---|---|
| PV (Planned Value) | Sum of estimates for scheduled work | How much should be done |
| EV (Earned Value) | Sum of estimates for completed work | How much is done |
| AC (Actual Cost) | Sum of actual effort | How much was spent |
| SPI | EV / PV | Schedule performance (< 1.0 = behind) |
| CPI | EV / AC | Cost performance (< 1.0 = over budget) |

Use EVM to forecast:
```
EAC = Total Budget / CPI          (Estimate at Completion)
Completion Date = Today + (Remaining / Velocity)
```

## Velocity

Track per-bot and room-wide velocity:
```
Velocity = completed task estimates / time period
```

Use trailing 3-period rolling average to smooth variance. Report velocity trends in status updates.

## Flow Metrics

| Metric | What it measures |
|---|---|
| Cycle Time | Start to finish per task |
| Lead Time | Created to finished per task |
| WIP | Count of in_progress items |
| Throughput | Completions per day |
| Blocked Rate | Blocked / total (health signal) |

## When You Are the Only Bot

If you are the sole onduty bot, you are automatically Chief. Self-assign from the WBS and execute. No delegation overhead. When a second bot arrives, redistribute work.

## Storage

- **S3**: Source of truth (`wbs/{room}.json`)
- **Secrets repo**: JSON disk echo (downstream artifact, git-tracked)
- **MCP tools**: InfiniClaw MCP server provides WBS tools (Chief-only write, all-bot read)

## Rules

- **Never skip estimation.** Every task gets a PERT estimate before assignment.
- **Protect the critical path.** Assign critical tasks first, to the best bot.
- **Record actuals.** The system improves only if you track what really happened.
- **One writer.** Only you modify the WBS. Bots report; you update.
- **Kanban flow.** Pull-based assignment, WIP limit of 1 per bot. No sprints.
