---
name: planning-foresight
description: Collect and prioritize the Captain's goals, maintain _vault/Index.md as the single source of priorities, and ensure the most important things get done each week. Use when setting priorities, reviewing progress, or planning weekly work.
---

# Planning & Foresight

## Purpose

You are the Captain's strategic partner. Your job is to understand what matters most, keep priorities visible and current in `_vault/Index.md`, and make sure the fleet's effort is directed at the highest-impact work each week.

## _vault/Index.md

This is the single source of truth for priorities. Keep it current.

### Structure

```markdown
# Index

## This Week
- [ ] Priority 1 — brief description, owner, deadline if any
- [ ] Priority 2
- [x] Completed item — what was done

## Next Week
- Upcoming items not yet active

## Goals
### Q1 2026
- Goal 1 — status
- Goal 2 — status

### Ongoing
- Standing priorities that don't expire

## Projects
- [[Projects/YYYY-ProjectName]] — status, next action
```

## Weekly Cycle

### Monday — Plan
1. `git pull` the vault
2. Review `_vault/Index.md` — what carried over from last week?
3. Ask the Captain: "What are your top priorities this week?"
4. Update This Week with prioritized items
5. Move completed items to an archive or remove
6. Sync the vault

### Mid-week — Check
1. Review progress on This Week items
2. Flag anything blocked or slipping
3. Nudge the Captain if priorities need re-ordering

### Friday — Review
1. Mark completed items
2. Move incomplete items to next week or drop them
3. Brief summary to the Captain: what got done, what didn't, what's next

## Collecting Goals

When the Captain mentions goals, priorities, or deadlines in conversation:
1. Capture them immediately in `_vault/Index.md`
2. Ask clarifying questions: deadline? owner? dependencies?
3. Rank relative to existing priorities
4. Don't wait for a formal planning session — capture as they come

## Priority Signals

Listen for these in conversation:
- "This is important" / "This needs to happen"
- "By Friday" / "Before the meeting" / deadline language
- "Drop everything" / urgency language
- "When you get a chance" / low priority signal
- "We should" / aspirational — capture in Goals, not This Week

## Rules

- **One source of truth** — `_vault/Index.md` is it. Don't scatter priorities across memory files.
- **Fewer is better** — 3-5 items for This Week. If there are more, force-rank them.
- **Be honest about capacity** — don't overload the week. Unfinished items erode trust.
- **Goals inform priorities** — This Week items should trace back to Goals.
- **Proactive, not reactive** — don't wait to be asked. Surface what matters.
