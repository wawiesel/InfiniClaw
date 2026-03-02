---
name: recover-session
description: Extract memories and learnings from previous Claude Code sessions that were lost to OOM kills or session resets. Delegate to a lobe — session files can be large.
---

# Recover Session Memories

When your session is cleared (OOM kill, restart, etc.), your conversation history is lost but the session files remain on disk. Use this skill to extract key learnings and save them to your memory files.

**IMPORTANT: Delegate this to a lobe.** Session JSONL files can be large (1MB+). Do not process them in your main brain.

## Session file location

```
/Users/ww5/2026-Nanoclaw/InfiniClaw/_runtime/instances/<persona>/data/sessions/main/.claude/projects/-workspace-group/
```

Replace `<persona>` with your persona name (e.g. `nora`, `cid`, `johnny5`).

- `*.jsonl` in the main dir = active or recently cleared sessions
- `archive/*.jsonl` = older archived sessions

## Approach: Write a Python script

Do NOT read session JSONL files directly — they're too large. Instead, write a Python script that:

1. Parses the JSONL line by line
2. Extracts a condensed summary of the conversation
3. Writes the summary to a manageable output file

Then read the output file.

### Script template

```python
#!/usr/bin/env python3
"""Extract memories from a Claude Code session JSONL file."""
import json
import sys

session_file = sys.argv[1]
output_file = sys.argv[2]

entries = []
with open(session_file) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        msg_type = msg.get("type", "")

        if msg_type == "human":
            # Extract user/system text
            for block in msg.get("content", []):
                if isinstance(block, dict) and block.get("type") == "text":
                    text = block["text"]
                    # Skip system prompts (very long, not useful for memory)
                    if len(text) > 2000:
                        entries.append(f"[USER] (truncated {len(text)} chars): {text[:200]}...")
                    else:
                        entries.append(f"[USER] {text}")

        elif msg_type == "assistant":
            for block in msg.get("content", []):
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        text = block["text"]
                        if len(text) > 1000:
                            entries.append(f"[ASSISTANT] {text[:500]}...")
                        else:
                            entries.append(f"[ASSISTANT] {text}")
                    elif block.get("type") == "tool_use":
                        name = block.get("name", "?")
                        inp = json.dumps(block.get("input", {}))
                        if len(inp) > 200:
                            inp = inp[:200] + "..."
                        entries.append(f"[TOOL_CALL] {name}({inp})")

        elif msg_type == "tool_result":
            # Just note tool results exist, skip content (often huge)
            tool_id = msg.get("tool_use_id", "?")
            content = msg.get("content", [])
            total = sum(len(json.dumps(b)) for b in content if isinstance(b, dict))
            entries.append(f"[TOOL_RESULT] id={tool_id} ({total} bytes)")

with open(output_file, "w") as f:
    f.write(f"# Session Recovery: {session_file}\n\n")
    f.write(f"Total messages: {len(entries)}\n\n")
    for entry in entries:
        f.write(entry + "\n\n")
```

### Lobe instructions

Tell your lobe:

```
1. List session files at the session location (see skill for path)
2. Write a Python script based on the template in the recover-session skill
   to extract a condensed summary from the largest/most recent session file
3. Run the script: python3 script.py <session.jsonl> /tmp/session-summary.txt
4. Read the summary output
5. Extract from it:
   - Key decisions made and why
   - Tasks completed and their outcomes
   - Standing orders or preferences the Captain gave
   - Important file paths, patterns, or architecture notes
   - Errors encountered and how they were resolved
   - Any unfinished work that needs follow-up
6. Write findings to /workspace/extra/<persona>-persona/memory/session-recovery-<date>.md
```

## After recovery

1. Review what the lobe extracted
2. Merge key items into your main MEMORY.md
3. Delete the session-recovery file once merged
4. If there was unfinished work, add it to your todo list
