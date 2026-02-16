<p align="center">
  <img src="docs/assets/infiniclaw-banner.png" alt="InfiniClaw" width="1200">
</p>

# InfiniClaw

Multi-bot orchestration built on a maintained NanoClaw fork.

Runtime: Podman only.

## Bot roles

- `engineer` (infra/operator role)
- `commander` (worker role)

## Quick start

Create per-bot env files from examples:

```text
bots/profiles/engineer/env
bots/profiles/commander/env
```

Start bots:

```bash
./scripts/start
```

Stop bots:

```bash
./scripts/stop
```

Terminal chat:

```bash
./scripts/chat engineer
./scripts/chat commander
```

## Brain LLM per bot

Each bot has a single brain config section in its profile env:

- `bots/profiles/engineer/env`
- `bots/profiles/commander/env`

Set:

- `BRAIN_MODEL` (required model id)
- `BRAIN_BASE_URL` (optional backend endpoint)
- `BRAIN_AUTH_TOKEN` / `BRAIN_API_KEY` / `BRAIN_OAUTH_TOKEN` as needed

The `start` script maps these to NanoClaw runtime env (`ANTHROPIC_*` / `CLAUDE_CODE_OAUTH_TOKEN`).
This keeps model/backend switching to one place per bot.

## Directory structure

```
scripts/       Entry points: start, stop, chat
nanoclaw/      Core code (vendored NanoClaw fork)
bots/          Bot definitions: personas, profiles, container images, config
docs/          Design docs and assets
_runtime/      Gitignored runtime state: instances, data, logs
```

## Design

See [`docs/DESIGN.md`](docs/DESIGN.md) for architecture, boundaries, and operating model.

## Notes

- `nanoclaw/` is currently a normal clone on `main` (not submodule yet).
