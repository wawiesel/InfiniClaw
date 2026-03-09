# Bot Runtime Solutions

## OOM kills — bot keeps dying with exit 137

**Problem:** Bot containers die repeatedly with exit code 137 (SIGKILL / OOM).

**Cause:** Session resume is the #1 cause. When Claude Code resumes a session, it deserializes the entire JSONL file — 2-5x the file size in memory. A 1.1MB session with a 160KB largest turn can OOM a 4GB V8 heap. Runtime memory (tool outputs, MCP servers) is secondary.

**Fix:**
- Reduce `SESSION_MAX_BYTES` in bot env to cap session file size
- V8 heap must be less than container memory — leave at least 2GB headroom
- After OOM, the host auto-clears the session (no toxic loop). Bot restarts fresh.

**Clearing a toxic session manually:**
```bash
npm run cli stop <bot>
sqlite3 _runtime/instances/<bot>/store/messages.db "DELETE FROM sessions WHERE group_folder = 'main';"
npm run cli start
```

**Notes:**
- Heavy bots (navigators) need more heap and container memory than light bots (engineers)
- Delegate heavy work (file processing, web scraping, PDFs) to lobes — separate processes, separate memory

---

## MCP crashes blamed on wrong root cause

**Problem:** After adding an SSE MCP server (e.g. WKSM), bot containers start crash-looping. Assumption: MCP is the cause.

**Cause:** Crashes are often pre-existing. Each crash leaks an MCP session (no cleanup), reinforcing the false impression that MCP caused the crash.

**Diagnosis:** Test the MCP integration in isolation first:
```bash
# A simple query script proves SSE connectivity instantly
# If SSE works fine, look elsewhere for the crash cause
```

**Fix:**
- SSE MCP sessions need heartbeat timeout and cleanup — ensure the MCP server cleans up on disconnect
- Agent SDK MCP timeout is 30s (`MCP_TIMEOUT` env var). Servers connect sequentially.
- `.mcp.json` in the persona source is truth — runtime copy is regenerated on spawn. Don't edit runtime copies.

---

## Bot won't spawn after restart — Commander requires a Bridge message

**Problem:** Restarting the host process for a Commander-role bot does nothing. Bot never spawns.

**Cause:** Commander requires a message in Bridge to trigger spawn. Restarting the host process alone is insufficient.

**Fix:** Send a message to Bridge after restarting. The message triggers Commander to materialize.
