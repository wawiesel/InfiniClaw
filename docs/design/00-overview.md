# InfiniClaw Design

InfiniClaw is a multi-agent orchestration system that operates a fleet of autonomous AI bots on Matrix. Each bot runs in a secure Podman container with a persistent Main Brain process. Complex work is delegated to ephemeral Thread Brains and async lobes via a "Branch and Merge" threading model.

## Core Principles

- **Bots must be instantly responsive.** The Main Brain is a persistent process that triages instantly. Complex work is delegated to ephemeral Thread Brains. The Main Brain never blocks.
- **Branch, don't interrupt.** New requests spawn concurrent workers without destroying existing task contexts.
- **Autonomous Fleet Management.** Bots manage their own lifecycles: rebuilding images, fixing configuration, monitoring health, and migrating between machines without human intervention.
- **Matrix as State Engine.** Matrix threads provide the permanent, immutable history of every task. AI processes are ephemeral; conversation context is immortal.
- **Presence over spam.** Status is shown via display name, not messages. Lifecycle events are system telemetry, distinct from conversation.
- **Fix code and process, not behavior.** When a bot behaves incorrectly, fix the underlying system — not the bot's in-context behavior.

## Code Structure

InfiniClaw utilizes the NanoClaw core library for low-level container and IPC mechanics.

| Layer | Purpose |
|-------|---------|
| InfiniClaw host | Orchestrator, Matrix channel, routing, IPC, CLI |
| NanoClaw core library | Lifecycle, SQLite, queuing, scheduling |
| Container agent | Runs inside containers: Claude CLI, MCP tools, IPC |
| Bot definitions | Personas, roles, Dockerfiles, skills |
