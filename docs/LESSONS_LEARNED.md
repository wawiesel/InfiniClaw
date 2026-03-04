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

## 2026-03-01 — OOM root cause is session resume, not runtime usage

**Participants:** Engineer (Cid), Operator

Session resume is the #1 cause of OOM kills. When Claude Code resumes a session, it deserializes the entire JSONL file into JavaScript objects — 2-5x the file size due to object overhead. A 1.1MB / 468-turn session with a 160KB largest single turn OOMed a 4GB V8 heap. Runtime memory (tool outputs, MCP servers) is secondary.

**Takeaways:**
- `SESSION_MAX_BYTES` caps session file size. Reducing it gives more safety margin at the cost of more frequent context loss.
- V8 heap must always be less than container memory — leave at least 2GB headroom.
- After OOM, the host auto-clears the session (no toxic session loop). The bot starts fresh.
- Heavy bots (navigators) need more heap and container memory than light bots (engineers).
- Delegate heavy work (file processing, web scraping, PDFs) to lobes — they run in separate processes with separate memory.

**Clearing a toxic session manually:**
```bash
npm run cli stop <bot>
sqlite3 _runtime/instances/<bot>/store/messages.db "DELETE FROM sessions WHERE group_folder = 'main';"
npm run cli start
```

**Historical OOM counts (as of 2026-03-01):** Johnny5: 22, Cid: 22, Nora: 14, Albert: 0, Parker: 0.

## 2026-03-01 — Code review: thick wrapper is the right call

**Participants:** Architect (Albert), Captain

`src/main.ts` (1100+ lines), `container-spawn.ts` (600+), and `ipc-watcher.ts` (400+) are near-total forks of upstream NanoClaw. Adding plugin hooks was considered and rejected — it would introduce fragile interface coupling and make subtree pulls harder. The thick wrapper approach is correct at this scale.

**Takeaways:**
- Feature modules (`skill-sync.ts`, `brain-management.ts`, `container-secrets.ts`) are well-scoped. The coupling is concentrated in the three entry-point forks.
- `service.ts` / `cli.ts` are clean — no refactoring needed.
- Config reads from `process.env` scattered across `main.ts` should eventually consolidate into a config module, but not urgent.
- Upstream NanoClaw changes infrequently. Manual porting of upstream fixes is acceptable.
