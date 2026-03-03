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

---

## Session Recovery (after OOM kill or session reset)

When your session is cleared (OOM kill, restart, etc.), conversation history is lost but session files remain on disk. Use this to recover.

**IMPORTANT: Delegate to a lobe.** Session JSONL files can be large (1MB+).

### Session file location

```
/Users/ww5/2026-Nanoclaw/InfiniClaw/_runtime/instances/<persona>/data/sessions/main/.claude/projects/-workspace-group/
```

Replace `<persona>` with your persona name (e.g. `cid`, `johnny5`).

- `*.jsonl` in the main dir = active or recently cleared sessions
- `archive/*.jsonl` = older archived sessions

### Approach: Write a Python script

Do NOT read session JSONL files directly — they're too large. Instead, write a Python script that parses the JSONL line by line, extracts a condensed summary, and writes it to a manageable output file.

### Script template

```python
#!/usr/bin/env python3
"""Extract memories from a Claude Code session JSONL file."""
import json, sys

session_file = sys.argv[1]
output_file = sys.argv[2]

entries = []
with open(session_file) as f:
    for line in f:
        line = line.strip()
        if not line: continue
        msg = json.loads(line)
        msg_type = msg.get("type", "")
        if msg_type == "human":
            for block in msg.get("content", []):
                if isinstance(block, dict) and block.get("type") == "text":
                    text = block["text"]
                    if len(text) > 2000:
                        entries.append(f"[USER] (truncated {len(text)} chars): {text[:200]}...")
                    else:
                        entries.append(f"[USER] {text}")
        elif msg_type == "assistant":
            for block in msg.get("content", []):
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        text = block["text"]
                        entries.append(f"[ASSISTANT] {text[:500]}..." if len(text) > 1000 else f"[ASSISTANT] {text}")
                    elif block.get("type") == "tool_use":
                        inp = json.dumps(block.get("input", {}))
                        entries.append(f"[TOOL_CALL] {block.get('name','?')}({inp[:200]}{'...' if len(inp)>200 else ''})")

with open(output_file, "w") as f:
    f.write(f"# Session Recovery: {session_file}\n\nTotal messages: {len(entries)}\n\n")
    f.write("\n\n".join(entries))
```

### Lobe instructions

Tell your lobe:
1. List session files at the path above
2. Write the Python script above, run it on the most recent `.jsonl`: `python3 script.py <session.jsonl> /tmp/session-summary.txt`
3. Read the output, extract: key decisions, completed tasks, standing orders, file paths, errors resolved, unfinished work
4. Write findings to `/workspace/extra/<persona>-persona/memory/session-recovery-<date>.md`

### After recovery

1. Review what the lobe extracted
2. Merge key items into MEMORY.md
3. Delete the session-recovery file once merged
4. If there was unfinished work, add it to your todo list
