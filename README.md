<p align="center">
  <img src="docs/assets/infiniclaw-banner.png" alt="InfiniClaw" width="1200">
</p>

# InfiniClaw

Multi-bot orchestration built on a maintained NanoClaw fork. Bots run on Matrix, execute tasks in Podman containers, and coordinate via IPC.

## Bots

| Bot | Alias | Room | Role |
|-----|-------|------|------|
| `engineer` | Cid | Engineering | Infra, builds, deployments, code changes |
| `commander` | Johnny5 | Bridge | Task execution, research, analysis |

## Quick start

1. Configure per-bot profiles:

```text
bots/profiles/engineer/env
bots/profiles/commander/env
```

2. Build container images:

```bash
./bots/container/build.sh all
```

3. Start all bots:

```bash
node nanoclaw/dist/cli.js start
```

4. Stop all bots:

```bash
node nanoclaw/dist/cli.js stop
```

5. Terminal chat (direct conversation with a bot):

```bash
node nanoclaw/dist/cli.js chat engineer
node nanoclaw/dist/cli.js chat commander
```

### What start/stop do

**`start`** — For each bot in `bots/profiles/`:
1. Syncs persona data (skills, groups) from any previous instance back to the repo
2. Rsyncs `nanoclaw/` into `_runtime/instances/{bot}/nanoclaw/`
3. Appends the bot's persona CLAUDE.md to the base CLAUDE.md
4. Restores group CLAUDE.md files into the instance
5. Seeds the bot's main room from the profile env (`MAIN_GROUP_NAME`)
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
nanoclaw/                       NanoClaw fork (git subtree from wawiesel/nanoclaw)
bots/
  personas/{bot}/               Bot identity and config
    CLAUDE.md                   Persona instructions (two-way sync)
    skills/                     Bot-specific skills (two-way sync)
    mcp-servers/                Bot-specific MCP servers (two-way sync)
    container-config.json       Mounts + declarative MCP servers
    groups/{group}/CLAUDE.md    Room context (one-way: repo → bot)
  profiles/{bot}/env            Runtime env config (gitignored)
  container/{bot}/Dockerfile    Per-bot container image
  container/build.sh            Build container images
  config/
    mount-allowlist.json        Template for host-side mount security
groups/                         Group working directories (mounted into containers)
docs/
  DESIGN.md                     Architecture and design
  assets/                       Images, banners
_runtime/                       Gitignored runtime state
  instances/                    Per-bot deployed instances
  data/                         SQLite, sessions, IPC, cache
  logs/                         Bot stdout/stderr logs
```

## Design

See [`docs/DESIGN.md`](docs/DESIGN.md) for architecture, security model, and operations.

## Notes

- `nanoclaw/` is a git subtree from `wawiesel/nanoclaw` — editable in place, push changes back with `git subtree push`.
- Container images are per-bot: engineer is lean, commander is full-featured (browser, Python, OCR, build tools).
- Cross-bot communication: `@BotName message` in any room auto-forwards to the target bot's room.
