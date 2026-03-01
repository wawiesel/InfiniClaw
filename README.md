<p align="center">
  <img src="docs/assets/infiniclaw-banner.png" alt="InfiniClaw" width="1200">
</p>

> ⚠️ **Alpha / Sandbox / Pre-release Experiment** — This project is under active development and not yet stable. Expect breaking changes, rough edges, and incomplete documentation.

# InfiniClaw

Multi-bot orchestration built on a maintained NanoClaw fork. Bots run on Matrix, execute tasks in Podman containers, and coordinate via IPC.

## Bots

| Persona | Role | Room | Focus |
|---------|------|------|-------|
| `johnny5` | Navigator (Commander) | Bridge | Task execution, research, analysis |
| `nora` | Navigator | Bridge | Planning, scheduling, email, calendar |
| `cid` | Engineer | Engineering | Infra, builds, deployments, code changes |
| `parker` | Engineer | Engineering | Health metrics, monitoring, diagnostics |
| `albert` | Architect | Astrometrics | Architecture, refactoring, AEGIS, nanoclaw |

## Quick start

1. Configure secrets (env files) at `~/.config/infiniclaw/secrets/{persona}/env`

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
1. Syncs persona data (skills, groups) from any previous instance back to the repo
2. Rsyncs `nanoclaw/` into `_runtime/instances/{bot}/nanoclaw/`
3. Appends the bot's persona CLAUDE.md to the base CLAUDE.md
4. Restores group CLAUDE.md files into the instance
5. Seeds the bot's main room from the env file (`MAIN_GROUP_NAME`)
6. Installs and loads a launchd plist — the bot runs as a background service

**`stop`** — For each installed bot (has a loaded plist):
1. Syncs persona data back to the repo (skills, CLAUDE.md, MCP servers)
2. Unloads the launchd plist
3. Kills any lingering podman containers for that bot

## Brain config

Each bot's brain (LLM provider) is configured in its profile env:

- `BRAIN_MODEL` — model id (required)
- `BRAIN_BASE_URL` — backend endpoint (optional, for Ollama/custom)
- `BRAIN_AUTH_TOKEN` / `BRAIN_API_KEY` / `BRAIN_OAUTH_TOKEN` — auth credentials

Supports Anthropic (Claude), Ollama (local models), and any OpenAI-compatible API. Brain mode is switchable at runtime via MCP tools.

## Persona system

Bot identity is defined in three layers of CLAUDE.md:

1. **Base** (`nanoclaw/CLAUDE.md`) — framework behavior, shared by all bots
2. **Persona** (`bots/personas/{bot}/CLAUDE.md`) — identity, rules, style (two-way sync: bot can edit)
3. **Group** (`groups/{group}/CLAUDE.md`) — room-specific context (one-way: repo to bot, read-only)

Each persona also includes:
- `skills/` — bot-specific skills (two-way sync)
- `mcp-servers/` — bot-specific MCP servers (two-way sync)
- `container-config.json` — additional mounts and MCP server declarations

## Directory structure

```
nanoclaw/                         NanoClaw fork (git subtree from wawiesel/nanoclaw)
bots/
  roles/{role}/                   Abstract capability sets
    role.md                       Role description, rank, capabilities
    skills/                       Shared skills for all bots with this role
    mcp-servers/                  Shared MCP configs for all bots with this role
  personas/{persona}/             Concrete bot identities (nora, johnny5, cid, parker, albert)
    CLAUDE.md                     Persona instructions (two-way sync)
    skills/                       Bot-specific skills (two-way sync)
    mcp-servers/                  Bot-specific MCP servers (two-way sync)
    container-config.json         Mounts + declarative MCP servers
    groups/{group}/CLAUDE.md      Room context (one-way: repo → bot)
  container/{persona}/Dockerfile  Per-bot container image
  container/build.sh              Build container images
  config/
    mount-allowlist.json          Template for host-side mount security
groups/                           Group working directories (mounted into containers)
docs/
  DESIGN.md                       Architecture and design
  assets/                         Images, banners
_runtime/                         Gitignored runtime state
  instances/                      Per-bot deployed instances
  data/                           SQLite, sessions, IPC, cache
  logs/                           Bot stdout/stderr logs
```

## Design

See [`docs/DESIGN.md`](docs/DESIGN.md) for architecture, security model, and operations.

## Notes

- `nanoclaw/` is a git subtree from `wawiesel/nanoclaw` — editable in place, push changes back with `git subtree push`.
- Container images are per-persona: `nanoclaw-cid`, `nanoclaw-johnny5`, `nanoclaw-nora`, `nanoclaw-parker`, `nanoclaw-albert`.
- Cross-bot communication: `@BotName message` in any room auto-forwards to the target bot's room.
