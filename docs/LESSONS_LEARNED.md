# Lessons Learned

## 2026-02-22 — WKSM SSE MCP crashes were a red herring

**Participants:** Engineer (Cid), Operator, Captain

After adding WKSM as an SSE MCP server, the engineer container started crashing (exit 137/OOM and exit 1/session resume). Everyone assumed WKSM caused it. It didn't — the crashes were pre-existing. Each crash leaked a WKSM session (no cleanup), which reinforced the false impression.

**Takeaways:**
- Test the integration first, investigate internals last. A 10-line `query()` script proved SSE worked instantly.
- `.mcp.json` persona source is truth; runtime copy is regenerated on spawn. Don't edit runtime copies expecting persistence across restarts.
- SSE MCP sessions need heartbeat timeout and cleanup — every crash leaks a subprocess.
- Commander requires a Bridge message to spawn. Restarting the host process alone does nothing.
- Agent SDK MCP timeout is 30s (`MCP_TIMEOUT` env var). Servers connect sequentially.

Full writeup: `_runtime/instances/engineer/groups/main/LESSONS_LEARNED.md`

## 2026-02-27 — settings.local.json overrides shared permissions

**Participants:** Operator (mac139160, HERACLES)

`.claude/settings.local.json` with broken colon-syntax rules (`Bash(git:*)`) was overriding the shared `.claude/settings.json`, causing permission prompts on all operators. The local file wasn't tracked in git but existed on both machines from earlier manual setup.

**Takeaways:**
- `settings.local.json` overrides `settings.json`. If operators need uniform permissions, don't use local overrides.
- Bash permission syntax uses spaces not colons: `Bash(git *)` not `Bash(git:*)`.
- Shared operator permissions belong in `.claude/settings.json` (tracked in the secrets repo).
