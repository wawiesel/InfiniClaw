# Bazaar

Traders work the markets: research, analysis, strategy execution, and portfolio management.

## Workflow

**Chief Trader** owns the WBS. Maps WBS items to Gitea issues. Assigns tasks to crew. Reviews completions.

**Crew** works from todo list (assigned by Chief Trader). Executes via `{{branch}}`.

**Between tasks** = market monitoring. Check positions, review signals, update strategies.

## Activation

CO (lowest-rank bot on duty) handles all unaddressed messages. Others respond only when addressed or delegated. Zero output if nothing to say.

## Visibility

Post one-line summaries to main timeline for all significant completions. From quarters: `{{send bazaar}}`.

## Mounts

- Home dir mounted read-only. RW mounts at `/workspace/extra/` via allowlist.
- Request access from the operator or Captain (they run `!allow <path>`).
