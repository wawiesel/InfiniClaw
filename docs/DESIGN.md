# InfiniClaw Design

InfiniClaw is a multi-bot orchestration layer built on a maintained NanoClaw fork. It runs cooperating AI bots on Matrix, each isolated in its own Podman container. The Captain (human) sets direction. Bots execute everything else.

## Core Principles

- **Layer on NanoClaw, don't fork it.** Use everything from upstream. InfiniClaw wraps NanoClaw's entry points (`main.ts` wraps `index.ts`, `container-spawn.ts` wraps `container-runner.ts`). The upstream subtree at `external/nanoclaw/` stays clean.
- **Bots are autonomous.** They rebuild their own images, fix broken MCP, update their own config, monitor their own health, and recover from failures — all without human intervention. The Operator (host-side agent) exists only as an escape hatch for OS-level problems.
- **Bots must be responsive at all times.** Long work is delegated to lobes. The main brain stays available. If it's busy anyway, the host spawns an interrupt lobe as a safety net.
- **No redactions.** Status messages are never deleted. They have a live state and a finished state: `⏳ working (3m)` → `⏳ worked (3m)`.
- **No silent failures.** Every failed message send must be retried or surfaced as a visible error. If a bot can't deliver, it logs the failure with full context and retries. Silent `.catch(() => {})` is a bug.
- **System actions get an emoji prefix.** Any message that isn't a direct conversation response (restarts, working indicator, brain reload, startup) must start with an emoji.
- **Work with Claude Code, not against it.** Bots run on Claude Code CLI (spawned by the agent-runner inside containers). When Claude Code has a preferred way to do something, use it. If it introduces a tool that overlaps with ours, prefer one-way sync over blocking it.
- **Fix code and process, not behavior.** When a bot behaves incorrectly, fix the underlying system — the code, the IPC flow, the routing logic — not the bot's in-context behavior. Workarounds that patch behavior without addressing root cause accumulate debt and mask real problems.
- **SSL passthrough.** Containers and host processes must forward corporate SSL variables (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`) and mount host certificates for TLS inspection proxies.

## Design Documents

Feature docs, ordered from foundational to high-level:

| # | Feature | Description |
|---|---------|-------------|
| [00](design/00-containers.md) | Containers | Podman containers, mounts, secrets |
| [01](design/01-messaging.md) | Messaging | Message flow, routing, filtering, queue |
| [02](design/02-threading.md) | Threading | Threads, lobes, interrupt lobes, status indicators |
| [03](design/03-ipc.md) | IPC | Container ↔ host communication, namespaces, cooldowns |
| [04](design/04-fleet.md) | Fleet | Rooms, machines, presence, roles, rank |
| [05](design/05-commanding-officer.md) | Commanding Officer | CO election, badges, crew-status.json |
| [06](design/06-commands.md) | Commands | Operator `!` commands, supervisor process |
| [07](design/07-intercom.md) | Intercom | Cross-room relay accounts, operator messaging |
| [08](design/08-autonomy.md) | Autonomy | Self-healing, image rebuilds, IPC tasks, holodeck |
| [09](design/09-configuration.md) | Configuration | CLAUDE.md layers, MCP, brain, sessions, startup |
| [10](design/10-safety.md) | Safety | OOM, memory architecture, cooldowns, security |

## Code Structure

InfiniClaw wraps NanoClaw entry points via npm workspaces (`import from 'nanoclaw/config.js'`). See `src/README.md` for the full file map.

| Layer | Location | Purpose |
|-------|----------|---------|
| InfiniClaw host | `src/` | Orchestrator, Matrix channel, container spawning, IPC, CLI |
| NanoClaw framework | `external/nanoclaw/src/` | Container lifecycle, SQLite, queuing, routing, scheduling |
| Container agent | `external/nanoclaw/container/agent-runner/` | Runs inside containers: Claude SDK, MCP tools, IPC |
| Bot definitions | `bots/` | Personas, roles, Dockerfiles, skills |

**Thick wrapper, not plugin hooks.** `main.ts`, `container-spawn.ts`, and `ipc-watcher.ts` are near-total forks of their upstream counterparts. Adding hook/plugin interfaces to NanoClaw was considered and rejected — it would introduce fragile interface coupling and make subtree pulls harder. Since upstream changes infrequently, forking the loop and rewriting directly is the correct design choice at this scale. Any upstream changes are manually ported.
