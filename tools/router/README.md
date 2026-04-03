# ClaudeCodeRouterLite

Small local Anthropic Messages API shim that lets Claude Code talk to the ChatGPT/Codex subscription backend through your existing `~/.codex/auth.json`.

Copied into InfiniClaw on 2026-03-25 from https://gitea.a-gis.org/wawiesel/ClaudeCodeRouterLite.
Host-shared: one router binds `0.0.0.0:43177`, is reached from the host at `http://127.0.0.1:43177`, and is reached from bot containers at `http://host.containers.internal:43177`.

Default local port: `43177`. The helper scripts will kill any existing listener on that port before starting.

The scripts intentionally use `ROUTER_BIND_HOST`, `ROUTER_CONNECT_HOST`, and `ROUTER_PORT`, not plain `HOST`, because `zsh` already sets `HOST` to your machine hostname.

## Quick start

Start the shared router in the background:

```bash
./router-ctl.sh start
```

Load the adapter environment into your shell:

```bash
source ./claude-codex.env.sh
```

Then run normal Claude commands directly:

```bash
claude
claude --continue
claude --resume
claude --resume <session-id> --fork-session
```

This env file only points Claude at the local router. It does not set `ANTHROPIC_API_KEY`, so you keep the normal Claude Code runtime.

For bot containers, InfiniClaw also injects a placeholder `ANTHROPIC_AUTH_TOKEN=router` when a custom `ANTHROPIC_BASE_URL` is configured without explicit Anthropic auth. Claude CLI requires a non-empty Anthropic auth variable even though the router itself does not use the token value.

Check or stop the shared router:

```bash
./router-ctl.sh status
./router-ctl.sh stop
./router-ctl.sh logs
```

## Interactive use

With the router running:

```bash
source ./claude-codex.env.sh
claude
```

## What this setup does

- Starts the shared router on `0.0.0.0:43177`
- Probes it through `127.0.0.1:43177`
- Loads `ANTHROPIC_BASE_URL` into your shell as `http://127.0.0.1:43177`
- Runs Claude against the local Messages API shim

Configure a bot to use it (secrets repo):
```
BRAIN_BASE_URL=http://host.containers.internal:43177
```
This sets `ANTHROPIC_BASE_URL` inside the bot container and branch brains via existing env mapping.
