<p align="center">
  <img src="assets/infiniclaw-banner.png" alt="InfiniClaw" width="1200">
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
profiles/engineer/env
profiles/commander/env
```

Start bots:

```bash
./start
```

Stop bots:

```bash
./stop
```

Terminal chat (pipeline-identical, recommended for testing without Matrix UI):

```bash
./chat-engineer
./chat-commander
```

## Brain LLM per bot

Each bot has a single brain config section in its profile env:

- `profiles/engineer/env`
- `profiles/commander/env`

Set:

- `BRAIN_MODEL` (required model id)
- `BRAIN_BASE_URL` (optional backend endpoint)
- `BRAIN_AUTH_TOKEN` / `BRAIN_API_KEY` / `BRAIN_OAUTH_TOKEN` as needed

The `start` script maps these to NanoClaw runtime env (`ANTHROPIC_*` / `CLAUDE_CODE_OAUTH_TOKEN`).
This keeps model/backend switching to one place per bot.

## Design

See [`DESIGN.md`](DESIGN.md) for architecture, boundaries, and operating model.

## Notes

- `nanoclaw/` is currently a normal clone on `main` (not submodule yet).
