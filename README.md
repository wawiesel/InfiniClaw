<p align="center">
  <img src="docs/assets/infiniclaw-banner.png" alt="InfiniClaw" width="1200">
</p>

> ⚠️ **Alpha / Sandbox / Pre-release Experiment** — This project is under active development and not yet stable. Expect breaking changes, rough edges, and incomplete documentation.

# InfiniClaw v1.15.25

InfiniClaw is a multi-agent orchestration system that operates a fleet of autonomous AI bots on Matrix. Each bot runs in a secure Podman container, utilizing a "Branch and Merge" threading model to ensure constant responsiveness and deep task execution.

## Bots

| Persona | Role | Room | Focus |
|---------|------|------|-------|
| `johnny5` | Navigator (Commander) | Bridge | Task execution, research, analysis |
| `nora` | Navigator | Bridge | Planning, scheduling, email, calendar |
| `cid` | Engineer | Engineering | Infra, builds, deployments, code changes |
| `parker` | Engineer | Engineering | Health metrics, monitoring, diagnostics |
| `albert` | Architect | Astrometrics | Architecture, refactoring, AEGIS |
| `murdock` | Engineer | Engineering | WKS performance, filesystem search |

## Quick start

1. Configure secrets (env files) at `~/.config/infiniclaw/secrets/bots/{bot}/env`

2. Register this machine in `fleet.json` and assign bots (see secrets repo `README.md`)

3. Build container images:

```bash
./bots/build.sh all
```

4. Start all bots:

```bash
npm run cli start
```

5. Stop all bots:

```bash
npm run cli stop
```

### What start/stop do

**`start`** — For each bot in `fleet.json` assigned to this ship:
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

1. **Base** (`bots/CLAUDE.md`) — shared bot instructions, fleet architecture
2. **Persona** (`bots/{role}/{bot}/CLAUDE.md`) — identity, rules, style (writable by bot)
3. **Room** (`bots/{role}/ROOM.md`) — room-specific context (read-only)

See `bots/README.md` for full structure.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for commit style, PR process, and test requirements.

## Values

See [`VALUES.md`](VALUES.md) for the Captain's guiding principles — simplicity, consistency, functionality.

## Design

See [`docs/design/README.md`](docs/design/README.md) for the architecture document index.

## Testing

```bash
npx vitest run --root .
```

Test timeout is configured in `vitest.config.ts` (10s default to accommodate pm2-dependent metrics tests).

## Hooks

`.claude/hooks/` contains PostToolUse hooks that enforce architectural rules:

- **`check-hardcoded-literals.sh`** — Blocks edits that hardcode values from fleet.json (bot names, room IDs, S3 secrets). Config values must be read at runtime.

## Notes

- Container images are per-persona: `nanoclaw-cid`, `nanoclaw-johnny5`, `nanoclaw-nora`, `nanoclaw-parker`, `nanoclaw-albert`.
- Cross-bot communication: `<m>BotName</m> message` in any room auto-forwards to the target bot's room.
- NanoClaw dependency: `external/nanoclaw/` tracks upstream. InfiniClaw extensions in `src/nanoclaw-ext.d.ts` and friends.

- **WBS 3.1 MCP tools**: `wbs_read`, `wbs_get_assigned`, `wbs_update` added to agent-runner tools. Bots can now read and update the Work Breakdown Structure directly from their tool context.
- **WBS 5.1 `get_metrics` MCP tool**: Bots can call `get_metrics` (no args) to read their own performance data — current status, model, active groups with objectives and last error, and 1-day token usage computed from JSONL session files.
<!-- auto-updated: 2026-03-31T00:16:59Z -->
