# InfiniClaw Design

InfiniClaw is a multi-agent orchestration system that operates a fleet of autonomous AI bots on Matrix. Each bot runs in a secure Podman container with a persistent Main Brain process. Complex work is delegated to ephemeral Thread Brains and async lobes via a "Branch and Merge" threading model.

## Core Principles

- **Bots must be instantly responsive.** The Main Brain is a persistent process that stays available on the main timeline. Complex work is immediately delegated via `branch_to_thread` to ephemeral Thread Brains. The Main Brain never blocks.
- **Branch, don't interrupt.** New requests are fielded instantly by the Main Brain, which spins up concurrent Thread Brains without destroying existing task contexts. The container interrupt system uses SIGTERM only for turn timeout enforcement — not to cancel work.
- **Autonomous Fleet Management.** Bots manage their own lifecycles: rebuilding images, fixing configuration, monitoring health, and migrating between machines without human intervention.
- **Matrix as State Engine.** Matrix threads provide the permanent, immutable history of every task. While AI processes are ephemeral, the conversation context is immortal and can be hydrated into new processes on-demand.
- **Presence over spam.** Bots do not post working/idle/resuming indicators. Presence is shown via a pip emoji on the display name: `<pip> <name> <shipEmoji>` (e.g. `🟢 Cid 🦁`). The pip reflects operational status, not location. The relay posts lifecycle events (wake/sleep/refit) via the loudspeaker with `relay <action>` prefix — these are system telemetry, distinct from conversation.
- **System actions get an emoji prefix.** Any message that isn't a direct conversation response must start with an emoji.
- **Git SHAs use a standard format.** Every git SHA displayed in Matrix must use: `📦 [sha](link) (age) ↑N` — SHA hyperlinked to the GitHub commit, with age and up/down relation.
- **Fix code and process, not behavior.** When a bot behaves incorrectly, fix the underlying system — the code, the IPC flow, the routing logic — not the bot's in-context behavior.

## Code Structure

InfiniClaw utilizes the NanoClaw core library for low-level container and IPC mechanics.

| Layer | Purpose |
|-------|---------|
| InfiniClaw host | Orchestrator, Matrix channel, routing, IPC, CLI |
| NanoClaw core library | Lifecycle, SQLite, queuing, scheduling |
| Container agent | Runs inside containers: Claude CLI, MCP tools, IPC |
| Bot definitions | Personas, roles, Dockerfiles, skills |
