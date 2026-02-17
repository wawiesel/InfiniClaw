---
name: creating-good-skills
description: Guide for creating and improving Claude Code skills. Use when creating a new skill, reviewing existing skills for quality, or advising on skill design. Covers SKILL.md structure, frontmatter, progressive disclosure, and NanoClaw-specific conventions.
---

# Creating Good Skills

Reference for building effective Claude Code skills, tailored for NanoClaw's persona/shared skill system.

## Skill Anatomy

```
skill-name/
├── SKILL.md          # Required — frontmatter + instructions
├── scripts/          # Executable code Claude can run
├── references/       # Docs loaded on demand (keeps SKILL.md lean)
└── assets/           # Templates, images, files used in output
```

## SKILL.md Structure

### Frontmatter (YAML between `---` markers)

```yaml
---
name: my-skill
description: What it does and when to use it. This is the trigger — Claude reads it to decide relevance. Put all "when to use" info here, not in the body.
---
```

Key fields:
- `name` (required) — becomes the `/slash-command`
- `description` (required) — primary trigger mechanism; be specific about contexts
- `disable-model-invocation: true` — only user can invoke (for side effects: deploy, send messages)
- `user-invocable: false` — hidden from slash menu, Claude auto-loads when relevant (background knowledge)
- `allowed-tools` — restrict which tools the skill can use

### Body (Markdown)

Instructions Claude follows after the skill triggers. Keep under 500 lines / 5,000 words.

## Core Principles

### 1. Context Window is a Public Good

Skills share context with system prompt, conversation, other skills' metadata, and the user request. Only add information Claude doesn't already have. Challenge each paragraph: "Does this justify its token cost?"

Prefer concise examples over verbose explanations.

### 2. Progressive Disclosure (Three Levels)

1. **Metadata** (~100 words) — always in context (name + description)
2. **SKILL.md body** (<5k words) — loaded when skill triggers
3. **Bundled resources** — loaded as needed (unlimited, scripts run without loading)

Split content into references/ when approaching 500 lines. Reference them from SKILL.md with clear "when to read" guidance.

### 3. Match Freedom to Fragility

- **High freedom** (text instructions): multiple valid approaches, context-dependent
- **Medium freedom** (pseudocode/parameterized scripts): preferred pattern exists, some variation OK
- **Low freedom** (specific scripts): fragile operations, consistency critical, exact sequence required

### 4. Description is Everything

The description field is the only thing Claude always sees. Body is loaded *after* triggering. So:
- Include all trigger conditions in the description
- "When to Use This Skill" sections in the body are useless for discovery
- Be specific: list concrete scenarios, file types, or keywords

## NanoClaw Conventions

### Creating skills

**Always create skills in your container session at `/home/node/.claude/skills/`.** The bidirectional skill sync automatically copies them out to your persona source. Do not write directly to persona source.

To create a skill for another bot (e.g. commander), send them a message asking them to create it themselves. You cannot create skills for other bots.

After finishing all skill edits, reboot so changes persist to persona source. Do not reboot mid-edit.

### Skill locations (reference)

| Path | Scope |
|------|-------|
| `/home/node/.claude/skills/{name}/` | Where you create skills (container session) |
| `bots/personas/{bot}/skills/{name}/` | Persona source (auto-synced from session) |
| `nanoclaw/container/skills/{name}/` | All bots (shared) |

Persona skills override shared skills with the same name. Skills sync bidirectionally on every spawn — new skills in session get copied to source, skills missing from source get deleted from session.

### Naming

- Directory name = kebab-case (`creating-good-skills`, not `CreatingGoodSkills`)
- `name` field in frontmatter should match directory name
- Keep names short and action-oriented

### What NOT to include

- README.md, CHANGELOG.md, INSTALLATION_GUIDE.md — the skill IS the documentation
- "When to use" sections in the body — put this in the description
- Information Claude already knows (common programming concepts, standard tool usage)
- Duplicate content between SKILL.md and reference files

## Quality Checklist

- [ ] Description clearly states what the skill does AND when to trigger it
- [ ] Body is concise — no redundant explanations of things Claude already knows
- [ ] Frontmatter uses `disable-model-invocation: true` if the skill has side effects
- [ ] Large reference material is in `references/`, not inline
- [ ] Scripts are tested and deterministic
- [ ] No extraneous files (README, changelog, etc.)
- [ ] Directory name matches `name` field in frontmatter
- [ ] Instructions use imperative form ("Run X", "Check Y", not "You should run X")

## Common Patterns

### Action skill (side effects)

```yaml
---
name: deploy
description: Deploy the application to production. Use after code review is complete.
disable-model-invocation: true
---
```

### Knowledge skill (background context)

```yaml
---
name: legacy-api
description: Reference for the legacy payment API (v1). Use when working with /api/v1/ endpoints, PaymentProcessor class, or legacy webhook handlers.
user-invocable: false
---
```

### Tool-restricted skill

```yaml
---
name: browser-task
description: Browse the web for research. Use for any web interaction task.
allowed-tools: Bash(agent-browser:*)
---
```
