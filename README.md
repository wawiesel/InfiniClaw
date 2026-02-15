<p align="center">
  <img src="assets/infiniclaw-banner.png" alt="InfiniClaw" width="1200">
</p>

# InfiniClaw

Multi-bot orchestration built on a maintained NanoClaw fork.

## Current bot names

- `cid-bot` (infra/operator role)
- `johnny5-bot` (worker role)

For public deployment guidance, we plan to document renaming to:
- `engineer-bot`
- `assistant-bot`

## Quick start

```bash
./scripts/setup.sh
```

Create per-bot env files (copied from examples by setup):

```text
profiles/cid-bot/env
profiles/johnny5-bot/env
```

Start bots:

```bash
./scripts/start-all.sh
```

## Brain LLM per bot

Each bot has a single brain config section in its profile env:

- `profiles/cid-bot/env`
- `profiles/johnny5-bot/env`

Set:

- `BRAIN_MODEL` (required model id)
- `BRAIN_BASE_URL` (optional backend endpoint)
- `BRAIN_AUTH_TOKEN` / `BRAIN_API_KEY` / `BRAIN_OAUTH_TOKEN` as needed

`scripts/start-bot.sh` maps these to NanoClaw runtime env (`ANTHROPIC_*` / `CLAUDE_CODE_OAUTH_TOKEN`).
This keeps model/backend switching to one place per bot.

Show status:

```bash
./scripts/status.sh
```

Stop bots:

```bash
./scripts/stop-all.sh
```

Run in tmux:

```bash
./scripts/tmux.sh
```

## Design

See [`DESIGN.md`](DESIGN.md) for architecture, boundaries, and operating model.

## Notes

- `nanoclaw/` is currently a normal clone on `main` (not submodule yet).
