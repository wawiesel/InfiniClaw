---
name: maintenance
description: Periodically review and simplify one InfiniClaw source file. Delegates work to Codex lobe and posts results in a Matrix thread. Use for scheduled or on-demand code maintenance.
---

# Maintenance

Systematically simplify InfiniClaw source files, one file per run. Work is always delegated to Codex and results posted in a Matrix thread — never directly on the main timeline.

## Execution protocol (ALWAYS follow this order)

### 1. Open a Matrix thread

```
event = send_and_open_thread("🔧 Maintenance run — HH:MM PM EST")
set_thread(event.event_id)
```

All subsequent output goes into this thread via `send_message`.

### 2. Determine the next file

Read `/tmp/cid-maintenance-pointer.txt`. If missing, start from first file.

Rotation order (loop forever):
```
allow-list.ts
brain-management.ts
channels/local-cli.ts
channels/matrix.ts
chat-activity.ts
cli.ts
container-mounts.ts
container-secrets.ts
container-spawn.ts
conversation-log.ts
formatting.ts
ipc-commands.ts
ipc-watcher.ts
machine-config.ts
main.ts
mcp-sync.ts
message-filtering.ts
operator-commands.ts
podman-bootstrap.ts
s3-sync.ts
service.ts
skill-sync.ts
status-cli.ts
status.ts
```

Write the NEXT file to the pointer before delegating.

### 3. Delegate to Codex lobe

Call `delegate_to_lobe` with lobe=codex, cwd=/workspace/extra/InfiniClaw, reason="Maintenance: simplify <file>", objective:

```
Review /workspace/extra/InfiniClaw/src/<file> for simplification opportunities:
- Dead code (unused imports, exports, variables)
- High-complexity functions (> 10 lines, nested conditionals, long switch statements)
- Missing error handling
- Clarity improvements

Rules:
- Make ONLY safe, behavior-preserving changes
- After any edit, run: cd /workspace/extra/InfiniClaw && npm run build
- If build fails, revert the change
- If something was improved: commit with message "simplify(<file>): <what changed>"
  then write the push IPC file:
  echo '{"type":"git_push","remote":"origin","branches":["main"]}' > /workspace/ipc/tasks/git-push-$(date +%s).json
- Return either:
  - "fixed: <description> — commit <hash>"
  - "nothing actionable"
```

### 4. Post result in thread

- If Codex fixed something: `send_message("🔍 \`<file>\`: <description> — commit <hash>")`
- If nothing actionable: `send_message("✅ \`<file>\`: clean, nothing to simplify")`

### 5. Clear thread

```
set_thread()  # no argument clears it
```

## When called via `!maintenance` or scheduled task

Run exactly the above protocol. No output on the main timeline.

## Complexity targets

Use lizard CCN as a guide (optional, not required each run):
```bash
pip3 install --user lizard 2>/dev/null
~/.local/bin/lizard /workspace/extra/InfiniClaw/src/ -s cyclomatic_complexity 2>&1 | tail -20
```

CCN > 15 = high priority refactor candidate.
