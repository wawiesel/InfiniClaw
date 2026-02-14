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

- Banner image path is `assets/infiniclaw-banner.png`.
- Place the provided InfiniClaw artwork at that path.
- `nanoclaw/` is currently a normal clone on `main` (not submodule yet).
