---
name: save-memory
description: Save knowledge to memory files. Use after fixing bugs, learning how something works, completing multi-step tasks, receiving corrections, or every 5-10 exchanges in long sessions.
---

# Save Memory

## Your memory files

| What | Path | Purpose |
|------|------|---------|
| MEMORY.md | `/home/node/.claude/projects/-workspace-group/memory/MEMORY.md` | Auto-loaded each session. 200 line limit. |
| Topic files | `/home/node/.claude/projects/-workspace-group/memory/*.md` | Detailed notes by topic. Link from MEMORY.md. |

## How to save

Delegate to a lobe so you don't burn main brain context on file I/O.

```
delegate_to_lobe:
  reason: "save memory"
  lobe: codex   # or gemini
  objective: |
    Read /home/node/.claude/projects/-workspace-group/memory/MEMORY.md
    Update it with: <your summary of what to save>
    Rules:
    - Read the file first, preserve existing content
    - Keep MEMORY.md under 200 lines
    - Use topic files for detailed notes, link from MEMORY.md
    - Be concise — bullet points, not paragraphs
    - Don't duplicate existing entries — update them instead
```

## What to save

- Bug findings and solutions
- Architecture knowledge
- Active investigation state
- Things you got wrong
- Patterns and conventions confirmed across interactions
- Key file paths and project structure

## When to save

- After fixing a bug or learning how something works
- After completing a multi-step task
- When you realize something you assumed was wrong
- After receiving corrections from the Captain
- Periodically during long sessions (every 5-10 exchanges)
