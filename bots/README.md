# bots/

Bot personas, roles, skills, and container definitions.

- `CLAUDE.md` — Shared bot instructions: communication, `{{m}}` mention format, reactions via `send_reaction`, IPC, idle work via Gitea issues, 3-deep todo list requirement on startup
- `build.sh` — Container image build script (discovers bots dynamically from Dockerfiles)
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

- **On-duty heartbeat** (`bots/CLAUDE.md`): Chief startup via WBS MCP tools; crew works from assigned todo list.
- **Signals**: All positional — `{{m Name}}`, `{{branch Title — Objective}}`, `{{merge Summary}}`, `{{send roomname}}`.
