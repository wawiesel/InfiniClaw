---
name: full-monty-python
description: "Use when writing, refactoring, or reviewing Python. Enforces NoHedging for data correctness, KISS/YAGNI/DRY for design, RAII for resource lifetime, PUTT PUTT and PAPER for test realism, Pinocchio and TruthOrSilence for internal prose, EzGrep for searchable naming, and Hodor when explicit traceability is required."
---

# Full Monty Python

Use this skill for Python code that should be boringly correct, easy to review, and hard to rot.

## Core priorities

1. Correctness before convenience.
2. Simplicity before cleverness.
3. One source of truth for each rule or transformation.
4. Real tests over synthetic comfort.
5. Internal prose must stay true or be deleted.

## Coding rules

- Validate external input at boundaries, then use strict internal models.
- Do not invent fallback defaults for required data.
- Prefer `@dataclass` or similarly explicit types for structured data.
- Prefer direct code over speculative abstraction.
- Delete unused hooks, branches, and scaffolding.
- Extract duplicated logic when the duplication is truly the same concept.
- Keep names easy to search when that materially improves maintenance.
- Keep module comments and docstrings local, minimal, and stable.
- If a comment can drift, delete it or replace it with code or tests.

## Python defaults

- Use explicit parsing helpers for dates, money, identifiers, and file formats.
- Use context managers for files and owned resources.
- Fail during construction if an object cannot establish its invariants.
- Avoid broad `except Exception` unless you re-raise with a tighter boundary-specific error.
- Avoid `dict.get(key, invented_default)` for required fields.
- Prefer small functions with one obvious responsibility.
- Prefer public APIs that make private behavior reachable under real tests.

## Testing rules

- When changing behavior, start with a failing test when practical.
- Tests should exercise real workflows, not paper-thin isolated calls.
- Global confidence comes from public APIs.
- Private-targeted tests are allowed only for local diagnosis, not as the main proof of correctness.
- Coverage is not enough if the workflow under test is fake.

## Review checklist

- Is missing data handled at the boundary instead of hidden later?
- Is there duplicated knowledge that should be centralized?
- Is any abstraction speculative rather than needed now?
- Are names searchable and specific enough?
- Are comments saying only what the code cannot?
- Do tests prove the real user-facing behavior?

## Rule set

- NoHedging
- KISS
- DRY
- YAGNI
- RAII
- PUTT PUTT
- PAPER
- Pinocchio
- TruthOrSilence
- EzGrep
- Hodor
