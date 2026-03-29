---
name: gds-engineer
description: Gitea Dev System — structured development procedure with relay-enforced gates. Use for non-trivial engineering tasks that need planning, estimation, and gate reviews before merging.
---

# GDS Engineer Procedure

Use this procedure for any development task that requires planning before execution. The GDS enforces a gate pipeline — you cannot merge to main without passing all gates including demo + Captain approval.

## Gate Pipeline

```
survey → estimate → artifacts → plan_approve → execute_30 → execute_60 → execute_90 → demo → done
```

## Phase 1 — Planning (Gitea-first)

1. **Create GDS**: Call `gds_create` with title, description (referencing design spec), and inspector name.

2. **Survey (BB)**: Spawn a planning BB:
   ```
   {{branch GDS #{issue} survey: {title}}}
   ```
   BB reads relevant code, checks existing implementations, posts findings via `gitea_comment`. Then calls `gds_submit_evidence(gate="survey")`.

3. **Wait for gate approval**: Inspector reviews survey on Gitea, approves. Captain confirms.

4. **Estimate (BB)**: Same BB or new BB posts resource estimates via `gitea_comment`:
   - Estimated tokens
   - Estimated wall time
   - Model recommendation
   - Files to be modified
   Calls `gds_submit_evidence(gate="estimate")`.

5. **Wait for gate approval**.

6. **Artifacts (BB)**: BB declares all artifacts to be produced:
   - Files created/modified
   - PRs to be opened
   - Matrix messages expected
   Calls `gds_submit_evidence(gate="artifacts")`.

7. **Wait for gate approval**.

8. **Plan approval**: Inspector and Captain review the full plan on Gitea.

## Phase 2 — Execution (fresh BB)

9. **Spawn execution BB**:
   ```
   {{branch GDS #{issue} execute: {title}}}
   ```
   This MUST be a fresh BB — not the planning BB.

10. **Gate checks at 30/60/90%**: At each milestone, the BB:
    - Posts progress to Gitea via `gitea_comment`
    - Calls `gds_submit_evidence(gate="execute_30")` with tokens_used and time_elapsed_min
    - Waits for inspector + captain approval before continuing

11. **Demo**: Working feature demonstrated. Call `gds_submit_evidence(gate="demo")`. **Captain-only approval — always.**

12. **Done**: Captain confirms merge to main.

## Rules

- **95% of discussion on Gitea**. Matrix only for: branch signals, gate notifications, completion.
- **Fresh BB for execution** — planning and execution BBs must be different instances.
- **All evidence on Gitea** — every gate submission posts a structured comment.
- **Nothing merges without demo + Captain** — `git_push` to main is blocked by the relay.
- **Track tokens and time** at every execution gate.
