---
name: memory-keeping
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

## Session Recovery (after OOM kill or session reset)

When your session is cleared, conversation history is lost but session files remain. Use this to extract key learnings and restore context.

**Delegate to a lobe** — session JSONL files can be 1MB+.

### Session file location

```
/Users/ww5/2026-Nanoclaw/InfiniClaw/_runtime/instances/<persona>/data/sessions/main/.claude/projects/-workspace-group/
```

Replace `<persona>` with your bot name (e.g. `cid`, `johnny5`).

### Lobe instructions

```
1. List session files at the session location above
2. Write a Python script to extract a condensed summary from the most recent JSONL:
   - Parse line by line (do NOT load whole file)
   - Extract [USER], [ASSISTANT], [TOOL_CALL], [TOOL_RESULT] entries
   - Truncate long texts (>1000 chars for assistant, >2000 for user)
3. Run: python3 script.py <session.jsonl> /tmp/session-summary.txt
4. Read the summary and extract:
   - Key decisions and why
   - Tasks completed and outcomes
   - Standing orders or Captain preferences
   - Important file paths, architecture notes
   - Errors and how resolved
   - Unfinished work for follow-up
5. Write findings to /workspace/persona/memory/session-recovery-<date>.md
```

### After recovery

1. Review what the lobe extracted
2. Merge key items into MEMORY.md
3. Delete the session-recovery file once merged
4. Add unfinished work to your todo list
