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
bots/{role}/{bot}/skills/        # per-bot custom skills (writable)
```

## Loading

Skills are listed in each role's `skills.json`. At container spawn, the listed `SKILL.md` files are injected into the bot's context. Bots can also have persona-level skills in their writable directory.

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

> **Status:** Implemented. See `bots/skills/pm/SKILL.md`.

The `pm` skill is available for engineer-role bots. Capabilities:

- Chief-only WBS mutations: triage directives into items, assign to crew, mark done
- Dependency tracking: blocked items transition `backlog → ready` when dependencies complete
- Status summaries: counts by status, blocked items, in-progress owners — posted to room or uploaded to S3
- Weekly summaries for the Captain with completed, carried-over, and next-week focus sections

### retrospective

> **Status:** Not yet implemented.

Prompt template for the retrospective cycle (see [09-roles-and-rooms](09-roles-and-rooms.md#retrospective-cycle)). Lives at `skills/retrospective/SKILL.md`.

## Creating Skills

Bots with write access to their persona directory can create new skills by writing `SKILL.md` files. Pool-level skills (shared by all bots of a role) require write access to the InfiniClaw repo.

## Verification

1. **Skills loaded** — Bot starts with skills from its role's `skills.json`.
   *Check:* Startup checklist shows skills table with all expected skills.

2. **Skill affects behavior** — Bot has `github-development` skill and receives a PR task.
   *Check:* Bot follows the branch naming, commit, and PR workflow from the skill.

3. **Custom skill** — Bot writes a new skill to its persona skills directory.
   *Check:* On next restart, the new skill appears in the startup checklist.
