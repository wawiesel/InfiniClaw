# 17 — Skills

Skills are pooled capability modules loaded by role. Each skill is a `SKILL.md` file that gets injected into the bot's context, providing domain-specific instructions.

## Structure

```
bots/skills/
  github-development/SKILL.md
  fleet-inspection/SKILL.md
  web-recon/SKILL.md
  ...
bots/{role}/skills.json          # lists which skills this role loads
```

> **Status:** Per-bot custom skills directory (`bots/{role}/{bot}/skills/`) is not yet implemented. Bots can write skill files directly to the session's `.claude/skills/` directory at runtime, but these are not tracked in the repo.

## Loading

Skills are listed in each role's `skills.json`. At container spawn, the listed skill directories are symlinked into the bot's session `.claude/skills/` directory, which Claude Code reads automatically. Pool-level skills use symlinks so edits to the pool propagate immediately.

## Skill File Format

Each skill file has YAML frontmatter and markdown body:

```markdown
---
name: skill-name
description: When and how to use this skill.
---

# Skill Name

## Workflow
...

## Rules
...
```

## Planned Skills

### pm (Project Management)

> **Status:** Not yet implemented.

The `pm` skill is planned for engineer-role bots. Capabilities:

- Maintain a WBS (Work Breakdown Structure) JSON at `_runtime/data/wbs-{bot}.json`
- Render GANTT as HTML and upload to S3 presigned URL for the Captain
- Track task dependencies
- Predict time-to-completion from task complexity and historical branch brain durations
- Generate weekly summaries for the Captain

### retrospective

> **Status:** Not yet implemented.

Prompt template for the retrospective cycle (see [09-roles-and-rooms](09-roles-and-rooms.md#retrospective-cycle)). Lives at `skills/retrospective/SKILL.md`.

## Creating Skills

Bots with write access to their persona directory can create new skills by writing `SKILL.md` files. Pool-level skills (shared by all bots of a role) require write access to the InfiniClaw repo.

## Verification

1. **Skills loaded** — Bot starts with skills from its role's `skills.json`.
   *Check:* Session `.claude/skills/` contains symlinks for all skills in the role's list.

2. **Skill affects behavior** — Bot has `github-development` skill and receives a PR task.
   *Check:* Bot follows the branch naming, commit, and PR workflow from the skill.

3. **Runtime skill creation** — Bot writes a new `SKILL.md` into the session `.claude/skills/` directory.
   *Check:* Claude Code picks up the new skill without a container restart.
