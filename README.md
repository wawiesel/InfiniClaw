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
cd nanoclaw && npm run cli start
```

Stop bots:

```bash
cd nanoclaw && npm run cli stop
```

Terminal chat:

```bash
cd nanoclaw && npm run cli chat engineer
cd nanoclaw && npm run cli chat commander
```

## Brain LLM per bot

Each bot has a single brain config section in its profile env:

- `bots/profiles/engineer/env`
- `bots/profiles/commander/env`

Set:

- `BRAIN_MODEL` (required model id)
- `BRAIN_BASE_URL` (optional backend endpoint)
- `BRAIN_AUTH_TOKEN` / `BRAIN_API_KEY` / `BRAIN_OAUTH_TOKEN` as needed

The CLI maps these to NanoClaw runtime env (`ANTHROPIC_*` / `CLAUDE_CODE_OAUTH_TOKEN`).
This keeps model/backend switching to one place per bot.

## Directory structure

```
nanoclaw/      Core code (NanoClaw fork via git subtree)
bots/          Bot definitions: personas, profiles, container images, config
docs/          Design docs and assets
_runtime/      Gitignored runtime state: instances, data, logs
```

## Design

See [`docs/DESIGN.md`](docs/DESIGN.md) for architecture, boundaries, and operating model.

## Notes

- `nanoclaw/` is a git subtree from `wawiesel/nanoclaw` — editable in place, push changes back with `git subtree push`.
