# ClaudeCodeRouterLite (host-shared)

Copied from https://gitea.a-gis.org/wawiesel/ClaudeCodeRouterLite (main) on 2026-03-25.

Purpose: Anthropic-compatible router that fronts the ChatGPT/Codex subscription backend. InfiniClaw bots can opt in by setting `BRAIN_BASE_URL=http://127.0.0.1:43177` in their secrets env.

Files here:
- `router.js` — HTTP server shim (Anthropic Messages → Codex backend)
- `router-ctl.sh` — start/stop/status/logs helper (writes state under `~/.local/state/2026-router`)
- `claude-codex.env.sh` — convenience env loader to point CLI at the router
- `README.md` — original quickstart

Run manually on host:
```bash
npm run router:start      # start on 127.0.0.1:43177
npm run router:status
npm run router:logs
npm run router:stop
```

Configure a bot to use it (secrets repo):
```
BRAIN_BASE_URL=http://127.0.0.1:43177
```
Relay/containers will pass this through as `ANTHROPIC_BASE_URL` to the bot process and branch brains.

Auth: expects Codex auth in `~/.codex/auth.json` or `OPENAI_ACCESS_TOKEN`. The router itself does not store secrets in repo; it reads from host paths/env.

Port/host overrides: set `ROUTER_PORT` / `ROUTER_HOST` before running `router-ctl.sh` or the npm scripts.

Health: `curl http://127.0.0.1:43177/health` returns `{ ok: true }` when running.

Notes: This is host-only; do not mount into bot containers. Use shared service model (one router on host, many bots may point at it).
