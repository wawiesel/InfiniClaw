# agent-runner/ — Container-Side Agent

Runs inside every Podman container. This is what the bot "is" at runtime.

## How it works

1. Host spawns container, pipes a JSON `ContainerInput` to stdin (prompt, session ID, MCP servers, config).
2. `agent-runner` calls the Claude Agent SDK (`query()`) with the prompt and tools.
3. Claude generates a response, calling tools as needed (file ops, bash, MCP, IPC).
4. Output is written to stdout as JSON between output markers (`<<<OUTPUT_START>>>` / `<<<OUTPUT_END>>>`).
5. Host parses markers and forwards results to Matrix.

## Key files

- **src/index.ts** — Entry point: read stdin, call SDK, write output markers.
- **src/tools.ts** — InfiniClaw MCP tool registration: `crew_roster`, `send_message`, `delegate_to_lobe`, IPC commands.
- **src/bot-messaging.ts** — Cross-bot messaging: resolve recipients, format messages.
- **src/delegate-runner.ts** — Lobe delegation: spawn sub-agents (claude, codex, gemini, ollama).

## IPC

The container communicates with the host via filesystem IPC:
- `/workspace/ipc/input/` — host writes follow-up messages here (piped messages while container is running).
- `/workspace/ipc/output/` — container writes command requests here (restart_bot, rebuild_image, git_push).
