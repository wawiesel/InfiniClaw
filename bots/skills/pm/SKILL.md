---
name: pm
description: Project management skill for engineer-role bots. Covers WBS triage, crew assignment, status reporting, and weekly summaries. Chief-only for WBS writes; any bot can generate status reports.
---

# PM (Project Management)

The `pm` skill enables engineer-role bots to manage the room WBS and generate status reports for the Captain.

## Chief Responsibilities

The **Chief** (lowest-rank active bot) owns all WBS mutations:

1. **Triage directives** — Convert Captain directives and 👎 reactions into WBS items via `wbs_write`
2. **Assign work** — Use `wbs_assign` to give `ready` items to available crew bots (priority order, WIP limit = 1)
3. **Mark done** — Call `wbs_complete` when a bot reports success; relay unblocks dependents
4. **Unblock items** — When a dependency is marked done, verify its dependents transition `backlog → ready`

See the `wbs-management` skill for schema, status flow, and item quality rules.

## Status Reporting

Any bot can generate a status summary on request:

```
wbs_read → summarize counts by status → post to room or upload to S3
```

**Summary format:**

```
## WBS Status — {date}
- Done:        {n} items
- In Progress: {n} items (assigned to: {names})
- Ready:       {n} items (unblocked, unassigned)
- Backlog:     {n} items (blocked by dependencies)

### Blocked items
- {id} "{title}" — waiting on {dep_ids}

### In Progress
- {id} "{title}" — {assigned_to}
```

To upload a report to S3:

```bash
aws s3 cp report.md s3://infiniclaw/reports/{room}/{date}-status.md
```

## Weekly Summary

On the Captain's weekly review prompt, generate:

```
## Weekly Summary — {week ending date}

### Completed this week
- {id} "{title}"

### Carried over
- {id} "{title}" — {reason if known}

### Blockers
- {description of any items stuck > 3 days}

### Next week focus
- Top 3 ready items by priority
```

Post to room or upload: `s3://infiniclaw/reports/{room}/weekly-{date}.md`

## Rules

- **Chief only writes** — Only the Chief calls `wbs_write`, `wbs_assign`, `wbs_complete`
- **One item per bot** — Never assign a second item until the first is done
- **Source every item** — Always populate `source` (directive text, issue URL, or reaction)
- **No orphan items** — Every item must roll up to a parent or the root deliverable
