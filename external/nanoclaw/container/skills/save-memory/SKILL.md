---
name: save-memory
description: Save important context to memory using a lobe. Use proactively after learning something new, receiving corrections, fixing bugs, or completing significant work. Do not wait for shutdown.
---

# Save Memory

Delegate memory writing to a lobe so you don't burn main brain context on file I/O.

## When to save

- After the Captain corrects you or gives a standing order
- After fixing a bug or learning how something works
- After completing a multi-step task
- When you realize something you assumed was wrong
- Periodically during long sessions (every 5-10 exchanges)

## How

Use `delegate_codex` (or `delegate_gemini` if codex is unavailable):

```
name: "Memory"
objective: |
  Read /home/node/.claude/projects/-workspace-group/memory/MEMORY.md

  Update it with the following new information:
  <your summary of what to save>

  Rules:
  - Keep total under 200 lines (auto-loaded, truncated after that)
  - Remove stale or incorrect entries
  - Organize by topic, not chronologically
  - Use topic files in the same directory for detailed notes
  - Be concise — bullet points, not paragraphs
```

## What to save

- Corrections and standing orders from the Captain
- Architecture decisions and key file paths
- Solutions to problems you solved
- Things you got wrong (so you don't repeat them)
- Active project context and current state

## What NOT to save

- Session-specific details (current task, in-progress work)
- Information already in CLAUDE.md
- Speculative or unverified conclusions
