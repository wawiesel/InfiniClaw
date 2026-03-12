# agent-runner `src/` — What Goes Here

This is the **in-container agent runner**: the process that spawns inside each bot's Podman container, receives a prompt via stdin, runs the Claude Code CLI, and streams output back. It is the boundary between InfiniClaw's host orchestration and the Claude agent itself.

**Owner:** Cid (InfiniClaw engineer). Changes here affect all bot containers and require a rebuild to deploy.

## What belongs here

- Claude Code CLI invocation and output streaming
- MCP tool implementations exposed to the bot (nanoclaw tools)
- Lobe delegation (spawning sub-agents for parallel work)
- Tool progress formatting (HTML `<details>` blocks for Matrix threads)
- Pre/PostToolUse hooks (transcript archive, bash sanitization, todo tracking)
- IPC MCP stdio proxy for task-mode containers

## What does NOT belong here

- Host-side orchestration → `../../src/` (InfiniClaw) or `../../../src/` (nanoclaw)
- Bot persona logic → `../../../../bots/`
- nanoclaw framework utilities → `../../../src/`

## Key files

| File | Purpose |
|------|---------|
| `index.ts` | Entry point: reads ContainerInput from stdin, spawns `claude` CLI, streams output, processes follow-up IPC messages between runs |
| `tools.ts` | MCP server tools: `crew_roster`, `list_recipients`, `set_thread`, `get_last_event_id`, `get_message`, `send_reaction`, `send_image`, `send_file`, `set_brain_mode`, `get_brain_mode`, `restart_self`, `restart_wksm`, `check_health`, `git_push`, `holodeck_create/teardown/promote/send/read/status`, `request/submit/check/list_verifications` |
| `delegate-runner.ts` | Implements `branch_to_thread` and `delegate_to_lobe` — spawns codex/gemini/claude/ollama sub-processes, threads results back |
| `progress.ts` | `formatToolCallWithOutput` — formats tool calls as HTML `<details>` blocks for Matrix; `createToolProgressHook` for PostToolUse |
| `bot-messaging.ts` | `emitChatMessageTo` — writes outgoing messages to IPC messages dir for host pickup |
| `model-selection.ts` | Resolves effective lobe model based on lobe type and env |
| `ipc-mcp-stdio.ts` | Stdio MCP proxy for task containers — provides a limited tool subset for scheduled/IPC-spawned tasks |

## Engineer observations (updated 2026-03-10)

- **`delegate_to_lobe`**: Spawns codex/gemini/claude/ollama as a subprocess. Since `7c56ab7`, all lobes are prohibited from using `send_message`/`send_image`/intercom tools — output goes to delegate thread automatically.
- **`delegatedObjective`**: The full objective passed to lobes. Includes execution constraints prepended (no venvs in /workspace/persona, no cache pollution, no communication tools).
- **`branch_to_thread`**: Opens a Matrix thread and runs work in that thread. Fire-and-forget — returns immediately, lobe result comes back via IPC result file on the next turn.
- **Tool tool restriction**: `index.ts` has a `BLOCKED_TOOLS` set (SendMessage, TeamCreate, TeamDelete in staging) — prevents certain Claude Code built-ins from being called by bots.
- **Claude CLI args**: `--print --verbose --output-format stream-json --dangerously-skip-permissions --model {model} --add-dir {cwd}`. Objective passed via stdin.
- **Lobe result delivery**: On lobe exit, writes `result-{lobeId}.json` to IPC input dir. Main brain picks it up on next turn and posts it to the delegate thread.
- **`ipc-mcp-stdio.ts`**: Task containers (IPC-spawned, not interactive) get a restricted MCP toolset. Used when `context_mode: "group"` injects a prompt into a running session.
- **MCP config dual-write**: `writeMcpConfig` writes to both `~/.claude/settings.json` (global) and `.mcp.json` (project-level) because Claude Code's `enableAllProjectMcpServers` makes project-level configs override global ones. Without the `.mcp.json` write, a stale project config from a previous room (e.g. Engineering) would override the current chatJid (e.g. quarters).
