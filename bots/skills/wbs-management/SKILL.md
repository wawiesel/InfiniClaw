---
name: wbs-management
description: Understand and operate within the room's Work Breakdown Structure. Chief (lowest-rank active bot) modifies the WBS; crew executes assigned items.
---

# WBS Management

Every duty room has a Work Breakdown Structure (WBS) at `_runtime/data/wbs-{room}.json` — the single source of truth for all work in scope. **Only the Chief (lowest-rank active bot) modifies the WBS.** Crew bots execute their assigned items and report results.

## What Makes a Good WBS

A WBS is a **deliverable-oriented hierarchical decomposition** of project scope. It answers "what must be produced?" — not "what must be done?"

### Core Rules

1. **100% Rule** — The WBS captures ALL work in scope. Children sum to parent. No gaps, no extras.
2. **Deliverables, not activities** — Items are nouns (outcomes), not verbs (actions).
3. **Mutually exclusive** — No work appears under two parents.
4. **3 levels deep** — Phase → Deliverable → Work Package. Don't over-decompose.

### Good WBS vs Bad WBS

**Good** — deliverable-focused, clear scope, right granularity:
```
1. Fleet Command System
  1.1 X-Command Framework
    1.1.1 Command registry with dispatch
    1.1.2 Speaker election protocol
    1.1.3 Help system
  1.2 Fleet Status Display
    1.2.1 Ship health aggregation
    1.2.2 Bot tree with activity indicators
    1.2.3 Summary footer
  1.3 Bot Lifecycle Commands
    1.3.1 Wake/sleep handlers
    1.3.2 Report/dismiss handlers
    1.3.3 Transport protocol
```

**Bad** — activity-focused, vague, wrong level of detail:
```
1. Work on commands
  1.1 Write code for fleet command     ← activity, not deliverable
  1.2 Test everything                  ← too vague, not measurable
  1.3 Fix bugs                         ← reactive, not scoped
  1.4 Update README                    ← administrative noise
  1.5 Deploy to production             ← activity, not deliverable
```

**Bad** — over-decomposed, micro-managed:
```
1.1.1 Create file command-registry.ts
1.1.2 Write CommandDef interface       ← too granular
1.1.3 Implement exact() matcher        ← implementation detail
1.1.4 Implement prefix() matcher       ← these are subtasks of one item
1.1.5 Add fleet entry to COMMANDS
1.1.6 Export dispatch function
```

### How to Tell Good from Bad

| Signal | Good WBS | Bad WBS |
|--------|----------|---------|
| Items are... | Nouns (deliverables) | Verbs (activities) |
| Scope is... | 100% covered, no gaps | Missing pieces or has extras |
| Granularity | 8-80 hours per work package | Too fine (< 1 hour) or too coarse (> 2 weeks) |
| Dependencies | Explicit, minimal | Implicit or circular |
| Completion test | Clear: "it works when..." | Vague: "it's done when I say so" |

## Schema

Each WBS item:

| Field | Type | Purpose |
|-------|------|---------|
| `id` | `string` | Hierarchical code: `"1.2.3"` |
| `title` | `string` | Short deliverable name (noun) |
| `source` | `string?` | GitHub issue, Captain directive, or 👎 reaction |
| `depends_on` | `string[]` | IDs that must be `done` before this can start |
| `assigned_to` | `string?` | Bot name, or null = unassigned |
| `status` | `enum` | `backlog` → `ready` → `in_progress` → `done` |
| `priority` | `number` | Lower = higher priority |

## Status Flow

```
backlog ──(dependencies met)──→ ready ──(assigned)──→ in_progress ──(verified)──→ done
```

- **backlog**: Blocked by unfinished dependencies
- **ready**: All dependencies done, available for assignment
- **in_progress**: Assigned to a bot, work underway
- **done**: Deliverable verified and accepted

## How It Works

1. **Chief decomposes** Captain directives and 👎 reactions into WBS items
2. **Chief assigns** highest-priority ready items to available bots
3. **Bot executes** and posts results in the room
4. **Chief reviews** and marks done — relay unblocks dependents
5. **Relay auto-assigns** on heartbeat if bot is idle and items are ready

## Assignment Rules

- Priority order: lowest `priority` number first
- Only `ready` items with `assigned_to: null` are eligible
- One item per bot at a time (WIP limit = 1)
- When a bot goes off-duty, its items revert to `ready`/unassigned

## Writing Good Items

Each item should have:
- **Clear title** — a deliverable you can point to when done
- **Source** — where the requirement came from (traceability)
- **Dependencies** — only if genuinely blocked, not just preferred order
- **Right priority** — Captain's urgency, not your preference

Bad title: "Fix the thing" — which thing? How do you know it's fixed?
Good title: "Fleet display with visible activity indicators" — specific, verifiable.
