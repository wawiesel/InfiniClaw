<p align="center">
  <img src="docs/assets/infiniclaw-banner.png" alt="InfiniClaw" width="1200">
</p>

> ⚠️ **Alpha / Sandbox / Pre-release Experiment** — This project is under active development and not yet stable. Expect breaking changes, rough edges, and incomplete documentation.

# InfiniClaw

InfiniClaw is a multi-agent orchestration system that operates a fleet of autonomous AI bots on Matrix. Each bot runs in a secure Podman container, utilizing a "Branch and Merge" threading model to ensure constant responsiveness and deep task execution.

## Bots

| Persona | Role | Room | Focus |
|---------|------|------|-------|
| `johnny5` | Navigator (Commander) | Bridge | Task execution, research, analysis |
| `nora` | Navigator | Bridge | Planning, scheduling, email, calendar |
| `cid` | Engineer | Engineering | Infra, builds, deployments, code changes |
| `parker` | Engineer | Engineering | Health metrics, monitoring, diagnostics |
| `albert` | Architect | Astrometrics | Architecture, refactoring, AEGIS |

## Quick start

1. Configure secrets (env files) at `~/.config/infiniclaw/secrets/bots/{persona}/env`

2. Configure `~/.config/infiniclaw/machine.json` with which bots run on this machine

3. Build container images:

```bash
./bots/container/build.sh all
```

4. Start all bots:

```bash
npm run cli start
```

5. Stop all bots:

```bash
npm run cli stop
```

6. Terminal chat (direct conversation with a bot):

```bash
npm run cli chat cid
npm run cli chat johnny5
```

### What start/stop do

**`start`** — For each bot in `machine.json`:
1. Rsyncs the core library into `_runtime/instances/{bot}/core/`
2. Appends the bot's persona CLAUDE.md to the base instructions
3. Sets up persistent room context
4. Seeds the bot's main room from the env file (`MAIN_GROUP_NAME`)
5. Installs and loads a launchd plist — the bot runs as a background service

**`stop`** — For each installed bot (has a loaded plist):
1. Unloads the launchd plist
2. Kills any lingering podman containers for that bot

## Brain config

Each bot's brain (LLM provider) is configured in its profile env:

- `BRAIN_MODEL` — model id (required)
- `BRAIN_BASE_URL` — backend endpoint (optional, for Ollama/custom)
- `BRAIN_AUTH_TOKEN` / `BRAIN_API_KEY` / `BRAIN_OAUTH_TOKEN` — auth credentials

Supports Anthropic (Claude), Ollama (local models), and any OpenAI-compatible API. Brain mode is switchable at runtime via MCP tools.

## Persona system

Bot identity is defined in three layers of CLAUDE.md:

1. **Base** (`core/CLAUDE.md`) — framework behavior, shared by all bots
2. **Persona** (`bots/personas/{bot}/CLAUDE.md`) — identity, rules, style (two-way sync: bot can edit)
3. **Group** (`groups/{group}/CLAUDE.md`) — room-specific context (one-way: repo to bot, read-only)

Each persona also includes:
- `skills/` — bot-specific skills (two-way sync)
- `mcp-servers/` — bot-specific MCP servers (two-way sync)
- `container-config.json` — additional mounts and MCP server declarations

## Directory structure

```
src/                              InfiniClaw orchestrator source
external/nanoclaw/                Core mechanics library
bots/
  roles/{role}/                   Abstract capability sets
  personas/{persona}/             Concrete bot identities
  container/{persona}/Dockerfile  Per-bot container image
  container/build.sh              Build container images
groups/                           Group working directories (mounted into containers)
docs/
  design/                         Architecture and design documents
  faq/                            Frequently asked questions
  assets/                         Images, banners
_runtime/                         Local state (SQLite, sessions, IPC, logs)
```

## Design

See [`docs/design/00-overview.md`](docs/design/00-overview.md) for architecture, security model, and operations.

## Notes

- Container images are per-persona: `nanoclaw-cid`, `nanoclaw-johnny5`, `nanoclaw-nora`, `nanoclaw-parker`, `nanoclaw-albert`.
- Cross-bot communication: `@BotName message` in any room auto-forwards to the target bot's room.
