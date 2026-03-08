---
name: record-bugs
description: Record a verified bug into docs/BUGS.md. Use after confirming a bug is real — not for speculation. Includes format and verification checklist.
---

# Record Bugs

Use this skill when a bug has been verified (observed, reproduced, or confirmed by Captain/crew).

## Steps

1. **Verify** — confirm the bug is real before recording. Do not record suspected issues.
2. **Check** — read `docs/BUGS.md` to avoid duplicates.
3. **Record** — add an entry under `## Active Bugs`.
4. **Test** — write a regression test in `src/__tests__/` that would have caught this bug. The test should fail without the fix and pass with it.
5. **Commit** — commit the bug entry and test together with message `bug: record <short description>`.

## Entry Format

```markdown
### BUG-<N>: <Short title>

**Reported:** YYYY-MM-DD
**Status:** open
**Component:** <relay | main | operator-commands | etc.>
**Symptom:** One sentence describing what the user observes.
**Root cause:** Known or unknown.
**Fix:** What needs to change, or "TBD".
```

## Verification Checklist

Before recording, confirm:
- [ ] Symptom is reproducible or confirmed by Captain/crew
- [ ] Not already in BUGS.md
- [ ] Component is identified (even if approximate)

## Closing a Bug

When fixed, move the entry under `## Resolved Bugs` and add:
```
**Resolved:** YYYY-MM-DD · commit `<sha>` · <one-line summary of fix>
```
