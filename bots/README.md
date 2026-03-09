# bots/

Bot personas, roles, skills, and container definitions.

- `CLAUDE.md` — Shared bot instructions (writable by bots)
- `build.sh` — Container image build script (`./bots/build.sh all` or `./bots/build.sh <bot>`)
- `container/agent-runner/` — In-container agent code (COPY'd into images at build time)
- `{role}/` — One directory per role (normie, navigator, engineer, architect)
- `skills/` — Shared skill pool (see `skills/README.md`)

## Role directories

Each role directory contains shared config and per-bot personas:

- `ROOM.md` — Room context (read-only in containers)
- `skills.json` — Skills assigned to this role
- `mcp.json` — MCP servers for this role
- `{bot}/CLAUDE.md` — Bot identity and rules (writable by bot)
- `{bot}/Dockerfile` — Container image definition
- `{bot}/container-config.json` — Extra mounts and container settings

Bots are assigned to roles via `fleet.json` in the secrets repo.

## CLAUDE.md layers

1. **Base** (`bots/CLAUDE.md`) — shared bot instructions, fleet architecture
2. **Persona** (`bots/{role}/{bot}/CLAUDE.md`) — identity and rules, writable by bot
3. **Room** (`bots/{role}/ROOM.md`) — room context, read-only

## Memory

Bot memory lives in the secrets repo (`~/.config/infiniclaw/secrets/bots/{bot}/memory/`), mounted writable at `/workspace/persona/memory/`.
