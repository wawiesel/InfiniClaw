# NEXT — InfiniClaw Planned Work

## In Progress

### Holodeck Blue-Green Deployment
- **Status:** Code written, needs deploy + testing
- **What:** Fully isolated test instance (Cid+) runs from a git worktree in the Holodeck Matrix room
- **Why:** Safe way to test nanoclaw changes before promoting to production
- **Components:**
  - `service.ts`: `holodeckCreate()`, `holodeckTeardown()`, `holodeckPromote()`
  - `ipc.ts`: `holodeck_create`, `holodeck_teardown`, `holodeck_promote` commands
  - Separate launchd plist (`com.infiniclaw.holodeck`), separate instance dir, separate data
- **Next:** Deploy, create a test branch, launch Cid+ in Holodeck, verify it works

## Planned

### Git History Reorganization
- **What:** Pull from upstream nanoclaw, rewrite historical commits for clean separation
- **Why:** Commits should be optimally separable for the final version
- **Approach:** Create version branches (aqua, bingo, charlie, etc.) as checkpoints
- **Blocked by:** Holodeck (need blue-green to safely do git work)

### First-Class Brain & Lobe Intelligence
- **What:** Make model selection and lobe delegation feel like native cognitive abilities, not manual tools
- **Dynamic brain switching:** Auto-downgrade to cheaper/faster models for simple tasks (formatting, lookups, acks), auto-upgrade for complex reasoning (architecture, debugging, multi-file refactors)
- **Lobe specialization memory:** Learn which models excel at what — Gemini for large file analysis, Codex for code generation, Ollama for quick local tasks — and route automatically
- **Cost-aware routing:** Track token budgets per provider, prefer cheaper models when budget is tight, escalate when quality matters
- **Complex delegation patterns:** Chain lobes (research → plan → implement), fan-out parallel lobes for independent subtasks, aggregate results
- **Model capability profiles:** Maintain a knowledge base of model strengths/weaknesses that updates over time based on observed quality

### Health Metrics with LLM Usage
- **What:** Health check should include approximate remaining usage/budget across all LLM providers
- **Why:** Need visibility into how much capacity remains on each model to make routing decisions
- **Components:** Integrate `list_capability_budgets` data into `check_health` output, show used/remaining tokens per provider/model
- **Ties into:** First-Class Brain & Lobe Intelligence — cost-aware routing needs this data

### Fix Lobe Delegation
- **Codex:** Config/auth issue — returns "For more information, try '--help'" instead of running
- **Gemini:** Workspace access — can't read `/workspace/extra` from lobe context, only `/workspace/group`

### Resume After Restart (Deployed)
- **Status:** Deployed to both engineer and commander
- **What:** Bot auto-resumes pending work after restart instead of going idle
- **How:** `injectResumeMessage()` fires when there's an active objective, not just pending messages

## Completed

### Mount Security — Subdirectory Permission Overrides
- `findChildOverrides()` in `mount-security.ts` auto-generates overlapping mounts for allowlist child entries with different permissions
- `_runtime` is now read-only inside containers while parent InfiniClaw stays writable

### Idle Nudge Loop Fix
- Progress nudges suppressed when last completion contains "done" or "idle"
- Prevents repeated "Done. Idle." messages

### Skills System Workflow
- Skills created in container session (`/home/node/.claude/skills/`), synced to persona source automatically
- Can't create skills for other bots — must message them
