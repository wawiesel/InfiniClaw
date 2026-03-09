# InfiniClaw Design

InfiniClaw is a multi-agent orchestration system that operates a fleet of autonomous AI bots on Matrix. Each bot runs in a secure Podman container, utilizing a "Branch and Merge" threading model to ensure constant responsiveness and deep task execution.

## Core Principles

- **Bots must be instantly responsive.** The Main Brain stays permanently available on the main timeline, "minding the store." Complex work is immediately delegated via a "Branch and Merge" architecture to ephemeral Thread Brains and async lobes.
- **No destructive interrupts.** We do not use `SIGTERM` to kill active processes. New requests are fielded instantly by the Main Brain, which spins up concurrent Thread Brains without destroying existing task contexts.
- **Autonomous Fleet Management.** Bots manage their own lifecycles: rebuilding images, fixing configuration, monitoring health, and migrating between machines without human intervention.
- **Matrix as State Engine.** Matrix threads provide the permanent, immutable history of every task. While the AI processes (Thread Brains) are ephemeral, the conversation context is immortal and can be hydrated into new processes on-demand.
- **No status message spam.** Bots do not post working/idle/resuming indicators. Presence is shown via a single pip emoji on the display name: onduty 🟢, CO ⭐, lounge 🍸, quarters 🏠, sleep 💤, transit 🚀. Display format: `<name> <pip> [<ship>]`. CO is a status, not a separate badge.
- **System actions get an emoji prefix.** Any message that isn't a direct conversation response (restarts, working indicator, brain reload, startup) must start with an emoji.
- **Git SHAs use a standard format.** Every git SHA displayed in Matrix must use: 📦 [sha](link) (age) ↑N — SHA hyperlinked to the GitHub commit, with age and up/down relation. Always include the 📦 box so version strings are noticeable everywhere.
- **Fix code and process, not behavior.** When a bot behaves incorrectly, fix the underlying system — the code, the IPC flow, the routing logic — not the bot's in-context behavior. Workarounds that patch behavior without addressing root cause accumulate debt and mask real problems.
- **Status is system telemetry, not conversation.** Status messages are delivered via the loudspeaker (`@loudspeaker`) from the relay — repo versions, fleet health, lifecycle changes. Distinct from conversation. Example: 📦 [sha](link) (age) ↑N.

## Code Structure

InfiniClaw utilizes the `nanoclaw` core library for low-level container and IPC mechanics.

| Layer | Location | Purpose |
|-------|----------|---------|
| InfiniClaw host | `src/` | Orchestrator, Matrix channel, routing, IPC, CLI |
| Core Library | `external/nanoclaw/src/` | Lifecycle, SQLite, queuing, scheduling |
| Container agent | `bots/container/agent-runner/` | Runs inside containers: Claude CLI, MCP tools, IPC |
| Bot definitions | `bots/` | Personas, roles, Dockerfiles, skills |

