# InfiniClaw Design

InfiniClaw is a multi-agent orchestration system that operates a fleet of autonomous AI bots on Matrix. Each bot runs in a secure Podman container, utilizing a "Branch and Merge" threading model to ensure constant responsiveness and deep task execution.

## Core Principles

- **Bots must be instantly responsive.** The Main Brain stays permanently available on the main timeline, "minding the store." Complex work is immediately delegated via a "Branch and Merge" architecture to ephemeral Thread Brains and async lobes.
- **No destructive interrupts.** We do not use `SIGTERM` to kill active processes. New requests are fielded instantly by the Main Brain, which spins up concurrent Thread Brains without destroying existing task contexts.
- **Autonomous Fleet Management.** Bots manage their own lifecycles: rebuilding images, fixing configuration, monitoring health, and migrating between machines without human intervention.
- **Matrix as State Engine.** Matrix threads provide the permanent, immutable history of every task. While the AI processes (Thread Brains) are ephemeral, the conversation context is immortal and can be hydrated into new processes on-demand.
- **No redactions.** Status messages are never deleted. They have a live state and a finished state: `⏳ working (3m)` → `⏳ worked (3m)`.
- **System actions get an emoji prefix.** Any message that isn't a direct conversation response (restarts, working indicator, brain reload, startup) must start with an emoji.
- **Fix code and process, not behavior.** When a bot behaves incorrectly, fix the underlying system — the code, the IPC flow, the routing logic — not the bot's in-context behavior. Workarounds that patch behavior without addressing root cause accumulate debt and mask real problems.

## Design Documents

Feature docs, ordered from foundational to high-level:

| # | Feature | Description |
|---|---------|-------------|
| [01](01-messaging.md) | Messaging | Message flow, routing, filtering, queue |
| [02](02-threading.md) | Threading | Thread Brains, lobes, branch and merge, status indicators |
| [03](03-ipc.md) | IPC | Container ↔ host communication, namespaces, cooldowns |
| [04](04-fleet.md) | Fleet | Rooms, machines, roles, rank |
| [05](05-commanding-officer.md) | Commanding Officer | CO election, badges, fleet.json |
| [06](06-commands.md) | Commands | Operator `!` commands, relay process, IPC |
| [07](07-intercom.md) | Intercom | Cross-room relay accounts, operator messaging |
| [08](08-autonomy.md) | Autonomy | Self-healing, image rebuilds, IPC tasks, holodeck |
| [09](09-configuration.md) | Configuration | CLAUDE.md layers, MCP, brain, sessions, startup |
| [10](10-safety.md) | Safety | OOM, memory architecture, cooldowns, security |
| [11](11-containers.md) | Containers | Podman isolation, mounts, secrets |

## Code Structure

InfiniClaw utilizes the `nanoclaw` core library for low-level container and IPC mechanics.

| Layer | Location | Purpose |
|-------|----------|---------|
| InfiniClaw host | `src/` | Orchestrator, Matrix channel, routing, IPC, CLI |
| Core Library | `external/nanoclaw/src/` | Lifecycle, SQLite, queuing, scheduling |
| Container agent | `external/nanoclaw/container/agent-runner/` | Runs inside containers: Claude CLI, MCP tools, IPC |
| Bot definitions | `bots/` | Personas, roles, Dockerfiles, skills |

