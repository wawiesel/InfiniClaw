# agent-runner `src/` — What Goes Here

This is the **in-container agent runner**: the process that spawns inside each bot's Podman container, receives a prompt via stdin, runs the Claude Code CLI, and streams output back. It is the boundary between InfiniClaw's host orchestration and the Claude agent itself.

**Owner:** Cid (InfiniClaw engineer). Changes here affect all bot containers and require a rebuild to deploy.

## What belongs here

- Claude Code CLI invocation and output streaming
- MCP tool implementations exposed to the bot (infiniclaw tools)
- Lobe delegation (spawning sub-agents for parallel work)
- Tool progress formatting (HTML `<details>` blocks for Matrix threads)
- Pre/PostToolUse hooks (transcript archive, bash sanitization, todo tracking)
- IPC MCP stdio proxy for task-mode containers

## What does NOT belong here

- Host-side orchestration → `../../src/` (InfiniClaw)
- Bot persona logic → `../../../../bots/`

## Key files

| File | Purpose |
|------|---------|
| `index.ts` | Entry point: reads ContainerInput from stdin, spawns `claude` CLI, streams output, processes follow-up IPC messages between runs. Supports `forkSession` for branch brain mode (single run, assistant text emitted as progress, exit after completion). Truncates older session JSONL entries when file exceeds `SESSION_MAX_BYTES` (preserves metadata + recent turns). Emits `isSessionError` when stale session detected and retry triggered. |
| `tools.ts` | MCP server tools: `get_last_event_id`, `get_message` (Matrix API via injected credentials), `send_reaction`, `send_image`, `send_file`, `set_brain_mode`, `get_brain_mode`, `get_metrics`, `restart_self`, `git_push`, `podman_exec`, `holodeck_create/teardown/promote/send/read/status`, `request/submit/check/list_verifications` |
| `delegate-runner.ts` | Implements `delegate_to_lobe` — spawns codex/gemini/claude/ollama sub-processes, threads results back. (`branch_to_thread` removed — use `{{branch}}` signal per 22-signals.md) |
| `progress.ts` | `formatToolCallWithOutput` — formats tool calls as HTML `<details>` blocks for Matrix; `createToolProgressHook` for PostToolUse |
| `bot-messaging.ts` | `emitChatMessageTo` — writes outgoing messages to IPC messages dir for host pickup |
| `model-selection.ts` | Resolves effective lobe model based on lobe type and env |
| `ipc-mcp-stdio.ts` | Stdio MCP server (`infiniclaw`) for bot containers — provides task scheduling, IPC tools. Renamed from `nanoclaw` to `infiniclaw`. |

## Engineer observations (updated 2026-03-21)

- **`delegate_to_lobe`**: Spawns codex/gemini/claude/ollama as a subprocess. All lobes are prohibited from using intercom tools — output goes to delegate thread automatically.
- **`delegatedObjective`**: The full objective passed to lobes. Includes execution constraints prepended (no venvs in /workspace/persona, no cache pollution, no communication tools).
- **`{{branch}}` signal**: Bots output `{{branch title="X" objective="Y"}}` inline — relay intercepts, posts text as thread root, spawns BB. Replaces the old `branch_to_thread` MCP tool.
- **Tool restriction**: `index.ts` has a `BLOCKED_TOOLS` set (SendMessage, TeamCreate, TeamDelete in staging) — prevents certain Claude Code built-ins from being called by bots.
- **Claude CLI args**: `--print --verbose --output-format stream-json --dangerously-skip-permissions --model {model} --add-dir {cwd}`. Objective passed via stdin.
- **Lobe result delivery**: On lobe exit, writes `result-{lobeId}.json` to IPC input dir. Main brain picks it up on next turn and posts it to the delegate thread.
- **`ipc-mcp-stdio.ts`**: Task containers (IPC-spawned, not interactive) get a restricted MCP toolset. Used when `context_mode: "group"` injects a prompt into a running session.
- **MCP config dual-write**: `writeMcpConfig` writes to both `~/.claude/settings.json` (global) and `.mcp.json` (project-level) because Claude Code's `enableAllProjectMcpServers` makes project-level configs override global ones. Without the `.mcp.json` write, a stale project config from a previous room (e.g. Engineering) would override the current chatJid (e.g. quarters).

- **WBS MCP tools** (`tools.ts`): `wbs_read` (list items by room/status), `wbs_get_assigned` (tasks for a bot), `wbs_update` (mark status/assignee). Read `_runtime/data/wbs-{room}.json`.
- **`get_metrics`** (`tools.ts`): Returns the calling bot's own performance data — current status, model, active groups with objectives/errors, and 1-day token usage computed from JSONL session files at `/home/node/.claude/projects`. Uses `ipcDir/status.json` (written by main.ts every 30s) for runtime state.
- **Removed tools** (2026-03-21): `send_message`, `register_group`, `crew_roster`, `list_recipients`, `set_thread`, `restart_wksm`, `check_health`, `query_local_llm`. MCP server key and env vars renamed `nanoclaw` → `infiniclaw` (tools now `mcp__infiniclaw__*`).
