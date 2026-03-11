# InfiniClaw Design

InfiniClaw is a multi-agent orchestration system that operates a fleet of autonomous AI bots on Matrix. Each bot runs in a secure Podman container with a persistent main brain. Complex work is delegated to ephemeral branch brains and lobes via a "Branch and Merge" threading model.

## Definitions

> **Fleet** — All ships and bots, collectively. Coordinated via `fleet.json` in the secrets repo.
>
> **Ship** — A machine running a relay. Identified by hostname, registered in `ships.json`. Examples: HERACLES, Poseidon.
>
> **Relay** — The ship's control plane. A pm2-managed process that connects to Matrix, dispatches `!` commands, manages bot lifecycle, syncs code, and spawns branch brains. One per ship, always running.
>
> **Bot** — A Matrix account backed by a Podman container. Has a persona, role, rank, and lifecycle status (`sleep`, `quarters`, `onduty`).
>
> **Operator** — The human-in-the-loop escape hatch. A Matrix account (`@operator`) and a tmux session on each ship. Receives forwarded Captain messages and can intervene directly.
>
> **Space** — A Matrix space that groups related rooms. Each ship has a space; quarters rooms are grouped under a quarters sub-space.
>
> **Room** — A Matrix room where bots and humans communicate. Named with double-emoji prefix: `<location><type> Name`.
>
> **Duty room** — A fleet-wide shared room (Engineering, Bridge, Astrometrics). Bots join via `!report` and leave via `!dismiss`. Uses `🌌` location emoji.

## Core Principles

- **Bots must be instantly responsive.** The main brain is a persistent process that triages instantly. Complex work is delegated to ephemeral branch brains. The main brain never blocks.
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
