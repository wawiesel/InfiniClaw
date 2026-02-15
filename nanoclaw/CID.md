# CID: johnny5-bot Improvement Handoff

## 1) Purpose (General)

`cid-bot` is the infrastructure brain and maintainer/orchestrator for `johnny5-bot`.

Primary goals:
- Keep johnny5-bot continuously responsive in chat.
- Preserve durable context across restarts and long-running work.
- Run background execution safely without making the main thread feel dead.
- Improve reliability without introducing ad-hoc behavior.

Success criteria:
- User gets a useful acknowledgement/progress signal quickly.
- Status questions return concrete state (done/running/next), not generic boilerplate.
- Work can continue in the background while main chat remains interactive.
- Mission context survives runtime churn and restarts.

## 2) Current Product Intent

johnny5-bot currently operates as:
- A main brain thread (`MAIN(provider,llm)`) for conversation + orchestration.
- Optional delegated lobes (codex/gemini/ollama) for parallel/background execution.
- A Matrix interface layer for user IO.
- A containerized execution runtime (podman) for isolation.

The latest direction is: one assistant identity multitasking, not many "different bots".

## 3) Core Design Principles

- One identity in user-facing chat.
- Delegation means lobe cloning under main-brain control, not autonomous handoff.
- Event-based updates over synthetic chatter.
- No fake progress text when nothing happened.
- Main thread remains responsive while work continues in active runs/workers.
- Durable mission state must exist in memory docs and in runtime state.

## 4) Mission Context (WANDA) - Durable Source

Authoritative durable mission text now lives in:
- `groups/main/CLAUDE.md` in `## Current Mission`

Current mission summary:
- WANDA 2026 extraction/organization pipeline.
- Why: create reliable searchable corpus (markdown/images/thread docs).
- Known state: many PDFs, partial no-OCR success, OCR backlog remains.
- Requirement: main must stay responsive while background work progresses.

## 5) Architecture and Flow (General -> Specific)

High-level flow:
1. Matrix message enters `src/channels/matrix.ts`.
2. Message stored and grouped in DB via main loop (`src/index.ts`).
3. Queue dispatches to active run or starts new container run (`src/group-queue.ts`, `src/container-runner.ts`).
4. Container agent (`container/agent-runner/src/index.ts`) runs Claude SDK and MCP tools.
5. Outputs stream back through sentinel markers and are sent to Matrix.

Key runtime components:
- Host orchestrator: `src/index.ts`
- Queue/process management: `src/group-queue.ts`
- Container execution: `src/container-runner.ts`
- Matrix channel: `src/channels/matrix.ts`
- In-container agent logic: `container/agent-runner/src/index.ts`
- Delegate tools (codex/gemini/ollama): `container/agent-runner/src/ipc-mcp-stdio.ts`

## 6) Major Work Already Implemented (Specific)

### 6.1 Main sender and markdown formatting

- Standardized main output to:
  - `MAIN(provider,llm):\n\n<message>`
- Ensures markdown render works reliably in Matrix.

Relevant files:
- `src/index.ts`
- `src/ipc.ts`

### 6.2 File link markdown support

`file://` links are allowed in markdown link sanitizer.

Relevant file:
- `src/channels/matrix.ts` (`sanitizeHref` accepts `file://`)

### 6.3 Removed synthetic auto-resume behavior

Removed auto-injected synthetic prompts that produced "auto message" noise and confusion.

Result:
- No fake "continue working" injections.
- Status/heartbeat now tied to real queue/run activity.

Relevant file:
- `src/index.ts`

### 6.4 Real status telemetry (not boilerplate)

Added per-chat activity tracking:
- current objective
- run start time
- latest progress
- last completion
- last error

Status text now reports real values from this telemetry.

Relevant file:
- `src/index.ts`

### 6.5 Status probe handling fixes

Questions like:
- "what are you doing"
- "what are you working on"
are treated as status probes, not new objectives.

Also added live status nudge to active run when stale.

Relevant file:
- `src/index.ts`

### 6.6 Auto-nudge for silent long runs

If main run stays active with no output for too long, host injects a progress nudge to force concise update.

Relevant file:
- `src/index.ts`

### 6.7 Responsiveness tuning for sub-second feel

Polling tightened:
- `POLL_INTERVAL` default: `250ms` (env-overridable)
- `IPC_POLL_INTERVAL` default: `200ms` (env-overridable)

Immediate acknowledgement when user message is injected into active run:
- "received and injected into active run..."

Relevant files:
- `src/config.ts`
- `src/index.ts`

### 6.8 Matrix timeout guards to avoid event-loop stalls

Added hard timeouts around matrix calls that previously could hang processing:
- send message/text
- typing
- health check
- metadata/profile lookups
- file/image upload send paths

Relevant file:
- `src/channels/matrix.ts`

### 6.9 Single-identity multitasking output for delegates

When running in main context, delegate output is emitted as main identity text with worker label in body, instead of separate sender persona behavior.

Relevant file:
- `container/agent-runner/src/ipc-mcp-stdio.ts`

### 6.10 Better incremental output from main LLM

Container agent now emits assistant text progressively (line-by-line style behavior) instead of waiting only for final result block.

Relevant file:
- `container/agent-runner/src/index.ts`

### 6.11 Persistent mission continuity across restarts

Added chat activity persistence in router state with restore-on-demand, and mission-context injection into new MAIN prompts.

What is persisted:
- objective
- recent user context
- completion/error summaries
- timestamps

Relevant file:
- `src/index.ts`

## 7) Model/Provider Routing Notes

Critical routing behavior for Ollama via Anthropic-compatible path:
- `ANTHROPIC_BASE_URL` must be host endpoint root, not `/v1`.
- Correct example: `http://host.containers.internal:11434`
- `ANTHROPIC_MODEL` set to desired Ollama model.
- `ANTHROPIC_AUTH_TOKEN=ollama` retained for auth path compatibility.

Observed failure mode when misconfigured:
- requests attempted on `/v1/v1/...` and failed.

## 8) Delegate Control Surface (One Supported Way)

Supported path to run background workers from main:
- `delegate_codex`
- `delegate_gemini`
- `delegate_ollama`

Control tools:
- `delegate_list`
- `delegate_status`
- `delegate_cancel`
- `delegate_amend`

These are implemented in:
- `container/agent-runner/src/ipc-mcp-stdio.ts`

## 9) Operational Runbook

Build/check:
- `npm run typecheck`
- `npm run build`
- `npm --prefix container/agent-runner run build`

Restart service:
- `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

Check service:
- `launchctl print gui/$(id -u)/com.nanoclaw`

Check active runtime containers:
- `podman ps | rg nanoclaw-`

Inspect logs:
- `tail -n 200 logs/nanoclaw.log`
- `tail -n 200 logs/nanoclaw.error.log`

## 10) Known Issues / Risks

- Matrix/network instability can still cause reconnect churn; timeout guards now reduce full-loop stalls.
- Podman sometimes starts in unavailable state; runtime recovery exists but adds startup latency.
- Existing temp debug artifacts remain in repo root (`.tmp-*`) due prior policy constraints during cleanup.
- Delegate providers vary in reliability by environment/auth state.

## 11) Immediate Backlog for cid-bot

1. Add explicit startup self-check command that verifies:
- Matrix auth + send test
- podman health
- model endpoint reachability
- delegate command availability

2. Add status endpoint in main that always returns:
- active objective
- current run age
- last emitted model output timestamp
- active delegates summary

3. Add regression tests for:
- status probe classification
- objective not being overwritten by status questions
- markdown sender formatting
- matrix timeout behavior

4. Add optional "stream mode" toggle to control verbosity per chat.

5. Add structured incident log file for unresponsive episodes with root-cause labels.

## 12) File-Level Change Map (Most Relevant)

- `groups/main/CLAUDE.md`
  - Added durable WANDA mission section and delegation discipline clarifications.

- `src/index.ts`
  - Event-based status engine.
  - Status probe detection + live nudge.
  - Active run auto-progress nudge.
  - Immediate active-run ack.
  - Persistent mission context storage and injection.

- `src/config.ts`
  - Faster polling defaults (`POLL_INTERVAL`, `IPC_POLL_INTERVAL`).

- `src/channels/matrix.ts`
  - Timeout wrapper and guarded matrix operations.
  - Markdown handling improvements retained.

- `src/ipc.ts`
  - Standardized sender/body newline formatting for markdown rendering.

- `container/agent-runner/src/index.ts`
  - Main dispatcher policy text.
  - Incremental assistant text emission.

- `container/agent-runner/src/ipc-mcp-stdio.ts`
  - Single-identity delegate message publishing behavior in main context.

## 13) Handoff Summary

`cid-bot` should start from this baseline and focus on reliability + responsiveness enforcement, not feature churn.

Recommended first action on takeover:
- Validate current mission in `groups/main/CLAUDE.md`.
- Run health checks and confirm first useful response latency from user message to first assistant output.
- Keep all future behavior tied to real events and durable context.
