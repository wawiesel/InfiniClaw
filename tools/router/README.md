# ClaudeCodeRouterLite

Small local Anthropic Messages API shim that lets Claude Code talk to the ChatGPT/Codex subscription backend through your existing `~/.codex/auth.json`.

Copied into InfiniClaw on 2026-03-25 from https://gitea.a-gis.org/wawiesel/ClaudeCodeRouterLite.
Host-shared: one router on 127.0.0.1:43177 for any bot that sets `BRAIN_BASE_URL=http://127.0.0.1:43177`.

Default local port: `43177`. The helper scripts will kill any existing listener on that port before starting.

The scripts intentionally use `ROUTER_HOST` and `ROUTER_PORT`, not plain `HOST`, because `zsh` already sets `HOST` to your machine hostname.

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

- Starts the shared router on `127.0.0.1:43177`
- Loads `ANTHROPIC_BASE_URL` into your shell
- Runs Claude against the local Messages API shim

Configure a bot to use it (secrets repo):
```
BRAIN_BASE_URL=http://127.0.0.1:43177
```
This sets `ANTHROPIC_BASE_URL` inside the bot container and branch brains via existing env mapping.
