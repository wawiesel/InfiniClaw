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

## Values

See [`VALUES.md`](VALUES.md) for the Captain's guiding principles — simplicity, consistency, functionality. See [`NEXT.md`](NEXT.md) for the prioritized task queue (all 21 design docs reviewed; 13 doc fix PRs + feat/wbs-relay + fix/lobe-result-injection + fix/cross-room-message-format pending operator merge; nested dist/ gitignored). Infrastructure documentation (networking, NAS, services) is maintained by the fleet in [`workspace/persona/docs/`](workspace/persona/docs/).

## Design

See [`docs/design/README.md`](docs/design/README.md) for the architecture document index.

## Testing

```bash
npx vitest run --root .
```

Test timeout is configured in `vitest.config.ts` (10s default to accommodate pm2-dependent metrics tests).

## Notes

- Container images are per-persona: `nanoclaw-cid`, `nanoclaw-johnny5`, `nanoclaw-nora`, `nanoclaw-parker`, `nanoclaw-albert`.
- Cross-bot communication: `<m>BotName</m> message` in any room auto-forwards to the target bot's room.
- NanoClaw dependency: `external/nanoclaw/` tracks upstream. InfiniClaw extensions in `src/nanoclaw-ext.d.ts` and friends.
- Health beacons: relay uploads S3 `health/{ship}.json` every 5 min (beacon) and 30 min (full). Includes sync status and uptime fields. `beaconFlushLoop` also caches `_runtime/data/fleet-health.json` so containers can call `check_health(scope=fleet)` without S3 access. See `docs/design/21-cross-machine-health.md` (all 6 steps implemented on `feat/wbs-relay`).
- Intercom: relay connects to each duty room as the room's intercom account (`bridge-intercom`, etc.) to listen for and reply to commands. Operators send commands as their own `@operator` account. See `docs/design/13-intercom.md`.
