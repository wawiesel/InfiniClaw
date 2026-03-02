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

## JSONL format

Each line is a JSON object with a `type` field:

- `type: "human"` — user/system message. `content` array with `text` items.
- `type: "assistant"` — bot response. `content` array with `text` and `tool_use` items.
- `type: "tool_result"` — tool output. `content` array with results.

**Skip these to reduce noise:**
- Lines where `content` contains very large tool results (>5KB) — just note what tool was called
- `type: "system"` init lines
- Subagent files in `subagents/` dirs (these are lobe conversations)

## Lobe instructions

Tell your lobe:

```
Read the session file at <path>. Extract:
1. Key decisions made and why
2. Tasks completed and their outcomes
3. Standing orders or preferences learned
4. Important file paths, patterns, or architecture notes
5. Errors encountered and how they were resolved
6. Any unfinished work that needs follow-up

Skip large tool call results — just note what tool was called and the purpose.
Write a summary to my memory file at /workspace/extra/<persona>-persona/memory/session-recovery-<date>.md
```

## After recovery

1. Review what the lobe extracted
2. Merge key items into your main MEMORY.md
3. Delete the session-recovery file once merged
4. If there was unfinished work, add it to your todo list
