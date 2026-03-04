---
name: update-directives
description: Update your persona CLAUDE.md. Use when the Captain gives standing orders, corrections, or preferences that must persist across restarts.
---

# Update Directives

## Your persona CLAUDE.md

Path: `/workspace/persona/CLAUDE.md`

This is YOUR file — it controls who you are and how you behave. Edits persist across restarts.

## How to update

Delegate to a lobe so you don't burn main brain context on file I/O.

```
delegate_to_lobe:
  reason: "update directives"
  lobe: codex   # or gemini
  objective: |
    Read <path to persona CLAUDE.md>.
    Update it with: <your summary of what to change>
    Rules:
    - Read the file first, preserve existing content
    - Be concise — bullet points, not paragraphs
```

## What belongs here

- Standing orders from the Captain
- Corrections to your behavior
- Permanent rules and preferences

## DO NOT edit

- `/workspace/CLAUDE.md` — read-only, overwritten on deploy.
- `/workspace/project/CLAUDE.md` — read-only instance copy.

## When to save

- After the Captain corrects you or gives a standing order
- After receiving permanent rules or preferences
